import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../app'
import type { Env } from '../config/env'
import { rateLimit } from '../middleware/rateLimit'

/**
 * Dashboard-local Hono context shape。`AppBindings.Variables` の `requestId` に
 * 加え、kill-switch banner state を `use('*')` middleware で初頭 load して
 * 全 route から参照可能にする (#276)。
 */
type DashboardBindings = AppBindings & {
  Variables: AppBindings['Variables'] & {
    killSwitchState: KillSwitchBannerState | null
  }
}
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadOverviewPanelsCsv, setOverviewPanels } from '../infrastructure/db/globalConfigRepo'
import { resolveTradingEnabled } from '../trading/runtime/killSwitch'
import { loadSymbolUniverse, type SymbolUniverse } from '../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../infrastructure/db/symbolConfigRepo'
import { loadInversePairs } from '../infrastructure/db/symbolConfigRepo'
import { escapeHtml, formatSymbolDisplay } from '../shared/format'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import {
  MAX_TIME_STOP_DAYS,
  strategyDecisionLog,
  symbolConfig,
  tradeJournal,
  type SymbolConfigRow,
} from '../infrastructure/db/schema'
import {
  loadRecentAudit,
  type ConfigAuditRow,
  type LoadAuditOptions,
} from '../infrastructure/db/configAuditLog'
import {
  loadRecentAlerts,
  type AlertRow,
  type LoadAlertOptions,
} from '../infrastructure/notification/notificationEmitLog'
import type { NotificationSeverity, NotificationEvent } from '../infrastructure/notification/Notifier'
import { loadVixRegimeSnapshot } from '../infrastructure/notification/vixRegimeChange'
import {
  loadPortfolioEquitySnapshots,
  type LoadPortfolioEquitySnapshotOptions,
} from '../infrastructure/db/portfolioEquitySnapshotRepo'
import type { PortfolioEquitySnapshotRow } from '../infrastructure/db/schema'
import type { VixRegime } from '../trading/risk/vixRegimeFilter'
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import type { SymbolState } from '../trading/state/types'
import { YahooBarClient } from '../infrastructure/quotes/YahooBarClient'
// #293 calendar events management UI (earnings + macro)。dashboard 側に form
// 受け handler を置くのは admin/seed が JSON 専用で `application/x-www-form-urlencoded`
// を受けない (= HTML form から直接 POST できない) ため。バリデーション失敗時に
// 入力値を保持したまま再描画する必要があり、PRG redirect だと echo が崩れる。
// repo 呼び出し + rate-limit + writeAuditLog は admin route と同じ部品を再利用。
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
  type EarningsCalendarSeedInput,
} from '../infrastructure/calendar/earningsCalendarRepo'
import {
  createMacroEventCalendarDb,
  createMacroEventCalendarRepo,
  type MacroEventCalendarSeedInput,
} from '../infrastructure/calendar/macroEventCalendarRepo'
import { earningsCalendar, macroEventCalendar } from '../infrastructure/db/schema'
import type { EarningsCalendarRow, MacroEventCalendarRow } from '../infrastructure/db/schema'
import { extractActor, recordChange } from '../infrastructure/db/configAuditLog'
// #21 Phase B follow-up: Webull token 管理 UI (seed / status / refresh)。
// admin/webull-token は JSON API、こちらは HTML form + redirect で operator が
// browser から完結できるようにする (DevTools fetch を強要しない)。
import { refreshWebullToken } from '../infrastructure/webull/refreshWebullToken'
import { WebullAuth } from '../infrastructure/webull/WebullAuth'
import { WebullTokenClient } from '../infrastructure/webull/WebullTokenClient'
import { WebullTokenStateClient } from '../trading/state/WebullTokenStateClient'
import type { WebullTokenState } from '../trading/state/WebullTokenStateDO'

/**
 * Read-only operator dashboard (#121). Server-rendered HTML via Hono — no
 * client JS, no build step. Protected by the same basic-auth middleware as
 * /admin. Every page renders defensively: if a binding (D1 / DO) is missing
 * we surface "unavailable" rather than 500, so a partially-configured env
 * still yields a usable landing.
 */
interface KillSwitchBannerState {
  dbEnabled: boolean
  effective: boolean
  envOverrideActive: boolean
}

async function loadKillSwitchState(env: Env): Promise<KillSwitchBannerState | null> {
  if (!env.DB) return null
  try {
    const global = await loadGlobalConfigFrom(env)
    const effective = resolveTradingEnabled(global.tradingEnabled, env.TRADING_ENABLED)
    return {
      dbEnabled: global.tradingEnabled,
      effective,
      envOverrideActive: effective !== global.tradingEnabled,
    }
  } catch {
    return null
  }
}

export const dashboard = new Hono<DashboardBindings>()
  .use('*', rateLimit('DASHBOARD'))
  .use('*', async (c, next) => {
    const state = await loadKillSwitchState(c.env)
    c.set('killSwitchState', state)
    await next()
  })
  .get('/', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'ダッシュボード', unavailable('DB not bound')))
    }
    try {
      const db = createDb(c.env.DB)
      const universe = await loadSymbolUniverse(c.env)
      const allDisplaySymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
      const symbolClient = c.env.SYMBOL_STATE ? new SymbolStateClient(c.env.SYMBOL_STATE) : null
      const range = parseEquityRange(c.req.query('range'))
      const [panelsCsv, portfolio, snapshots, positions, strategyPriceMap, recentTrades, vixRegime, global] =
        await Promise.all([
          loadOverviewPanelsCsv(db),
          c.env.PORTFOLIO_STATE
            ? new PortfolioStateClient(c.env.PORTFOLIO_STATE).getPortfolio().catch(() => null)
            : Promise.resolve(null),
          safeLoadPortfolioSnapshots(c.env.DB, range),
          symbolClient
            ? Promise.all(
                allDisplaySymbols.map(async (sym) => {
                  try {
                    return { sym, state: await symbolClient.getState(sym), error: null as string | null }
                  } catch (err) {
                    return { sym, state: null as SymbolState | null, error: messageOf(err) }
                  }
                }),
              )
            : Promise.resolve([] as Array<{ sym: string; state: SymbolState | null; error: string | null }>),
          loadLatestStrategyPrices(c.env.DB, allDisplaySymbols),
          loadRecentFills(c.env.DB, 8),
          c.env.DB
            ? loadVixRegimeSnapshot(c.env.DB, c.get('requestId')).catch(() => null)
            : Promise.resolve(null),
          loadGlobalConfigFrom(c.env, c.get('requestId')),
        ])
      const data: OverviewData = {
        panels: parseOverviewPanels(panelsCsv),
        portfolio,
        snapshots,
        range,
        positions,
        strategyPriceMap,
        recentTrades,
        vixRegime,
        dryRun: global.dryRun,
        // env TRADING_ENABLED の deploy-gate を反映した effective 値 (CodeRabbit #397:
        // 上部バナーと同じ resolveTradingEnabled を通し、生 DB 値との食い違いを防ぐ)。
        tradingEnabled: resolveTradingEnabled(global.tradingEnabled, c.env.TRADING_ENABLED),
        universe,
      }
      return c.html(renderLayout(c, 'ダッシュボード', overviewBody(data)))
    } catch (err) {
      return c.html(renderLayout(c, 'ダッシュボード', unavailable(messageOf(err))))
    }
  })
  .get('/positions', async (c) => {
    if (!c.env.DB || !c.env.SYMBOL_STATE) {
      return c.html(renderLayout(c, 'ポートフォリオ', unavailable('DB or SYMBOL_STATE not bound')))
    }
    const universe = await loadSymbolUniverse(c.env)
    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    // inactive 銘柄も表示する (operator visibility) — chart に飛んで状態を確認したり
    // 再有効化判断したりするのに必要。cron / risk gate は引き続き allowedSymbols のみ評価。
    const allDisplaySymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
    const [rows, strategyPriceMap] = await Promise.all([
      Promise.all(
        allDisplaySymbols.map(async (sym) => {
          try {
            return { sym, state: await client.getState(sym), error: null as string | null }
          } catch (err) {
            return { sym, state: null as SymbolState | null, error: messageOf(err) }
          }
        }),
      ),
      loadLatestStrategyPrices(c.env.DB, allDisplaySymbols),
    ])
    return c.html(renderLayout(c, 'ポートフォリオ', positionsBody(rows, strategyPriceMap, universe)))
  })
  .get('/portfolio', async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      return c.html(renderLayout(c, '口座サマリ', unavailable('PORTFOLIO_STATE not bound')))
    }
    try {
      const portfolio = await new PortfolioStateClient(c.env.PORTFOLIO_STATE).getPortfolio()
      // VIX regime (issue #196 3/3) を D1 snapshot から読む。table 未 migration /
      // bind 不在は null fallback (= 未知扱い、ページ自体は表示)。
      const vixRegime = c.env.DB
        ? await loadVixRegimeSnapshot(c.env.DB, c.get('requestId'))
        : null
      const range = parseEquityRange(c.req.query('range'))
      // 総資産時系列 (roll-daily 経由で 1 row / 日)。DB 不在 / load 失敗時は
      // 空配列で fallback → チャート枠は出さず "データ無し" メッセージにする。
      const snapshots: PortfolioEquitySnapshotRow[] = c.env.DB
        ? await safeLoadPortfolioSnapshots(c.env.DB, range)
        : []
      return c.html(
        renderLayout(
          c,
          '口座サマリ',
          portfolioBody(portfolio, vixRegime, { snapshots, range }),
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, '口座サマリ', unavailable(messageOf(err))))
    }
  })
  .get('/trades', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '約定履歴', unavailable('DB not bound')))
    }
    const limit = clampLimit(c.req.query('limit'))
    const db = createDb(c.env.DB)
    // universe を並行 load して銘柄表示を「番号-会社名」(JP) に整形。
    // load 失敗時は `null` を tradesBody に渡し、symbol そのまま表示で fallback。
    const [rows, universe] = await Promise.all([
      db.select().from(tradeJournal).orderBy(desc(tradeJournal.id)).limit(limit),
      loadSymbolUniverse(c.env).catch(() => null),
    ])
    return c.html(renderLayout(c, '約定履歴', tradesBody(rows, limit, universe)))
  })
  .get('/config', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '設定', unavailable('DB not bound')))
    }
    const [global, universe, panelsCsv] = await Promise.all([
      loadGlobalConfigFrom(c.env, c.get('requestId')),
      loadSymbolUniverse(c.env),
      loadOverviewPanelsCsv(createDb(c.env.DB)),
    ])
    return c.html(
      renderLayout(c, '設定', configBody(global, universe, parseOverviewPanels(panelsCsv))),
    )
  })
  // #dashboard-mf-layout: overview パネル ON/OFF を保存。HTML form (checkbox 複数) →
  // 有効 key を CSV 化して global_config に書き、PRG で /dashboard/config に戻る。
  .post('/config/overview-panels', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '設定', unavailable('DB not bound')))
    }
    const db = createDb(c.env.DB)
    const form = await c.req.formData()
    const selected = form
      .getAll('panels')
      .map(String)
      .filter((s) => (ALL_OVERVIEW_PANELS as readonly string[]).includes(s))
    const csv = Array.from(new Set(selected)).join(',')
    // CodeRabbit #397: global_config への永続変更なので before/after + requestId を
    // 構造化ログに残す (audit 追跡)。display 設定なので config_audit_log table までは使わない。
    // before は setOverviewPanels の batch (= write と同一 transaction) から取得し
    // 同時更新でも監査がズレないようにする。
    const { before } = await setOverviewPanels(db, csv, new Date().toISOString())
    console.log(
      JSON.stringify({
        event: 'overview_panels_updated',
        requestId: c.get('requestId') ?? null,
        actor: extractActor(c.get('actor')),
        before,
        after: csv,
      }),
    )
    return c.redirect('/dashboard/config', 303)
  })
  .get('/charts', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'チャート', unavailable('DB not bound')))
    }
    try {
      const tab = parseChartsTab(c.req.query('tab'))
      // 各 tab で必要な D1 query だけ走らせる軽量化:
      // - overview: equity (drawdown は equity から派生)
      // - quality:  pnls (= stats / histogram) + decisions
      // - symbol:   universe + symbolChart
      if (tab === 'overview') {
        const equity = await loadEquityCurve(c.env.DB)
        return c.html(renderLayout(c, 'チャート', chartsBody({ tab, equity })))
      }
      if (tab === 'quality') {
        const [decisions, pnls] = await Promise.all([
          loadDecisionBreakdown(c.env.DB),
          loadTradePnls(c.env.DB),
        ])
        return c.html(
          renderLayout(
            c,
            'チャート',
            chartsBody({
              tab,
              decisions,
              pnls,
              stats: computeTradeStats(pnls),
              histogram: computePnlHistogram(pnls),
            }),
          ),
        )
      }
      // ?from / ?to (ISO UTC) で chart x-axis のズーム範囲を URL に持つ。
      // grid / symbol 共通: tab 切替・銘柄切替を跨いで zoom range を維持。
      const zoomFrom = parseIsoTimestamp(c.req.query('from'))
      const zoomTo = parseIsoTimestamp(c.req.query('to'))
      if (tab === 'grid') {
        const [universe, global] = await Promise.all([
          loadSymbolUniverse(c.env),
          loadGlobalConfigFrom(c.env, c.get('requestId')),
        ])
        const rules: SymbolChartRules = {
          pullbackMax: global.pullbackDefaultPullbackMax,
          pullbackMin: global.pullbackDefaultPullbackMin,
          stopPct: global.pullbackDefaultStopPct,
          takeProfitPct: global.pullbackDefaultTakeProfitPct,
          timeStopDays: global.pullbackDefaultTimeStopDays,
        }
        // active + inactive 双方の chart を load する。inactive 銘柄もチャートで
        // 動向確認したい (PR #229 で grid から外したが operator から復帰要望)。
        // `loadAllSymbolCharts` は per-symbol catch (PR #197) で 1 銘柄が失敗
        // しても他は OK。Workers subrequest budget を超えた場合も該当 panel が
        // 個別 error 表示になるだけで grid 全体は描画される。視覚識別 (INACTIVE
        // バッジ + grayed style) は `renderGridTab` 側で symbol 単位に付与する。
        const allGridSymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
        const charts = await loadAllSymbolCharts(c.env, allGridSymbols, rules)
        // grid の zoom 基準: 全 panel 共通の dataZoom 同期があるため、最初に
        // load 成功した chart の lastTimestamp を基準に直近 7 日 (default) を
        // 採用する。URL ?from / ?to があればそれを優先 (既存と同挙動)。
        const referenceChart = charts.find((c) => c.chart !== null)?.chart ?? null
        const zoom = computeZoomRange(zoomFrom, zoomTo, referenceChart)
        return c.html(
          renderLayout(
            c,
            'チャート',
            chartsBody({
              tab,
              charts,
              zoom,
              universe,
            }),
          ),
        )
      }
      // tab === 'symbol'
      const symbolParam = c.req.query('symbol')?.toUpperCase().trim() || undefined
      const [universe, global] = await Promise.all([
        loadSymbolUniverse(c.env),
        loadGlobalConfigFrom(c.env, c.get('requestId')),
      ])
      // 表示候補: active + inactive 銘柄。focusSymbol は inactive でも valid と扱う
      // (operator が chart で inactivate 後の動向を確認できるよう)。default は active を優先。
      const allDisplaySymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
      const allDisplaySet = new Set(allDisplaySymbols)
      const allowed = new Set(universe.allowedSymbols)
      const defaultSymbol = await pickDefaultSymbol(c.env.DB)
      const focusSymbol =
        symbolParam && allDisplaySet.has(symbolParam)
          ? symbolParam
          : defaultSymbol && allowed.has(defaultSymbol)
            ? defaultSymbol
            : universe.allowedSymbols[0] ?? universe.inactiveSymbols[0] ?? null
      // ルール閾値は global_config から。per-symbol override は POC で未対応
      // (symbol_rules table が無い、env-var 経由なので動的反映困難)。
      const strategyParams: StrategyParamsSnapshot = {
        stopPct: global.pullbackDefaultStopPct,
        takeProfitPct: global.pullbackDefaultTakeProfitPct,
        timeStopDays: global.pullbackDefaultTimeStopDays,
        pullbackMax: global.pullbackDefaultPullbackMax,
        pullbackMin: global.pullbackDefaultPullbackMin,
        minReturn50d: global.pullbackDefaultMinReturn50d,
        requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
        kAtr: global.pullbackDefaultKAtr,
      }
      const rules: SymbolChartRules = {
        pullbackMax: strategyParams.pullbackMax,
        pullbackMin: strategyParams.pullbackMin,
        stopPct: strategyParams.stopPct,
        takeProfitPct: strategyParams.takeProfitPct,
        timeStopDays: strategyParams.timeStopDays,
      }
      // SymbolStateDO の position が ground truth (avgPrice / openedAt が
      // partial fill / position add も反映済)。trade_journal からの derive は
      // 直近 BUY 単体しか拾えないので fallback 専用。
      const symbolChart = focusSymbol
        ? await loadSymbolChart(c.env, focusSymbol, rules)
        : null
      // zoom range: ?from / ?to が valid (from < to) ならそれを使う、なければ
      // chart の最終 point から逆算で「直近 7 日」をデフォルト。理由:
      // - 60 日全体表示は trend / pin / SMA50 が見えづらい (#15 で指摘)
      // - 7 日は cron / 押し目 / 直近 fill 確認に最適な daily-trader の窓
      // - lastTimestamp 基準なので休場や POC 開始直後でも broken にならない
      const zoom = computeZoomRange(zoomFrom, zoomTo, symbolChart)
      return c.html(
        renderLayout(
          c,
          'チャート',
          chartsBody({
            tab,
            focusSymbol,
            symbolChart,
            availableSymbols: allDisplaySymbols,
            strategyParams,
            zoom,
            universe,
          }),
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, 'チャート', unavailable(messageOf(err))))
    }
  })
  .get('/cron/json', async (c) => {
    if (!c.env.DB) {
      return jsonPretty({ error: 'db_not_bound', message: 'DB binding is not configured' }, 503)
    }
    const db = createDb(c.env.DB)
    const requestedRequestId = c.req.query('requestId')?.trim()
    const requestedDecisionId = c.req.query('decisionId')?.trim()
    try {
      let decisionId: number | undefined
      if (requestedDecisionId && requestedDecisionId.length > 0) {
        if (!/^[1-9]\d*$/.test(requestedDecisionId)) {
          return jsonPretty({ error: 'invalid_decision_id', message: 'decisionId must be a positive integer' }, 400)
        }
        decisionId = Number(requestedDecisionId)
        if (!Number.isSafeInteger(decisionId) || decisionId <= 0) {
          return jsonPretty({ error: 'invalid_decision_id', message: 'decisionId must be a positive integer' }, 400)
        }
      }
      let requestId = requestedRequestId && requestedRequestId.length > 0
        ? requestedRequestId
        : undefined
      if (!requestId && decisionId === undefined) {
        const latest = await db
          .select({ requestId: strategyDecisionLog.requestId })
          .from(strategyDecisionLog)
          .orderBy(desc(strategyDecisionLog.id))
          .limit(50)
        requestId = latest.find((row) => row.requestId !== null)?.requestId ?? undefined
      }
      if (!requestId && decisionId === undefined) {
        return jsonPretty({ error: 'no_cron_logs', message: 'strategy_decision_log has no request_id rows' }, 404)
      }

      const filter = decisionId !== undefined
        ? eq(strategyDecisionLog.id, decisionId)
        : eq(strategyDecisionLog.requestId, requestId as string)
      const rows = await db
        .select({
          id: strategyDecisionLog.id,
          timestamp: strategyDecisionLog.timestamp,
          requestId: strategyDecisionLog.requestId,
          symbol: strategyDecisionLog.symbol,
          decision: strategyDecisionLog.decision,
          reason: strategyDecisionLog.reason,
          price: strategyDecisionLog.price,
          indicatorsJson: strategyDecisionLog.indicatorsJson,
          clientOrderId: strategyDecisionLog.clientOrderId,
          filledPrice: tradeJournal.filledPrice,
          filledQty: tradeJournal.filledQty,
          realizedPnl: tradeJournal.realizedPnl,
          brokerStatus: tradeJournal.brokerStatus,
        })
        .from(strategyDecisionLog)
        .leftJoin(
          tradeJournal,
          and(
            eq(strategyDecisionLog.clientOrderId, tradeJournal.clientOrderId),
            eq(tradeJournal.tradeEventType, 'post_submit'),
          ),
        )
        .where(filter)
        .orderBy(asc(strategyDecisionLog.id))

      return jsonPretty({
        schema: 'dashboard_cron_export.v1',
        exportedAt: new Date().toISOString(),
        ...(decisionId !== undefined ? { decisionId } : { requestId }),
        rowCount: rows.length,
        decisions: rows.map(cronDecisionJson),
      })
    } catch (err) {
      return jsonPretty({ error: 'cron_json_export_failed', message: messageOf(err) }, 500)
    }
  })
  .get('/cron', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '戦略判定', unavailable('DB not bound')))
    }
    const limit = clampLimit(c.req.query('limit'))
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    const db = createDb(c.env.DB)
    try {
      // trade_journal の post_submit と LEFT JOIN して realized_pnl を引く
      // (#143)。client_order_id が JOIN key — BUY/SELL 成立時のみ strategy
      // 側に記録されているので HOLD/REJECT 行は realized_pnl が NULL に
      // 落ちる (意図通り)。
      const baseQuery = db
        .select({
          id: strategyDecisionLog.id,
          timestamp: strategyDecisionLog.timestamp,
          requestId: strategyDecisionLog.requestId,
          symbol: strategyDecisionLog.symbol,
          decision: strategyDecisionLog.decision,
          reason: strategyDecisionLog.reason,
          price: strategyDecisionLog.price,
          indicatorsJson: strategyDecisionLog.indicatorsJson,
          clientOrderId: strategyDecisionLog.clientOrderId,
          filledPrice: tradeJournal.filledPrice,
          filledQty: tradeJournal.filledQty,
          realizedPnl: tradeJournal.realizedPnl,
          brokerStatus: tradeJournal.brokerStatus,
        })
        .from(strategyDecisionLog)
        .leftJoin(
          tradeJournal,
          and(
            eq(strategyDecisionLog.clientOrderId, tradeJournal.clientOrderId),
            eq(tradeJournal.tradeEventType, 'post_submit'),
          ),
        )
      const [rows, universe] = await Promise.all([
        symbolFilter
          ? baseQuery
              .where(eq(strategyDecisionLog.symbol, symbolFilter))
              .orderBy(desc(strategyDecisionLog.id))
              .limit(limit)
          : baseQuery
              .orderBy(desc(strategyDecisionLog.id))
              .limit(limit),
        loadSymbolUniverse(c.env).catch(() => null),
      ])
      return c.html(renderLayout(c, '戦略判定', cronBody(rows, limit, symbolFilter, universe)))
    } catch (err) {
      // migration 未適用 / 一時的な D1 エラーで 500 にせず unavailable に落とす
      // (CodeRabbit #132)。段階的デプロイ時の自己保護。
      return c.html(renderLayout(c, '戦略判定', unavailable(messageOf(err))))
    }
  })
  /**
   * Broker probe UI: 同一 origin の `/admin/broker/probe` を browser の fetch で
   * 呼び、生 JSON を整形表示する小さい form ページ。/dashboard/* と /admin/* は
   * 同じ Cloudflare Access policy で保護されてるので、ブラウザに残ってる Access
   * cookie がそのまま流用される (再 prompt なし)。サーバー側は probe を
   * proxy せず、純粋にフォーム + 表示器を返すだけ (= 認証ヘッダの転送ロジック
   * 不要、責務分離)。
   */
  .get('/broker-probe', async (c) => {
    const symbol = (c.req.query('symbol') ?? 'AAPL').trim().toUpperCase() || 'AAPL'
    const category = (c.req.query('category') ?? 'US_STOCK').trim().toUpperCase() || 'US_STOCK'
    // symbol_config 全銘柄 (active + inactive) をリンク候補として渡す。DB が未
    // 設定 / load 失敗時は null fallback で UI は保有銘柄 + AAPL control のみ。
    const universe = c.env.DB
      ? await loadSymbolUniverse(c.env).catch(() => null)
      : null
    return c.html(
      renderLayout(c, 'Broker 診断', brokerProbeBody({ symbol, category, universe })),
    )
  })
  .get('/alerts', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'アラート', unavailable('DB not bound')))
    }
    const limit = clampAlertLimit(c.req.query('limit'))
    const severityFilter = parseSeverityFilter(c.req.query('severity'))
    const eventTypeFilter = parseEventTypeFilter(c.req.query('eventType'))
    const currentQuery = parseAlertsQuery(c.req.url)
    const options: LoadAlertOptions = { limit }
    if (eventTypeFilter) {
      options.eventType = eventTypeFilter
    }
    if (severityFilter.length > 0) {
      options.severities = severityFilter
    }
    try {
      const [rows, universe] = await Promise.all([
        loadRecentAlerts(c.env.DB, options),
        loadSymbolUniverse(c.env).catch(() => null),
      ])
      return c.html(
        renderLayout(
          c,
          'アラート',
          alertsBody({ rows, limit, severityFilter, eventTypeFilter, currentQuery, universe }),
        ),
      )
    } catch (err) {
      // 0012 migration 未適用 (= notification_emit_log テーブル無し) を
      // 500 にせず unavailable に落とす。段階的デプロイ時の自己保護。
      return c.html(renderLayout(c, 'アラート', unavailable(messageOf(err))))
    }
  })
  .get('/audit', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '監査ログ', unavailable('DB not bound')))
    }
    const limit = clampAuditLimit(c.req.query('limit'))
    const actorFilter = trimQuery(c.req.query('actor'))
    const endpointFilter = trimQuery(c.req.query('endpoint'))
    const fromFilter = parseAuditDateFilter(c.req.query('from'), false)
    const toFilter = parseAuditDateFilter(c.req.query('to'), true)
    const options: LoadAuditOptions = { limit }
    if (actorFilter) options.actor = actorFilter
    if (endpointFilter) options.endpoint = endpointFilter
    if (fromFilter) options.fromIso = fromFilter
    if (toFilter) options.toIso = toFilter
    try {
      const rows = await loadRecentAudit(c.env.DB, options)
      return c.html(
        renderLayout(
          c,
          '監査ログ',
          auditBody({
            rows,
            limit,
            actorFilter,
            endpointFilter,
            fromFilter: c.req.query('from') ?? '',
            toFilter: c.req.query('to') ?? '',
          }),
        ),
      )
    } catch (err) {
      // 0016 migration 未適用 (= config_audit_log テーブル無し) を 500 にせず
      // unavailable に落とす。段階的デプロイ時の自己保護 (alerts と同パターン)。
      return c.html(renderLayout(c, '監査ログ', unavailable(messageOf(err))))
    }
  })
  /**
   * 銘柄管理 (#292) — symbol_config CRUD UI。
   *
   * list / new / edit の 3 ページのみ render する read 系。POST は
   * `/admin/symbol-config[/...]` に form submit → 303 redirect で戻る (PRG)。
   */
  .get('/symbols', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '銘柄管理', unavailable('DB not bound')))
    }
    try {
      const [rows, inversePairs] = await Promise.all([
        loadAllSymbolConfigRows(c.env.DB),
        loadInversePairs(createDb(c.env.DB)).catch(() => ({}) as Record<string, string>),
      ])
      const errorCode = c.req.query('error') ?? null
      const errorSymbol = c.req.query('symbol') ?? null
      const filter: SymbolsListFilter = {
        status: ((c.req.query('status') ?? 'all') as 'all' | 'active' | 'inactive'),
        market: ((c.req.query('market') ?? 'all') as 'all' | 'US' | 'JP'),
        q: c.req.query('q') ?? '',
      }
      return c.html(
        renderLayout(c, '銘柄管理', symbolsListBody({ rows, inversePairs, errorCode, errorSymbol, filter })),
      )
    } catch (err) {
      return c.html(renderLayout(c, '銘柄管理', unavailable(messageOf(err))))
    }
  })
  .get('/symbols/new', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '銘柄管理 - 新規追加', unavailable('DB not bound')))
    }
    // global default は placeholder 表示 (#316) — operator が「空欄なら何の値が
    // 適用されるか」を一目で把握できるようにする。読込失敗は fallback null で
    // placeholder 無表示にする (form 自体は出す)。
    const globalDefaults = await loadGlobalConfigFrom(c.env, c.get('requestId'))
      .then((g) => ({
        timeStopDays: g.pullbackDefaultTimeStopDays,
        kAtr: g.pullbackDefaultKAtr,
      }))
      .catch(() => null)
    return c.html(
      renderLayout(
        c,
        '銘柄管理 - 新規追加',
        symbolFormBody({ mode: 'new', row: null, error: null, globalDefaults }),
      ),
    )
  })
  .get('/symbols/:symbol/edit', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '銘柄管理 - 編集', unavailable('DB not bound')))
    }
    const symbol = (c.req.param('symbol') ?? '').trim().toUpperCase()
    if (symbol.length === 0) {
      return c.html(renderLayout(c, '銘柄管理 - 編集', unavailable('symbol path param required')))
    }
    try {
      const row = await findSymbolConfigForView(c.env.DB, symbol)
      if (row === null) {
        return c.html(renderLayout(c, '銘柄管理 - 編集', unavailable(`symbol "${symbol}" not found`)))
      }
      const globalDefaults = await loadGlobalConfigFrom(c.env, c.get('requestId'))
        .then((g) => ({
          timeStopDays: g.pullbackDefaultTimeStopDays,
          kAtr: g.pullbackDefaultKAtr,
        }))
        .catch(() => null)
      const inversePairs = await loadInversePairs(createDb(c.env.DB)).catch(
        () => ({}) as Record<string, string>,
      )
      const currentInverse = inversePairs[symbol] ?? null
      return c.html(
        renderLayout(
          c,
          '銘柄管理 - 編集',
          symbolFormBody({ mode: 'edit', row, error: null, globalDefaults, currentInverse }),
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, '銘柄管理 - 編集', unavailable(messageOf(err))))
    }
  })
  /**
   * #293 — earnings + macro event calendar 管理 UI。
   *
   * `earnings_calendar` / `macro_event_calendar` への手動 add / delete を
   * Web UI で行えるようにする。両 calendar とも risk gate のソース
   * (`earningsGate` / `macroEventGate`) なので, operator が dashboard 経由で
   * 直接管理できる必要がある (AI agent 経由の curl だけだと運用効率が悪い)。
   *
   * 範囲は now-30d 〜 now+30d (直近+近未来の "実際に gate が見る窓") を表示。
   * 過去 30 日以前 / 365 日以降は dashboard では出さない (operator の関心外
   * + 一覧の長さを抑える); 必要なら admin GET endpoint で直接読める。
   */
  .get('/events', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
    }
    try {
      const universe = await loadSymbolUniverse(c.env).catch(() => null)
      const { from, to } = eventsDisplayRange(new Date())
      const earningsRepo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
      const macroRepo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
      const [earnings, macros] = await Promise.all([
        loadEarningsInRange(c.env.DB, from, to),
        macroRepo.fetchAll({ fromYmd: from, toYmd: to }),
      ])
      return c.html(
        renderLayout(
          c,
          'イベント',
          eventsBody({
            earnings,
            macros,
            from,
            to,
            universe,
            errors: null,
            formEcho: null,
            notice: null,
          }),
        ),
      )
    } catch (err) {
      // migration 未適用 / 一時的な D1 エラーで 500 にせず unavailable に落とす
      // (他 dashboard page と同じ defensive 姿勢)。
      return c.html(renderLayout(c, 'イベント', unavailable(messageOf(err))))
    }
  })
  /**
   * earnings 1 行 seed form 受け。HTML form は JSON を送らないので
   * `application/x-www-form-urlencoded` を parse → 1 件配列に wrap → 既存
   * repo の `bulkUpsert` を呼ぶ。バリデーション失敗時は再描画 + 入力 echo
   * (PRG redirect だと form の値が失われる)。
   */
  .post('/events/earnings/seed', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
    }
    const form = Object.fromEntries((await c.req.formData()).entries())
    const echo: EventsEarningsFormEcho = {
      symbol: typeof form.symbol === 'string' ? form.symbol : '',
      earningsDate: typeof form.earnings_date === 'string' ? form.earnings_date : '',
      notes: typeof form.notes === 'string' ? form.notes : '',
    }
    const universe = await loadSymbolUniverse(c.env).catch(() => null)
    const validation = validateEarningsForm(echo, universe)
    if (!validation.ok) {
      return await renderEventsWithError(c, {
        section: 'earnings',
        message: validation.error,
        earningsEcho: echo,
        macroEcho: null,
      })
    }
    const record: EarningsCalendarSeedInput = {
      symbol: validation.symbol,
      earningsDate: validation.earningsDate,
      notes: validation.notes,
    }
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    try {
      const result = await repo.bulkUpsert([record])
      if (result.inserted > 0) {
        await writeEventsAuditLog(
          c,
          '/dashboard/events/earnings/seed',
          `symbol=${record.symbol} date=${record.earningsDate}`,
          null,
          { inserted: result.inserted, skipped: result.skipped, records: [record] },
        )
      }
    } catch (err) {
      return await renderEventsWithError(c, {
        section: 'earnings',
        message: `保存に失敗しました: ${messageOf(err)}`,
        earningsEcho: echo,
        macroEcho: null,
      })
    }
    // 保存は成功したが non-blocking warning (universe 外 symbol 等) があれば
    // PRG redirect を捨てて再描画 (= 200) し、警告を operator に見せる。
    if (validation.warning) {
      return await renderEventsWithNotice(c, {
        section: 'earnings',
        message: validation.warning,
      })
    }
    return c.redirect('/dashboard/events', 303)
  })
  /**
   * earnings 1 行 delete form 受け。HTML form は DELETE method を送れないので
   * POST を companion endpoint として用意 (admin の DELETE と独立に, dashboard
   * 内で完結させる)。rate-limit + audit log は admin と同等に適用。
   */
  .post('/events/earnings/:id/delete', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
    }
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return await renderEventsWithError(c, {
        section: 'earnings',
        message: 'invalid id',
        earningsEcho: null,
        macroEcho: null,
      })
    }
    const repo = createEarningsCalendarRepo(createEarningsCalendarDb(c.env.DB))
    const beforeRow = await createDb(c.env.DB)
      .select()
      .from(earningsCalendar)
      .where(eq(earningsCalendar.id, id))
      .then((rows) => rows[0] ?? null)
      .catch(() => null)
    const ok = await repo.deleteById(id).catch(() => false)
    if (!ok) {
      return await renderEventsWithError(c, {
        section: 'earnings',
        message: `id=${id} は見つかりませんでした`,
        earningsEcho: null,
        macroEcho: null,
      })
    }
    await writeEventsAuditLog(
      c,
      '/dashboard/events/earnings/:id/delete',
      `earnings_id=${id}`,
      beforeRow,
      null,
    )
    return c.redirect('/dashboard/events', 303)
  })
  /** macro 1 行 seed form 受け。挙動は earnings と対称。 */
  .post('/events/macro/seed', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
    }
    const form = Object.fromEntries((await c.req.formData()).entries())
    const echo: EventsMacroFormEcho = {
      eventType: typeof form.event_type === 'string' ? form.event_type : '',
      country: typeof form.country === 'string' ? form.country : '',
      eventDate: typeof form.event_date === 'string' ? form.event_date : '',
      notes: typeof form.notes === 'string' ? form.notes : '',
    }
    const validation = validateMacroForm(echo)
    if (!validation.ok) {
      return await renderEventsWithError(c, {
        section: 'macro',
        message: validation.error,
        earningsEcho: null,
        macroEcho: echo,
      })
    }
    const record: MacroEventCalendarSeedInput = {
      eventType: validation.eventType,
      eventDate: validation.eventDate,
      eventTime: null,
      notes: validation.notes,
    }
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    try {
      const result = await repo.bulkUpsert([record])
      if (result.inserted > 0) {
        await writeEventsAuditLog(
          c,
          '/dashboard/events/macro/seed',
          `event_type=${record.eventType} date=${record.eventDate}`,
          null,
          { inserted: result.inserted, skipped: result.skipped, records: [record] },
        )
      }
    } catch (err) {
      return await renderEventsWithError(c, {
        section: 'macro',
        message: `保存に失敗しました: ${messageOf(err)}`,
        earningsEcho: null,
        macroEcho: echo,
      })
    }
    return c.redirect('/dashboard/events', 303)
  })
  /** macro 1 行 delete form 受け。 */
  .post('/events/macro/:id/delete', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
    }
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return await renderEventsWithError(c, {
        section: 'macro',
        message: 'invalid id',
        earningsEcho: null,
        macroEcho: null,
      })
    }
    const repo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
    const beforeRow = await createDb(c.env.DB)
      .select()
      .from(macroEventCalendar)
      .where(eq(macroEventCalendar.id, id))
      .then((rows) => rows[0] ?? null)
      .catch(() => null)
    const ok = await repo.deleteById(id).catch(() => false)
    if (!ok) {
      return await renderEventsWithError(c, {
        section: 'macro',
        message: `id=${id} は見つかりませんでした`,
        earningsEcho: null,
        macroEcho: null,
      })
    }
    await writeEventsAuditLog(
      c,
      '/dashboard/events/macro/:id/delete',
      `macro_event_id=${id}`,
      beforeRow,
      null,
    )
    return c.redirect('/dashboard/events', 303)
  })
  /**
   * #21 Phase B follow-up: Webull `x-access-token` 管理 UI。
   *
   * - GET                    : 現状表示 (status / expires / tokenHint / 各タイムスタンプ) + seed form + refresh button
   * - POST /seed             : form の token 文字列を broker で再 verify (`checkToken`) してから DO 書込
   * - POST /refresh          : `refreshWebullToken(env, {force:true})` を叩いて DO を更新
   *
   * いずれも token plaintext は HTML に乗せない (head/tail だけの tokenHint)。
   * Cache-Control: no-store 付与で browser / 中間 cache を防ぐ。
   * writeAuditLog 経由で D1 に "誰がいつ" の trail を残す (CodeRabbit #326 同等)。
   */
  .get('/webull-token', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!c.env.WEBULL_TOKEN_STATE) {
      return c.html(renderLayout(c, 'Webull token', unavailable('WEBULL_TOKEN_STATE binding is not configured')))
    }
    const store = new WebullTokenStateClient(c.env.WEBULL_TOKEN_STATE)
    // DO read 失敗を「DO 空」と区別する (CodeRabbit #327)。前者は障害、後者は
    // 初期状態。混同すると operator が「seed されてないだけ」と誤判断して
    // 不要な seed 操作を試みる事故が起きる。
    let state: WebullTokenState | null = null
    let stateError: string | null = null
    try {
      state = await store.getState()
    } catch (err) {
      stateError = messageOf(err)
    }
    if (stateError) {
      return c.html(
        renderLayout(c, 'Webull token', unavailable(`WEBULL_TOKEN_STATE read failed: ${stateError}`)),
      )
    }
    const notice = c.req.query('notice') ?? null
    const error = c.req.query('error') ?? null
    return c.html(
      renderLayout(c, 'Webull token', renderWebullTokenBody({ state, notice, error })),
    )
  })
  .post('/webull-token/seed', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.WEBULL_TOKEN_STATE) {
      return c.redirect('/dashboard/webull-token?error=WEBULL_TOKEN_STATE+binding+is+not+configured', 303)
    }
    if (!c.env.WEBULL_APP_KEY || !c.env.WEBULL_APP_SECRET) {
      return c.redirect('/dashboard/webull-token?error=WEBULL_APP_KEY+%2F+WEBULL_APP_SECRET+missing', 303)
    }
    const form = await c.req.formData()
    const rawPaste = (form.get('token')?.toString() ?? '').trim()
    if (rawPaste.length === 0) {
      return c.redirect('/dashboard/webull-token?error=token+is+required', 303)
    }
    // issue-token script の出力丸ごと貼り付けても OK にする。stderr の
    // diagnostic ("[issue-token] ...") や wrangler suggest 行 ("pnpm wrangler
    // ...") を strip、残った 1 行が NORMAL token。複数行残ったら曖昧として
    // error にする (operator に何を貼ったか判別させる)。
    const extraction = extractTokenFromPaste(rawPaste)
    if (!extraction.ok) {
      return c.redirect(
        `/dashboard/webull-token?error=${encodeURIComponent(extraction.error)}`,
        303,
      )
    }
    const rawToken = extraction.token
    const tokenClient = new WebullTokenClient({
      auth: new WebullAuth({
        appKey: c.env.WEBULL_APP_KEY,
        appSecret: c.env.WEBULL_APP_SECRET,
      }),
      baseUrl: c.env.WEBULL_TRADE_API_BASE?.trim() || 'https://api.webull.co.jp',
    })
    // operator 貼り付け値が NORMAL かを broker で再確認。期限切れ / PENDING を
    // DO に保存させないため (TOC-TOU 防御、admin endpoint と同じ理由)。
    let dto: Awaited<ReturnType<typeof tokenClient.checkToken>>
    try {
      dto = await tokenClient.checkToken(rawToken)
    } catch (err) {
      return c.redirect(`/dashboard/webull-token?error=${encodeURIComponent(`checkToken failed: ${messageOf(err)}`)}`, 303)
    }
    if (dto.status !== 'NORMAL') {
      return c.redirect(
        `/dashboard/webull-token?error=${encodeURIComponent(`token status is ${dto.status}, only NORMAL can be seeded`)}`,
        303,
      )
    }
    const store = new WebullTokenStateClient(c.env.WEBULL_TOKEN_STATE)
    // store.seedToken が throw した場合に 500 で落とさず `?error=` で UI に
    // 戻す (CodeRabbit #327)。getState 失敗は audit log の before が null に
    // なるだけなので無害、引き続き catch で抑制。
    try {
      const before = await store.getState().catch(() => null)
      const seeded = await store.seedToken({
        token: dto.token,
        expires: dto.expires,
        status: dto.status,
      })
      await writeEventsAuditLog(
        c,
        '/dashboard/webull-token/seed',
        'webull-token=singleton',
        before
          ? { status: before.status, expires: before.expires, fetchedAt: before.fetchedAt }
          : null,
        { status: seeded.status, expires: seeded.expires, fetchedAt: seeded.fetchedAt },
      )
      return c.redirect('/dashboard/webull-token?notice=seeded', 303)
    } catch (err) {
      return c.redirect(
        `/dashboard/webull-token?error=${encodeURIComponent(`seed failed: ${messageOf(err)}`)}`,
        303,
      )
    }
  })
  .post('/webull-token/refresh', rateLimit('ADMIN_WRITE'), async (c) => {
    if (!c.env.WEBULL_TOKEN_STATE) {
      return c.redirect('/dashboard/webull-token?error=WEBULL_TOKEN_STATE+binding+is+not+configured', 303)
    }
    // refreshWebullToken 自体は throw しない (内部で catch して failureReason に
    // 詰める) 設計だが、念のため try で囲み、失敗系は ?error= に乗せる
    // (CodeRabbit #327: failureReason ありを notice 緑バナーに混ぜない)。
    let summary: Awaited<ReturnType<typeof refreshWebullToken>>
    try {
      summary = await refreshWebullToken(c.env, { force: true })
    } catch (err) {
      return c.redirect(
        `/dashboard/webull-token?error=${encodeURIComponent(`refresh threw: ${messageOf(err)}`)}`,
        303,
      )
    }
    await writeEventsAuditLog(
      c,
      '/dashboard/webull-token/refresh',
      'webull-token=singleton',
      summary.before
        ? { status: summary.before.status, expires: summary.before.expires, fetchedAt: summary.before.fetchedAt }
        : null,
      summary.after
        ? {
            status: summary.after.status,
            expires: summary.after.expires,
            fetchedAt: summary.after.fetchedAt,
            refreshed: summary.refreshed,
            skippedReason: summary.skippedReason ?? null,
            failureReason: summary.failureReason ?? null,
          }
        : { refreshed: summary.refreshed, skippedReason: summary.skippedReason ?? null },
    )
    if (summary.refreshed) {
      return c.redirect('/dashboard/webull-token?notice=refreshed', 303)
    }
    if (summary.failureReason) {
      return c.redirect(
        `/dashboard/webull-token?error=${encodeURIComponent(`refresh failed: ${summary.failureReason}`)}`,
        303,
      )
    }
    // skip は正常系 (期限まで余裕あり等)。緑 notice で OK。
    const why = summary.skippedReason ?? 'no change'
    return c.redirect(`/dashboard/webull-token?notice=${encodeURIComponent(`refresh: ${why}`)}`, 303)
  })

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `pnpm run issue-token` の出力から実 token (NORMAL の stdout 行) を抽出する。
 *
 * operator が terminal の出力丸ごと貼ったケースに耐性をつけるため:
 *   - `[issue-token] ...` 始まりの diagnostic は捨てる
 *   - wrangler instruction (`pnpm wrangler ...`, `(paste the value...)`) は捨てる
 *   - 空行 / whitespace-only は捨てる
 *   - 残った 1 行 = NORMAL token
 *
 * 複数行残った場合は何が token か判別不能として error。operator は不要行を
 * 削って再 submit する。
 *
 * exported for testing。
 */
export function extractTokenFromPaste(raw: string):
  | { ok: true; token: string }
  | { ok: false; error: string } {
  const candidates = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('[issue-token]'))
    .filter((line) => !line.startsWith('pnpm '))
    .filter((line) => !line.startsWith('(paste'))
  if (candidates.length === 0) {
    return {
      ok: false,
      error:
        'token line not found — did the issue-token flow finish with status=NORMAL? (the PENDING summary like "0197...7689" is NOT the actual token)',
    }
  }
  if (candidates.length > 1) {
    // 候補プレビューを URL に含めると token 断片が browser 履歴 / access log に
    // 漏れる (CodeRabbit #328)。件数のみ返して、operator は form 側で
    // 不要行を削って再 submit する。
    return {
      ok: false,
      error: `expected 1 token line, found ${candidates.length}. remove non-token lines and retry`,
    }
  }
  return { ok: true, token: candidates[0]! }
}

/**
 * #21 Phase B follow-up: Webull token 管理 UI の HTML body。token plaintext は
 * 一切埋め込まない (tokenHint だけ)。notice / error は redirect 後の query string
 * 経由で受け取る (PRG パターン)。
 */
function renderWebullTokenBody(args: {
  state: WebullTokenState | null
  notice: string | null
  error: string | null
}): string {
  const { state, notice, error } = args
  const banner = error
    ? `<p class="warn">⚠ ${esc(error)}</p>`
    : notice
      ? `<p class="ok">✓ ${esc(notice)}</p>`
      : ''

  const stateSection = state
    ? renderWebullTokenStateTable(state)
    : '<p>DO is empty — まだ seed されていません。下の form から投入してください。</p>'

  return `
<section style="max-width:760px">
  <p style="color:#666">
    Webull <code>x-access-token</code> の状態確認 / 投入 / 強制 refresh を行います。
    token 文字列は <code>pnpm run issue-token</code> で取得 (Webull モバイルアプリで 2FA verify 必要)。
    取得した NORMAL token を下の form に貼り付けて「seed」してください。
  </p>
  ${banner}
  <h2>現在の状態</h2>
  ${stateSection}

  <h2>新規 seed (or 上書き)</h2>
  <details style="margin-bottom:8px">
    <summary style="cursor:pointer;color:#555">📋 何を貼ればいい？</summary>
    <div style="padding:8px 0 0 16px;color:#555;font-size:13px;line-height:1.6">
      <p><code>pnpm run issue-token</code> を最後まで完了させる (status=NORMAL になる) と、
      stdout の <strong>最後の 1 行</strong> に長い英数字の token が出力されます。<br>
      diagnostic ログ (<code>[issue-token] ...</code> で始まる行) を含めて全文貼り付けても OK
      — server-side で token 行だけ自動抽出します。</p>
      <p>⚠ ログ内の <code>received: 0197e6...7689</code> のような <strong>"..." 入りの短い文字列は
      実 token ではなく表示用の省略形</strong> です。2FA verify を完了するまで実 token は
      出力されません。</p>
      <p>例 (NORMAL 化したときの末尾出力):</p>
      <pre style="background:#f6f8fa;padding:8px;border-radius:4px;overflow:auto;font-size:12px">[issue-token] poll (60s elapsed): xxxxxx...yyyy (status=NORMAL)
[issue-token] NORMAL token acquired. Inject via:
  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=&lt;dev|staging|production&gt;
  (paste the value printed below)

&lt;long alphanumeric NORMAL token string&gt;   ← この行が実 token</pre>
    </div>
  </details>
  <form method="post" action="/dashboard/webull-token/seed" style="display:flex;flex-direction:column;gap:8px;max-width:720px">
    <label for="token" style="font-weight:bold">issue-token の出力を貼り付け (丸ごとで OK):</label>
    <textarea id="token" name="token" rows="6" required
      placeholder="例:&#10;[issue-token] NORMAL token acquired. Inject via:&#10;  pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=production&#10;&#10;<long alphanumeric NORMAL token string>"
      style="font-family:ui-monospace,monospace;padding:6px;border:1px solid #ccc;border-radius:4px"
    ></textarea>
    <button type="submit" style="padding:8px 16px;background:#28a;color:#fff;border:none;border-radius:4px;cursor:pointer;align-self:flex-start">
      seed (token 行を自動抽出 → broker で再 verify → DO 書込)
    </button>
  </form>

  <h2 style="margin-top:24px">手動 refresh</h2>
  <p style="color:#666">
    既存 token を Webull に渡して <code>createToken(existingToken)</code> を強制実行します。
    通常は daily cron (22:00 UTC) で自動的に走るため、ボタンは「期限間近を待たずに更新したい」「失敗事象を再現したい」など特殊用途のみ。
  </p>
  <form method="post" action="/dashboard/webull-token/refresh" onsubmit="return confirm('手動 refresh を実行します。よろしいですか?');">
    <button type="submit" style="padding:8px 16px;background:#888;color:#fff;border:none;border-radius:4px;cursor:pointer">
      refresh now
    </button>
  </form>
</section>`
}

function renderWebullTokenStateTable(state: WebullTokenState): string {
  const statusClass = state.status === 'NORMAL' ? 'ok' : 'warn'
  // expires は ms / sec 両対応 (Webull docs 未明示)。10^12 以上を ms 扱い。
  const expiresMs = state.expires >= 1e12 ? state.expires : state.expires * 1000
  const expiresIso = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : '(invalid)'
  const tokenHint = state.token.length > 10
    ? `${state.token.slice(0, 6)}...${state.token.slice(-4)}`
    : '<redacted>'
  return `
<table style="border-collapse:collapse;margin-bottom:16px">
  <tr><th style="text-align:left;padding:4px 12px 4px 0">status</th>
      <td><span class="${statusClass}">${esc(state.status)}</span></td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">tokenHint</th>
      <td><code>${esc(tokenHint)}</code></td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">expires</th>
      <td>${esc(String(state.expires))} <span class="muted">(${esc(expiresIso)})</span></td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">fetchedAt</th>
      <td>${esc(state.fetchedAt)}</td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">lastAttemptAt</th>
      <td>${esc(state.lastAttemptAt ?? '(never)')}</td></tr>
  <tr><th style="text-align:left;padding:4px 12px 4px 0">lastSuccessAt</th>
      <td>${esc(state.lastSuccessAt ?? '(never)')}</td></tr>
</table>`
}

/**
 * `SymbolUniverse` から 番号/ticker - 会社名 表示文字列を返す薄い helper。
 * universe が無い (load 失敗等) ケースは symbol そのまま (= 既存挙動)。
 *
 * `URL ?symbol=7974` の routing は変更しない。表示テキストだけが
 * `7974-任天堂` / `AAPL-Apple Inc.` 形式に切り替わる。
 */
function displaySymbol(symbol: string, universe?: SymbolUniverse | null): string {
  if (!universe) return symbol
  const upper = symbol.toUpperCase()
  return formatSymbolDisplay({
    symbol,
    name: universe.symbolName[upper] ?? null,
  })
}

/**
 * symbol が universe.inactiveSymbols (= active=0) に含まれていれば true。
 * `inactiveSymbols` は active=0 全般 (disable / pause 含む) なので "inactive"
 * と中立的に呼ぶ。universe が null / 未配線の時は false (= 既存挙動を変えない)。
 */
function isSymbolInactive(symbol: string, universe?: SymbolUniverse | null): boolean {
  if (!universe) return false
  const upper = symbol.toUpperCase()
  return universe.inactiveSymbols.includes(upper)
}

/**
 * inactive 銘柄の tooltip 用テキスト ("INACTIVE: <notes>" 形式)。notes が
 * 無ければ単に "INACTIVE"。HTML escape は呼び出し側の責任。
 *
 * `inactiveSymbols` は disable (恒久) と pause (一時停止) を区別しないため、
 * 中立的な "INACTIVE" を採用 (元の "DISABLED" は pause 銘柄を誤認させる)。
 */
function inactiveTooltip(symbol: string, universe?: SymbolUniverse | null): string {
  if (!universe) return ''
  const upper = symbol.toUpperCase()
  const note = universe.symbolNotes[upper]
  return note ? `INACTIVE: ${note}` : 'INACTIVE'
}

function clampLimit(raw: string | undefined): number {
  const n = raw === undefined ? 50 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 200)
}

/**
 * HTML entity escaper. Thin alias over shared `escapeHtml` (#284) — every
 * D1 / DO-derived string (symbol names, error messages, audit JSON, alerts
 * cause / message, …) passes through this before interpolation. Without it
 * an attacker who can write `notes` / `reason` / `before_json` could inject
 * a <script> that submits the kill-switch / seed-cash form on the
 * operator's session.
 */
const esc = escapeHtml

function fmtNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return n.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

const JST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/**
 * Render an ISO/Date value in JST (YYYY-MM-DD HH:mm:ss JST). Returns the
 * raw string unchanged on parse failure so operators can still grep for the
 * original even if upstream emits a weird format.
 */
function fmtJst(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) return typeof value === 'string' ? value : '-'
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} JST`
}

const STYLE = `
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:0;background:#f5f5f7;color:#1d1d1f}
  h1{margin:0 0 16px;font-size:22px}
  /* mf-dashboard 風 shell: 左 sidebar + main */
  .app{display:flex;min-height:100vh;align-items:stretch}
  .sidebar{flex:0 0 216px;background:#fff;border-right:1px solid #d0d0d5;padding:16px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;align-self:flex-start;height:100vh;overflow-y:auto}
  .sidebar .brand{font-weight:700;font-size:15px;padding:4px 8px 12px;color:#1d1d1f}
  .sidebar nav{display:flex;flex-direction:column;gap:2px}
  .sidebar .nav-group{color:#86868b;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;padding:12px 8px 4px}
  .sidebar .nav-link{color:#1d1d1f;text-decoration:none;padding:7px 10px;border-radius:7px;font-size:13px}
  .sidebar .nav-link:hover{background:#f0f0f3}
  .sidebar .nav-link.active{background:#06c;color:#fff;font-weight:600}
  .main{flex:1;min-width:0;padding:24px}
  .main .page-title{margin:0 0 16px;font-size:22px}
  @media(max-width:780px){
    .app{flex-direction:column}
    .sidebar{flex:none;width:auto;height:auto;position:static;border-right:none;border-bottom:1px solid #d0d0d5;flex-direction:row;flex-wrap:wrap;align-items:center}
    .sidebar nav{flex-direction:row;flex-wrap:wrap}
    .sidebar .nav-group{padding:4px 8px}
    .main{padding:16px}
  }
  /* KPI カード */
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
  .kpi-card{background:#fff;border:1px solid #d0d0d5;border-radius:10px;padding:14px}
  .kpi-label{color:#86868b;font-size:12px;margin-bottom:6px}
  .kpi-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
  .kpi-sub{font-size:12px;margin-top:4px;font-variant-numeric:tabular-nums}
  /* パネル (カード) */
  .panel{background:#fff;border:1px solid #d0d0d5;border-radius:10px;padding:16px;margin-bottom:16px}
  .panel>.panel-title{margin:0 0 12px;font-size:14px;font-weight:700}
  .panel-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:780px){.panel-row{grid-template-columns:1fr}}
  .panel table{border:none;border-radius:0}
  /* bar (構成比 / movers) */
  .bar-track{background:#f0f0f3;border-radius:4px;height:8px;overflow:hidden;margin-top:3px}
  .bar-fill{height:8px;border-radius:4px;background:#06c}
  .bar-fill.up{background:#057a55}.bar-fill.down{background:#c22}
  .rank-row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:13px;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700}
  .pill.dry{background:#057a55;color:#fff}.pill.live{background:#c22;color:#fff}
  .pill.on{background:#057a55;color:#fff}.pill.off{background:#86868b;color:#fff}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #d0d0d5;border-radius:6px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #e5e5ea;font-size:13px;font-variant-numeric:tabular-nums}
  th{background:#fafafa;font-weight:600}
  tr:last-child td{border-bottom:none}
  .muted{color:#86868b}
  .warn{color:#b25000}
  .err{color:#c22}
  .ok{color:#057a55}
  .footer{margin-top:24px;font-size:11px;color:#86868b}
  details{margin-top:16px}
  summary{cursor:pointer;padding:6px 0;font-weight:600}
  .reason-details{margin:0;min-width:260px}
  .reason-details summary{padding:0;color:#06c;font-weight:400}
  .reason-panel{margin-top:8px;padding:10px;border:1px solid #e5e5ea;border-radius:6px;background:#fafafa;color:#1d1d1f;max-width:680px}
  .reason-panel div{margin:0 0 8px}
  .reason-panel div:last-child{margin-bottom:0}
  .reason-panel ul{margin:4px 0 10px;padding-left:20px}
  .reason-panel code{white-space:pre-wrap;word-break:break-word}
  .reason-panel pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px}
  .symbol-disabled{opacity:0.5;font-style:italic;text-decoration:line-through}
  tr.symbol-disabled-row{background:#fafafa}
  tr.symbol-disabled-row td{color:#86868b}
  .grid-panel.symbol-inactive{background:#fafafa;opacity:0.65}
`

function renderLayout(
  c: {
    req: { path: string }
    env: unknown
    var: { killSwitchState: KillSwitchBannerState | null }
  },
  title: string,
  body: string,
): string {
  const banner = killSwitchBanner(c.var.killSwitchState)
  return layout(title, banner + body, c.req.path)
}

/** Sidebar nav 定義 (mf-dashboard 風 shell)。active link は path 完全一致で強調。 */
const NAV_GROUPS: ReadonlyArray<{
  label?: string
  links: ReadonlyArray<{ href: string; text: string; title?: string }>
}> = [
  { links: [{ href: '/dashboard', text: 'ホーム' }] },
  {
    label: '取引状況',
    links: [
      { href: '/dashboard/positions', text: 'ポートフォリオ' },
      { href: '/dashboard/portfolio', text: '口座サマリ' },
      { href: '/dashboard/trades', text: '約定履歴' },
    ],
  },
  {
    label: '戦略・監視',
    links: [
      { href: '/dashboard/cron', text: '戦略判定' },
      { href: '/dashboard/charts', text: 'チャート' },
      { href: '/dashboard/alerts', text: 'アラート' },
      { href: '/dashboard/events', text: 'イベント' },
    ],
  },
  {
    label: '運用',
    links: [
      { href: '/dashboard/config', text: '設定' },
      { href: '/dashboard/symbols', text: '銘柄管理' },
      { href: '/dashboard/audit', text: '監査ログ' },
      {
        href: '/dashboard/broker-probe',
        text: 'broker 診断',
        title: 'Webull broker に直接 quote/positions を投げて raw レスポンスを表示する診断ページ',
      },
      {
        href: '/dashboard/webull-token',
        text: 'Webull token',
        title: 'Webull x-access-token の状態確認 / 投入 / refresh (#21 Phase B)',
      },
    ],
  },
]

function renderSidebarNav(activePath?: string): string {
  return NAV_GROUPS.map((g) => {
    const head = g.label ? `<div class="nav-group">${esc(g.label)}</div>` : ''
    const links = g.links
      .map((l) => {
        const active = activePath === l.href ? ' active' : ''
        const t = l.title ? ` title="${esc(l.title)}"` : ''
        return `<a class="nav-link${active}" href="${l.href}"${t}>${esc(l.text)}</a>`
      })
      .join('')
    return head + links
  }).join('')
}

function killSwitchBanner(state: KillSwitchBannerState | null): string {
  if (state === null) {
    return '<div class="kill-switch kill-switch-unknown">取引状態: <span class="muted">取得不能 (D1 未接続)</span></div>'
  }
  const statusLabel = state.effective
    ? '<span class="ok">取引 ON (有効)</span>'
    : '<span class="err">取引 OFF (停止中)</span>'
  const envNote = state.envOverrideActive
    ? `<span class="warn" style="margin-left:8px">⚠ env TRADING_ENABLED で deploy-gate ON: DB を ${state.dbEnabled ? 'ON' : 'OFF'} にしても effective は OFF</span>`
    : ''
  const disabled = state.envOverrideActive ? 'disabled' : ''
  const buttonForm = state.effective
    ? `<form method="post" action="/admin/trading/toggle" class="kill-switch-form" style="display:inline-flex;gap:6px;align-items:center;margin-left:12px">
        <input type="hidden" name="enabled" value="false"/>
        <input type="text" name="reason" placeholder="停止理由 (必須)" required maxlength="256" style="padding:3px 6px;font-size:12px;width:200px"/>
        <button type="submit" ${disabled} style="padding:4px 10px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">取引停止</button>
       </form>`
    : `<form method="post" action="/admin/trading/toggle" class="kill-switch-form" onsubmit="return confirm('取引を再開します。本当によろしいですか？');" style="display:inline-flex;gap:6px;align-items:center;margin-left:12px">
        <input type="hidden" name="enabled" value="true"/>
        <input type="text" name="reason" placeholder="再開理由 (必須)" required maxlength="256" style="padding:3px 6px;font-size:12px;width:200px"/>
        <button type="submit" ${disabled} style="padding:4px 10px;font-size:12px;background:#057a55;color:#fff;border:none;border-radius:4px;cursor:pointer">取引再開</button>
       </form>`
  return `<div class="kill-switch" style="padding:8px 12px;margin-bottom:12px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;font-size:13px;display:flex;align-items:center;flex-wrap:wrap">
    <strong>取引状態:</strong>&nbsp;${statusLabel}${envNote}${buttonForm}
  </div>`
}

function layout(title: string, body: string, activePath?: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} — Webull Trading</title>
<style>${STYLE}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand">Webull Trading</div>
    <nav>${renderSidebarNav(activePath)}</nav>
  </aside>
  <main class="main">
    <h1 class="page-title">${esc(title)}</h1>
    ${body}
    <div class="footer">画面生成時刻: ${esc(fmtJst(new Date()))}</div>
  </main>
</div>
</body>
</html>`
}

function unavailable(reason: string): string {
  return `<p class="warn">利用不可: ${esc(reason)}</p>`
}

/**
 * Broker probe UI body: form + 結果表示器。submit で `/admin/broker/probe` を
 * 同一 origin の fetch (credentials: 'same-origin') で呼び、JSON を pre 整形
 * 表示。auth は browser の既存 Cloudflare Access cookie が流用される (#29 で
 * basic auth から Access に移行済)。
 *
 * Server-side proxy を介さず client-side fetch にしてる理由:
 *   - dashboard handler が admin endpoint を sub-fetch するには Access JWT を
 *     request から request へ転送する必要があり、責務が混ざる
 *   - client-side fetch なら browser の Access cookie が自然に流れる、ロジック単純
 *   - probe payload に Cache-Control: no-store が付いてるので browser cache
 *     にも残らない
 */
/**
 * symbol → probe category 推定 (server-side)。client 側の inferCategory と同じ
 * ロジックを TS でも持つことで、universe を server-side render するときの
 * data-category 属性を正しく埋められる。
 *
 * - 4 桁数字 = JP_STOCK (`1570` だけ既知 ETF)
 * - US は `SOXL/SOXS/SPY/QQQ` を ETF 扱い、それ以外 STOCK
 */
function inferProbeCategory(symbol: string): 'JP_STOCK' | 'JP_ETF' | 'US_STOCK' | 'US_ETF' {
  const upper = symbol.toUpperCase()
  if (/^\d{4}$/.test(upper)) {
    if (upper === '1570') return 'JP_ETF'
    return 'JP_STOCK'
  }
  if (upper === 'SOXL' || upper === 'SOXS' || upper === 'SPY' || upper === 'QQQ') {
    return 'US_ETF'
  }
  return 'US_STOCK'
}

/**
 * universe.allowedSymbols + inactiveSymbols を category 別にグルーピングして
 * クリック可能ボタン群を返す。inactive は薄色 + INACTIVE バッジで識別。
 * universe=null (DB 未設定 / load 失敗) は空文字 (UI から登録銘柄セクションは
 * 隠れず空のまま表示)。
 */
function renderUniverseLinks(universe: SymbolUniverse | null): string {
  if (!universe) {
    return '<span class="muted" style="font-size:12px">universe ロード失敗 (DB 未設定 / 接続失敗)</span>'
  }
  const inactiveSet = new Set(universe.inactiveSymbols.map((s) => s.toUpperCase()))
  const allSymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
  if (allSymbols.length === 0) {
    return '<span class="muted" style="font-size:12px">登録銘柄なし</span>'
  }
  // category 別に分類して描画 (US_STOCK / US_ETF / JP_STOCK / JP_ETF の順)
  const groups: Record<string, string[]> = {
    US_STOCK: [],
    US_ETF: [],
    JP_STOCK: [],
    JP_ETF: [],
  }
  for (const sym of allSymbols) {
    const cat = inferProbeCategory(sym)
    groups[cat]!.push(sym)
  }
  const renderBtn = (sym: string, cat: string): string => {
    const inactive = inactiveSet.has(sym.toUpperCase())
    const display = displaySymbol(sym, universe)
    const baseStyle =
      'padding:3px 10px;font-size:12px;border:1px solid #ddd;border-radius:14px;cursor:pointer;background:#fff'
    const style = inactive
      ? `${baseStyle};color:#999;background:#f3f3f3`
      : baseStyle
    const inactiveBadge = inactive
      ? ' <span style="font-size:10px;color:#999">(INACTIVE)</span>'
      : ''
    return `<button type="button" class="probe-pickbtn" data-symbol="${esc(sym)}" data-category="${cat}" style="${style}" title="${esc(cat)}">${esc(display)}${inactiveBadge}</button>`
  }
  const sections: string[] = []
  for (const cat of ['US_STOCK', 'US_ETF', 'JP_STOCK', 'JP_ETF']) {
    const syms = groups[cat]!
    if (syms.length === 0) continue
    const buttons = syms.map((s) => renderBtn(s, cat)).join(' ')
    sections.push(
      `<div style="margin-bottom:8px"><span class="muted" style="font-size:11px;margin-right:8px">${cat}</span>${buttons}</div>`,
    )
  }
  return sections.join('')
}

function brokerProbeBody(args: {
  symbol: string
  category: string
  universe: SymbolUniverse | null
}): string {
  // 旧版 (PR #245-#247) は form + datalist + chip、PR #248 で保有銘柄駆動に
  // 切替えた。本 UI (PR #249) では symbol_config 登録銘柄全部 (active +
  // inactive) を「登録銘柄」セクションでも click 可能にする (ユーザ要望:
  // 「登録している銘柄は全部リンクにしてほしかった」)。これで保有してない
  // 銘柄も Webull に直で確認できる。
  //
  // フロー:
  //   1. ページ表示 → auto-probe (default: AAPL/US_STOCK)
  //   2. positions JSON parse → 各 holding をボタンとして列挙 (= 保有 click)
  //   3. universe.allowedSymbols + inactiveSymbols を server-side で render
  //      (= 登録銘柄 click)
  //   4. AAPL は JP UAT で唯一 200 が返る US 銘柄なので control として残す
  //
  // 任意 symbol で叩きたい場合は curl /admin/broker/probe を直接でも OK。

  // server-side で universe をリンク chip に展開。category は client 側の
  // inferCategory と同じロジックでサーバ側でも判定 (4 桁 = JP_STOCK or
  // 1570=JP_ETF、US は SOXL/SOXS/SPY/QQQ=US_ETF それ以外=US_STOCK)。
  const universeLinks = renderUniverseLinks(args.universe)
  return `<p class="muted" style="font-size:12px">
  Webull broker (host は <code>WEBULL_TRADE_API_BASE</code> / <code>WEBULL_QUOTES_API_BASE</code> から決定、
  未設定なら JP prod default) に <code>/openapi/market-data/stock/snapshot</code> +
  <code>/openapi/account/positions</code> を直接 fetch して raw レスポンスを表示します。
  click した銘柄について broker に quote を問合せて生応答 (status / error_code / request_id)
  が見えます。実際に使われた host は meta セクションの <code>sandbox.trade</code> /
  <code>sandbox.quotes</code> で確認可。任意の symbol / category で叩きたい場合は
  <code>curl /admin/broker/probe?symbol=X&amp;category=Y</code> を直接実行してください。
</p>
<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px">
  <span class="muted" id="probe-status" style="font-size:12px">読み込み中...</span>
  <button type="button" id="probe-refresh" style="padding:4px 12px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">再 probe</button>
</div>

<h2 style="font-size:14px;margin:16px 0 4px 0">保有銘柄 (click で quote probe)</h2>
<div id="probe-positions-list" style="margin-bottom:16px"></div>

<h2 style="font-size:14px;margin:16px 0 4px 0">登録銘柄 (symbol_config の active + inactive)</h2>
<div style="margin-bottom:16px">${universeLinks}</div>

<h2 style="font-size:14px;margin:16px 0 4px 0">control (US は AAPL のみ allowlist 通過)</h2>
<div style="margin-bottom:16px">
  <button type="button" class="probe-pickbtn" data-symbol="AAPL" data-category="US_STOCK" style="padding:4px 12px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer">AAPL (US_STOCK)</button>
</div>

<h2 style="font-size:14px;margin:16px 0 4px 0">quote 結果 (Webull) <span class="muted" id="probe-current" style="font-size:12px;font-weight:normal"></span></h2>
<pre id="probe-quote" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:12px;overflow:auto;max-height:400px;white-space:pre-wrap;word-break:break-all">(まだ probe 未実行)</pre>

<h2 style="font-size:14px;margin:16px 0 4px 0">quote 結果 (Yahoo Finance) <span class="muted" style="font-size:12px;font-weight:normal">— strategy cron が default で使う source</span></h2>
<pre id="probe-quote-yahoo" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:12px;overflow:auto;max-height:400px;white-space:pre-wrap;word-break:break-all">(まだ probe 未実行)</pre>

<h2 style="font-size:14px;margin:16px 0 4px 0">買付余力 (buying power) <span class="muted" style="font-size:11px">#415</span></h2>
<p class="muted" style="font-size:11px;margin:0 0 4px 0">
  発注前の共有プール pre-trade ゲートが使う口座買付余力。通貨別 <code>buying_power</code> を表示。取得失敗時は cron が当 tick の BUY を全見送り (fail-closed)。
</p>
<div id="probe-buying-power" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:13px">(まだ probe 未実行)</div>

<h2 style="font-size:14px;margin:16px 0 4px 0">meta</h2>
<pre id="probe-meta" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:12px">(まだ probe 未実行)</pre>

<h2 style="font-size:14px;margin:16px 0 4px 0">drift 比較 (旧 path vs 新 path)</h2>
<p class="muted" style="font-size:11px;margin:0 0 8px 0">
  #251 で発覚した OpenAPI ドキュメント drift の検証。旧 (\`/openapi/account/*\` + v1) と新 (\`/openapi/assets/*\` or \`/openapi/trade/order/*\` + v2) を並列で叩いた結果。両方 200 なら alias、片方 404 なら drift 確定、shape 違いなら schema migration が必要。
</p>
<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px">
  <thead><tr style="border-bottom:1px solid #ddd">
    <th style="text-align:left;padding:4px 8px">endpoint</th>
    <th style="text-align:left;padding:4px 8px">old</th>
    <th style="text-align:left;padding:4px 8px">new</th>
  </tr></thead>
  <tbody id="probe-drift-table">
    <tr><td colspan="3" class="muted" style="padding:8px;text-align:center">(probe 未実行)</td></tr>
  </tbody>
</table>

<details style="margin-top:16px">
  <summary class="muted" style="font-size:12px;cursor:pointer">positions / orderHistory raw responses (旧/新)</summary>
  <h3 style="font-size:12px;margin:8px 0 4px 0">positions (旧 /openapi/account/positions, v1)</h3>
  <pre id="probe-positions-raw" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all"></pre>
  <h3 style="font-size:12px;margin:8px 0 4px 0">positionsNew (新 /openapi/assets/positions, v2)</h3>
  <pre id="probe-positions-new-raw" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all"></pre>
  <h3 style="font-size:12px;margin:8px 0 4px 0">orderHistoryOld (旧 /openapi/account/orders/history, v1)</h3>
  <pre id="probe-order-old-raw" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all"></pre>
  <h3 style="font-size:12px;margin:8px 0 4px 0">orderHistoryNew (新 /openapi/trade/order/history, v2)</h3>
  <pre id="probe-order-new-raw" style="background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:8px;font-size:11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all"></pre>
</details>

<script>
(function () {
  var statusEl = document.getElementById('probe-status');
  var refreshBtn = document.getElementById('probe-refresh');
  var positionsListEl = document.getElementById('probe-positions-list');
  var quoteEl = document.getElementById('probe-quote');
  var metaEl = document.getElementById('probe-meta');
  var rawEl = document.getElementById('probe-positions-raw');
  var currentEl = document.getElementById('probe-current');

  // JP は 4 桁数字 (TSE code)。1570 だけ既知 ETF、それ以外は STOCK 扱い。
  // US は SOXL / SOXS / SPY / QQQ を ETF 扱い、それ以外は STOCK。
  var US_ETF_KNOWN = { SOXL: 1, SOXS: 1, SPY: 1, QQQ: 1 };
  var JP_ETF_KNOWN = { '1570': 1 };
  function inferCategory(symbol) {
    if (/^\\d{4}$/.test(symbol)) {
      return JP_ETF_KNOWN[symbol] ? 'JP_ETF' : 'JP_STOCK';
    }
    return US_ETF_KNOWN[symbol.toUpperCase()] ? 'US_ETF' : 'US_STOCK';
  }

  function prettify(section) {
    if (!section) return '(no data)';
    var raw = section.bodyTruncated;
    var parsed = null;
    if (typeof raw === 'string' && raw.length > 0) {
      try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    }
    var header = '[' + section.phase + '] status=' + section.status + ' ok=' + section.ok +
      ' msTaken=' + section.msTaken + 'ms bodyLength=' + section.bodyLength;
    if (section.error) header += ' error=' + section.error;
    var bodyText = parsed != null ? JSON.stringify(parsed, null, 2) : (raw || '(empty)');
    return header + '\\n\\n' + bodyText;
  }

  function formatNumber(s) {
    var n = Number(s);
    if (!Number.isFinite(n)) return String(s);
    return n.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
  }

  // positions の bodyTruncated を parse して clickable button list を作る。
  // parse 失敗 / 空配列なら "(なし)" 表示。各 button は data-symbol / data-category
  // を持ち、共通 click handler で probe 起動。
  function renderPositionsList(section) {
    if (!section || section.phase !== 'response' || !section.ok) {
      positionsListEl.innerHTML = '<span class="muted" style="font-size:12px">positions: ' +
        ((section && section.error) || (section && 'status=' + section.status) || 'no data') + '</span>';
      rawEl.textContent = section ? prettify(section) : '(no data)';
      return;
    }
    var raw = section.bodyTruncated;
    rawEl.textContent = prettify(section);
    var items = null;
    try { items = JSON.parse(raw); } catch (_) { items = null; }
    if (!Array.isArray(items) || items.length === 0) {
      positionsListEl.innerHTML = '<span class="muted" style="font-size:12px">保有銘柄なし</span>';
      return;
    }
    var html = items.map(function (item) {
      var sym = item.symbol || '';
      var name = item.symbol_name || '';
      var qty = formatNumber(item.quantity);
      var cur = item.currency || '';
      var mv = formatNumber(item.market_value);
      var cost = formatNumber(item.cost_price);
      var cat = inferCategory(sym);
      return '<button type="button" class="probe-pickbtn" data-symbol="' + sym + '" data-category="' + cat +
        '" style="display:block;width:100%;text-align:left;padding:6px 10px;font-size:12px;border:1px solid #ddd;border-radius:4px;background:#fff;cursor:pointer;margin-bottom:4px">' +
        '<strong>' + sym + '</strong> ' + (name ? '— ' + name + ' ' : '') +
        '<span class="muted">qty=' + qty + ' cost=' + cost + ' mv=' + cur + ' ' + mv + ' (' + cat + ')</span>' +
        '</button>';
    }).join('');
    positionsListEl.innerHTML = html;
    // 動的に作られたボタンに click handler を接続
    positionsListEl.querySelectorAll('.probe-pickbtn').forEach(function (btn) {
      btn.addEventListener('click', onPickClick);
    });
  }

  function probe(symbol, category) {
    refreshBtn.disabled = true;
    statusEl.textContent = '実行中: ' + symbol + ' (' + category + ')';
    currentEl.textContent = '— ' + symbol + ' / ' + category;
    quoteEl.textContent = '...';
    var url = '/admin/broker/probe?symbol=' + encodeURIComponent(symbol) +
      '&category=' + encodeURIComponent(category);
    // URL 更新 (bookmark / リロード対応)
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('symbol', symbol);
      u.searchParams.set('category', category);
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        var body = res.body;
        statusEl.textContent = res.status === 200 ? '完了' : ('admin endpoint status=' + res.status);
        // CodeRabbit #262: body fields が欠けてても UI を必ず更新して stale を
        // 残さない。quote / positions / 各 raw を **常に** 上書き。
        quoteEl.textContent = body.quote ? prettify(body.quote) : '(no data)';
        var quoteYahooEl = document.getElementById('probe-quote-yahoo');
        if (quoteYahooEl) quoteYahooEl.textContent = body.quoteYahoo ? prettify(body.quoteYahoo) : '(no data)';
        renderPositionsList(body.positions || null);
        // drift 比較: 新 path 結果も raw + table へ。値が無くても "(no data)"
        // を入れて stale 表示にしない。
        var positionsNewRaw = document.getElementById('probe-positions-new-raw');
        var orderOldRaw = document.getElementById('probe-order-old-raw');
        var orderNewRaw = document.getElementById('probe-order-new-raw');
        if (positionsNewRaw) positionsNewRaw.textContent = prettify(body.positionsNew);
        if (orderOldRaw) orderOldRaw.textContent = prettify(body.orderHistoryOld);
        if (orderNewRaw) orderNewRaw.textContent = prettify(body.orderHistoryNew);
        renderBuyingPower(body);
        renderDriftTable(body);
        metaEl.textContent = JSON.stringify({
          timestamp: body.timestamp,
          sandbox: body.sandbox,
          input: body.input,
          adminStatus: res.status,
        }, null, 2);
      })
      .catch(function (e) {
        statusEl.textContent = 'fetch error: ' + (e && e.message ? e.message : String(e));
      })
      .finally(function () {
        refreshBtn.disabled = false;
      });
  }

  // #415: 買付余力を描画。balance probe 候補 (account/balance v1, assets/balance v2)
  // のうち最初に 200 を返したものを parse し、通貨別 buying_power を出す。
  // どれも 200 でなければ ⚠ unavailable (= cron は当 tick の BUY を全見送り)。
  function renderBuyingPower(body) {
    var el = document.getElementById('probe-buying-power');
    if (!el) return;
    var candidates = [
      { label: '/openapi/account/balance (v1)', section: body.balanceAccountV1 },
      { label: '/openapi/assets/balance (v2)', section: body.balanceAssetsV2 },
    ];
    var hit = null;
    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i].section;
      if (s && s.phase === 'response' && s.status === 200 && typeof s.bodyTruncated === 'string') {
        var parsed = null;
        try { parsed = JSON.parse(s.bodyTruncated); } catch (_) { parsed = null; }
        if (parsed) { hit = { label: candidates[i].label, body: parsed }; break; }
      }
    }
    if (!hit) {
      el.innerHTML = '<span style="color:#c22;font-weight:600">⚠ 取得不可 (unavailable)</span> ' +
        '<span class="muted" style="font-size:11px">— balance endpoint がどれも 200 を返さず。cron は当 tick の BUY を fail-closed で見送ります。</span>';
      return;
    }
    var b = hit.body;
    var assets = Array.isArray(b.account_currency_assets) ? b.account_currency_assets : [];
    var rows = assets.map(function (a) {
      return '<tr><td style="padding:2px 10px 2px 0"><code>' + (a.currency || '?') + '</code></td>' +
        '<td style="padding:2px 10px;text-align:right;font-variant-numeric:tabular-nums">' + formatNumber(a.buying_power) + '</td>' +
        '<td style="padding:2px 10px;text-align:right;font-variant-numeric:tabular-nums" class="muted">cash ' + formatNumber(a.cash_balance) + '</td></tr>';
    }).join('');
    el.innerHTML =
      '<div style="margin-bottom:4px"><span style="color:#0a8a0a;font-weight:600">✅ 取得 OK</span> ' +
      '<span class="muted" style="font-size:11px">via ' + hit.label + ' / 基準通貨 ' + (b.total_asset_currency || '?') +
      ' / 総現金 ' + formatNumber(b.total_cash_balance) + '</span></div>' +
      '<table style="font-size:12px;border-collapse:collapse"><thead><tr class="muted">' +
      '<th style="text-align:left;padding:2px 10px 2px 0">通貨</th><th style="text-align:right;padding:2px 10px">買付余力</th><th></th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="3" class="muted">(通貨別資産なし)</td></tr>') + '</tbody></table>';
  }

  // drift 比較テーブルを描画。各行は status / msTaken を旧/新 並列表示。
  function renderDriftTable(body) {
    var tableBody = document.getElementById('probe-drift-table');
    if (!tableBody) return;
    function cell(section) {
      if (!section) return '<td class="muted" style="padding:4px 8px">(no data)</td>';
      var status = section.status == null ? section.phase : 'status=' + section.status;
      var ok = section.ok ? '✅' : (section.ok === false ? '❌' : '');
      var ms = section.msTaken == null ? '' : ' (' + section.msTaken + 'ms)';
      var color = section.ok ? '#0a8a0a' : (section.ok === false ? '#c22' : '#666');
      return '<td style="padding:4px 8px;color:' + color + '">' + ok + ' ' + status + ms + '</td>';
    }
    function row(label, oldSection, newSection) {
      return '<tr><td style="padding:4px 8px"><code>' + label + '</code></td>' +
        cell(oldSection) + cell(newSection) + '</tr>';
    }
    tableBody.innerHTML =
      row('positions', body.positions, body.positionsNew) +
      row('order history', body.orderHistoryOld, body.orderHistoryNew) +
      row('account balance', body.balanceAccountV1, body.balanceAssetsV2);
  }

  function onPickClick(ev) {
    var btn = ev.currentTarget;
    var sym = btn.getAttribute('data-symbol');
    var cat = btn.getAttribute('data-category');
    if (sym && cat) probe(sym, cat);
  }

  // 起動時の click 連携 (control buttons)
  document.querySelectorAll('.probe-pickbtn').forEach(function (btn) {
    btn.addEventListener('click', onPickClick);
  });

  // 再 probe ボタン: 直近の symbol / category を再使用。URL から拾う。
  refreshBtn.addEventListener('click', function () {
    var qs = new URLSearchParams(window.location.search);
    var sym = qs.get('symbol') || 'AAPL';
    var cat = qs.get('category') || 'US_STOCK';
    probe(sym, cat);
  });

  // 起動時 auto-probe は **URL に symbol+category 両方** ある時だけ
  // (= ボタンクリックで URL push された後の再読み込み / bookmark / 共有 link)。
  // nav からのプレーン訪問 (?なし) で勝手に probe を投げない方針 (PR #250、
  // ユーザ要望: 「Broker診断ボタンを押した直後は何も診断しないようにしてほし
  // い」)。URL クエリ無し時は status を「click 待ち」で表示。
  var qs = new URLSearchParams(window.location.search);
  if (qs.has('symbol') && qs.has('category')) {
    probe(qs.get('symbol'), qs.get('category'));
  } else {
    statusEl.textContent = '銘柄ボタンをクリックして probe 開始';
  }
})();
</script>`
}

function jsonPretty(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function parseJsonObject(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// #dashboard-mf-layout: overview パネル定義。設定で ON/OFF (default 全表示)。
export type OverviewPanel = 'kpi' | 'equity' | 'composition' | 'recent'
export const ALL_OVERVIEW_PANELS: readonly OverviewPanel[] = ['kpi', 'equity', 'composition', 'recent']
export const OVERVIEW_PANEL_LABELS: Record<OverviewPanel, string> = {
  kpi: 'KPI カード (総資産 / 当日損益 / 建玉数 / エクスポージャー)',
  equity: '資産推移チャート (期間タブ)',
  composition: '資産構成 + 含み損益ランキング',
  recent: '最近の約定 + VIX / リスク状態',
}

/** CSV を有効パネル集合へ。不正値は無視、空 (未設定/全部不正) は全表示。 */
export function parseOverviewPanels(csv: string | null | undefined): Set<OverviewPanel> {
  const set = new Set<OverviewPanel>()
  for (const tok of (csv ?? '').split(',').map((s) => s.trim())) {
    if ((ALL_OVERVIEW_PANELS as readonly string[]).includes(tok)) set.add(tok as OverviewPanel)
  }
  return set.size === 0 ? new Set(ALL_OVERVIEW_PANELS) : set
}

interface OverviewData {
  panels: Set<OverviewPanel>
  portfolio: {
    dailyStartEquity: number
    dailyRealizedPnl: number
    openExposureUsd: number
    openExposureJpy: number
    tradingDisabledUntil: string | null
    updatedAt: string
  } | null
  snapshots: PortfolioEquitySnapshotRow[]
  range: EquityRange
  positions: Array<{ sym: string; state: SymbolState | null; error: string | null }>
  strategyPriceMap: Map<string, { price: number; asOf: string }>
  recentTrades: Array<{
    id: number
    timestamp: string
    symbol: string | null
    side: string | null
    filledQty: number | null
    filledPrice: number | null
    realizedPnl: number | null
    brokerStatus: string | null
  }>
  vixRegime: VixRegime | null
  dryRun: boolean
  tradingEnabled: boolean
  universe: SymbolUniverse
}

/** 開いている建玉 (qty != 0) を評価額・含み損益% 付きで抽出。 */
interface OpenPositionView {
  sym: string
  qty: number
  currency: SymbolCurrency
  price: number | null
  marketValue: number | null
  pnlPct: number | null
}

/**
 * overview「最近の約定」用の直近 fill ロード。post_submit 行は side が null
 * (writer は pre_submit にしか入れない) なので client_order_id で pre_submit と
 * self-JOIN して side を引く (loadSymbolChart と同方針)。pre_submit が無い古い fill は
 * realized_pnl の有無から推測 (null=BUY / 非null=SELL)。
 */
async function loadRecentFills(
  db: D1Database,
  limit: number,
): Promise<OverviewData['recentTrades']> {
  const result = await db
    .prepare(
      `SELECT ps.id AS id, ps.timestamp AS timestamp, ps.symbol AS symbol,
         COALESCE(pre.side, CASE WHEN ps.realized_pnl IS NOT NULL THEN 'SELL' ELSE 'BUY' END) AS side,
         ps.filled_qty AS filledQty, ps.filled_price AS filledPrice,
         ps.realized_pnl AS realizedPnl, ps.broker_status AS brokerStatus
       FROM trade_journal AS ps
       LEFT JOIN trade_journal AS pre
         ON pre.client_order_id = ps.client_order_id AND pre.trade_event_type = 'pre_submit'
       WHERE ps.trade_event_type = 'post_submit' AND ps.filled_price IS NOT NULL
       ORDER BY ps.id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: number
      timestamp: string
      symbol: string | null
      side: string | null
      filledQty: number | null
      filledPrice: number | null
      realizedPnl: number | null
      brokerStatus: string | null
    }>()
  return result.results ?? []
}

function collectOpenPositions(data: OverviewData): OpenPositionView[] {
  const out: OpenPositionView[] = []
  for (const r of data.positions) {
    const pos = r.state?.position
    if (!r.state || !pos || pos.qty === 0) continue
    const webull = r.state.lastQuote
      ? { price: r.state.lastQuote.price, source: r.state.lastQuote.source, asOf: r.state.lastQuote.asOf ?? r.state.lastQuote.fetchedAt }
      : null
    const yahoo = data.strategyPriceMap.get(r.state.symbol) ?? null
    const quote = pickFreshQuote(webull, yahoo)
    const price = quote?.price ?? null
    const pnlPct = price !== null && pos.avgPrice > 0 ? ((price - pos.avgPrice) / pos.avgPrice) * 100 : null
    out.push({
      sym: r.state.symbol,
      qty: pos.qty,
      currency: data.universe.symbolCurrency[r.state.symbol] ?? 'USD',
      price,
      marketValue: price !== null ? pos.qty * price : null,
      pnlPct,
    })
  }
  return out
}

function kpiCard(label: string, value: string, sub?: string, subClass?: string): string {
  const subHtml = sub ? `<div class="kpi-sub ${subClass ?? 'muted'}">${sub}</div>` : ''
  return `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${subHtml}</div>`
}

function renderKpiPanel(data: OverviewData, open: OpenPositionView[]): string {
  const p = data.portfolio
  const dd = p && p.dailyStartEquity > 0 ? (p.dailyRealizedPnl / p.dailyStartEquity) * 100 : null
  const pnlClass = p == null ? 'muted' : p.dailyRealizedPnl >= 0 ? 'ok' : 'err'
  const cards = [
    kpiCard('当日始値資産', p ? fmtNumber(p.dailyStartEquity, 2) : '—', '口座 dailyStartEquity'),
    kpiCard(
      '当日実現損益',
      p ? `<span class="${pnlClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</span>` : '—',
      dd === null ? undefined : `DD ${fmtNumber(dd, 2)}%`,
      dd === null ? 'muted' : dd >= 0 ? 'ok' : 'err',
    ),
    kpiCard('建玉数', String(open.length), '保有中の銘柄数'),
    kpiCard(
      'Open exposure',
      p ? `${fmtNumber(p.openExposureUsd, 0)}<span class="muted" style="font-size:12px"> USD</span>` : '—',
      p ? `${fmtNumber(p.openExposureJpy, 0)} JPY` : undefined,
    ),
  ].join('')
  return `<div class="kpi-grid">${cards}</div>`
}

function renderCompositionPanel(open: OpenPositionView[]): string {
  if (open.length === 0) {
    return `<div class="panel"><div class="panel-title">資産構成 / 含み損益ランキング</div><p class="muted">保有中の建玉がありません。</p></div>`
  }
  // 通貨内シェアで構成比 bar を正規化 (USD/JPY を混ぜない)。
  const sumByCcy: Record<string, number> = {}
  for (const o of open) {
    if (o.marketValue !== null) sumByCcy[o.currency] = (sumByCcy[o.currency] ?? 0) + Math.abs(o.marketValue)
  }
  const composition = [...open]
    .sort((a, b) => (Math.abs(b.marketValue ?? 0)) - (Math.abs(a.marketValue ?? 0)))
    .map((o) => {
      const total = sumByCcy[o.currency] ?? 0
      const share = o.marketValue !== null && total > 0 ? (Math.abs(o.marketValue) / total) * 100 : 0
      const valueText = o.marketValue !== null ? `${fmtNumber(o.marketValue, 0)} ${o.currency}` : '—'
      return `<div class="rank-row"><span>${esc(o.sym)} <span class="muted" style="font-size:11px">${fmtNumber(share, 1)}%</span></span><span>${valueText}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${share.toFixed(1)}%"></div></div>`
    })
    .join('')
  // 含み損益% ランキング (up / down)。
  const ranked = open.filter((o) => o.pnlPct !== null) as Array<OpenPositionView & { pnlPct: number }>
  const gainers = [...ranked].filter((o) => o.pnlPct >= 0).sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5)
  const losers = [...ranked].filter((o) => o.pnlPct < 0).sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5)
  const rankRow = (o: OpenPositionView & { pnlPct: number }) =>
    `<div class="rank-row"><span>${esc(o.sym)}</span><span class="${o.pnlPct >= 0 ? 'ok' : 'err'}">${fmtNumber(o.pnlPct, 2)}%</span></div>`
  const rankCol = (title: string, items: Array<OpenPositionView & { pnlPct: number }>) =>
    `<div><div class="muted" style="font-size:12px;margin-bottom:4px">${esc(title)}</div>${items.length ? items.map(rankRow).join('') : '<p class="muted">—</p>'}</div>`
  return `<div class="panel">
    <div class="panel-title">資産構成 / 含み損益ランキング</div>
    <p class="muted" style="font-size:12px;margin-top:0">構成比は通貨内シェア。ランキングは含み損益% (現在値 vs 平均取得単価)。</p>
    <div class="panel-row">
      <div><div class="muted" style="font-size:12px;margin-bottom:4px">構成 (評価額)</div>${composition}</div>
      <div class="panel-row" style="grid-template-columns:1fr 1fr">${rankCol('上昇', gainers)}${rankCol('下落', losers)}</div>
    </div>
  </div>`
}

function renderRecentPanel(data: OverviewData): string {
  const trades = data.recentTrades
    .map((t) => {
      const sideClass = t.side === 'BUY' ? 'ok' : t.side === 'SELL' ? 'err' : 'muted'
      const pnl = t.realizedPnl !== null ? formatRealizedPnl(t.realizedPnl) : '<span class="muted">—</span>'
      return `<tr>
        <td class="muted" style="font-size:12px">${esc(fmtJst(t.timestamp))}</td>
        <td><strong>${esc(displaySymbol(t.symbol ?? '—', data.universe))}</strong></td>
        <td class="${sideClass}">${esc(t.side ?? '—')}</td>
        <td>${t.filledQty !== null ? esc(t.filledQty) : '—'}</td>
        <td>${t.filledPrice !== null ? fmtNumber(t.filledPrice, 2) : '—'}</td>
        <td>${pnl}</td>
      </tr>`
    })
    .join('')
  const recentTable = data.recentTrades.length
    ? `<table><thead><tr><th>時刻</th><th>銘柄</th><th>売買</th><th>数量</th><th>約定値</th><th>実損益</th></tr></thead><tbody>${trades}</tbody></table>`
    : '<p class="muted">約定履歴がありません。</p>'
  const dryPill = data.dryRun
    ? '<span class="pill dry">DRY-RUN</span>'
    : '<span class="pill live">LIVE</span>'
  const tradingPill = data.tradingEnabled
    ? '<span class="pill on">取引 ON</span>'
    : '<span class="pill off">取引 OFF</span>'
  return `<div class="panel">
    <div class="panel-title">最近の約定 / リスク状態</div>
    <div class="panel-row">
      <div>${recentTable}<div style="margin-top:8px"><a href="/dashboard/trades">約定履歴をすべて見る →</a></div></div>
      <div>
        <table><tbody>
          <tr><th>実行モード</th><td>${dryPill} <span class="muted" style="font-size:11px">(D1 dry_run)</span></td></tr>
          <tr><th>取引 (effective)</th><td>${tradingPill} <span class="muted" style="font-size:11px">(env override 反映後)</span></td></tr>
          <tr><th>VIX レジーム</th><td>${renderVixRegimeCell(data.vixRegime)}</td></tr>
        </tbody></table>
      </div>
    </div>
  </div>`
}

/**
 * 口座買付余力バッジ (#415)。SSR はブロックせず、client-side で `/admin/buying-power`
 * を fetch して通貨別 buying_power を描画する (broker-probe と同じく CF Access cookie
 * 流用)。取得失敗は ⚠ 表示でページは壊さない。ホーム / 銘柄設定の両方で使う。
 */
function buyingPowerBadge(): string {
  return `<div id="buying-power-badge" class="panel" style="display:flex;align-items:center;gap:8px;font-size:13px;padding:10px 14px">
    <strong>買付余力</strong> <span class="muted">読込中…</span>
  </div>
  <script>
  (function () {
    var el = document.getElementById('buying-power-badge');
    if (!el) return;
    fetch('/admin/buying-power', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { status: 'unavailable', reason: 'http ' + r.status }; })
      .then(function (d) {
        if (!d || d.status !== 'ok') {
          el.innerHTML = '<strong>買付余力</strong> <span style="color:#c22;font-weight:600">⚠ 取得不可</span>' +
            ' <span class="muted" style="font-size:11px">' + ((d && d.reason) ? String(d.reason).slice(0, 80) : '') + '</span>';
          return;
        }
        var parts = (d.byCurrency || []).map(function (a) {
          var bp = Number(a.buyingPower);
          var sym = a.currency === 'JPY' ? '¥' : (a.currency === 'USD' ? '$' : '');
          var v = isFinite(bp) ? bp.toLocaleString('ja-JP', { maximumFractionDigits: a.currency === 'JPY' ? 0 : 2 }) : a.buyingPower;
          var zero = isFinite(bp) && bp <= 0;
          return '<span style="' + (zero ? 'color:#86868b' : 'font-weight:600') + '">' + a.currency + ' ' + sym + v + '</span>';
        });
        el.innerHTML = '<strong>買付余力</strong> ' + (parts.join(' &nbsp;/&nbsp; ') || '—') +
          ' <span class="muted" style="font-size:11px">(口座 ' + (d.baseCurrency || '') + ' 総現金 ' + Number(d.totalCash).toLocaleString('ja-JP') + ')</span>';
      })
      .catch(function () {
        el.innerHTML = '<strong>買付余力</strong> <span style="color:#c22;font-weight:600">⚠ 取得不可</span>';
      });
  })();
  </script>`
}

function overviewBody(data: OverviewData): string {
  const open = collectOpenPositions(data)
  const sections: string[] = []
  if (data.panels.has('kpi')) sections.push(renderKpiPanel(data, open))
  if (data.panels.has('equity')) {
    sections.push(
      `<div class="panel">${renderPortfolioEquityChart(data.snapshots, data.range, '/dashboard')}</div>`,
    )
  }
  if (data.panels.has('composition')) sections.push(renderCompositionPanel(open))
  if (data.panels.has('recent')) sections.push(renderRecentPanel(data))
  if (sections.length === 0) {
    sections.push(
      '<p class="muted">表示パネルが選択されていません。<a href="/dashboard/config">設定</a>でパネルを有効化してください。</p>',
    )
  }
  return buyingPowerBadge() + sections.join('')
}

/**
 * 各銘柄の「strategy が直近に判定で使った価格」を取得。
 * Yahoo daily bars から計算された `indicators.price` が
 * strategy_decision_log.price に書き出されているので、最新行を引く。
 *
 * Webull bridge が落ちて lastQuote が古い場合、こちらが新しければ
 * dashboard の現在値表示に採用される (pickFreshQuote で比較)。
 *
 * 実装: D1 の `(symbol, id)` 複合 index を活かして symbol 並列で
 * `ORDER BY id DESC LIMIT 1` を打つ。1 銘柄あたり 1 row のみ転送。
 */
async function loadLatestStrategyPrices(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, { price: number; asOf: string }>> {
  if (symbols.length === 0) return new Map()
  const drizzle = createDb(db)
  // 個別 symbol の失敗で全体を 500 にしないよう per-symbol で catch。
  // strategy_decision_log がまだ空の銘柄や DB 一時的エラーは「Yahoo 価格なし」
  // として扱い、Webull lastQuote にフォールバックさせる。
  const entries = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const row = await drizzle
          .select({
            symbol: strategyDecisionLog.symbol,
            price: strategyDecisionLog.price,
            timestamp: strategyDecisionLog.timestamp,
          })
          .from(strategyDecisionLog)
          .where(eq(strategyDecisionLog.symbol, sym))
          .orderBy(desc(strategyDecisionLog.id))
          .limit(1)
        const r = row[0]
        if (!r || r.price === null || r.price === undefined) return null
        return [r.symbol, { price: r.price, asOf: r.timestamp }] as const
      } catch {
        return null
      }
    }),
  )
  return new Map(entries.filter((e): e is readonly [string, { price: number; asOf: string }] => e !== null))
}

/**
 * 表示用「現在値」の決定。dashboard が見せる現在値の source は
 * 2 系統あり、bridge 障害などで Webull snapshot が古くなる場合がある:
 *
 * - webull-snapshot: SymbolStateDO.lastQuote (Webull bridge の 5 分 cron)
 * - yahoo-bars: strategy_decision_log.price (Yahoo daily bars 経由、15 分 cron)
 *
 * 両方あれば asOf が新しい方を採用。strategy が判定に使う価格と表示が
 * 一致するのが UX 上の正なので、片方だけしか無い場合もそちらを採る。
 */
interface ResolvedQuote {
  price: number
  source: string
  asOf: string
}

export function pickFreshQuote(
  webull: { price: number; source: string; asOf: string } | null,
  yahoo: { price: number; asOf: string } | null,
): ResolvedQuote | null {
  if (webull === null && yahoo === null) return null
  if (webull === null) return { price: yahoo!.price, source: 'yahoo-bars', asOf: yahoo!.asOf }
  if (yahoo === null) return { price: webull.price, source: webull.source, asOf: webull.asOf }
  const w = new Date(webull.asOf).getTime()
  const y = new Date(yahoo.asOf).getTime()
  // 不正な ISO は "より古い" 扱い: 有効な側があればそちらを採用、両方
  // 不正なら webull にタイブレーク (既存挙動維持)。`y > w` だけだと
  // w=NaN の時に false 評価で不正な webull を選んでしまう回帰がある。
  const wValid = Number.isFinite(w)
  const yValid = Number.isFinite(y)
  const pickYahoo = yValid && (!wValid || y > w)
  return pickYahoo
    ? { price: yahoo.price, source: 'yahoo-bars', asOf: yahoo.asOf }
    : { price: webull.price, source: webull.source, asOf: webull.asOf }
}

function positionsBody(
  rows: Array<{ sym: string; state: SymbolState | null; error: string | null }>,
  strategyPriceMap: Map<string, { price: number; asOf: string }>,
  universe?: SymbolUniverse | null,
): string {
  if (rows.length === 0) return `<p class="muted">有効な銘柄がありません。</p>`
  const tbody = rows
    .map((r) => {
      const inactive = isSymbolInactive(r.sym, universe)
      const rowClass = inactive ? ' class="symbol-disabled-row"' : ''
      const symbolClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(inactiveTooltip(r.sym, universe))}"` : ''
      if (r.error !== null || r.state === null) {
        return `<tr${rowClass}><td><span${symbolClass}${titleAttr}>${esc(displaySymbol(r.sym, universe))}</span></td><td colspan="7" class="err">${esc(r.error ?? '状態取得不可')}</td></tr>`
      }
      const s = r.state
      const pos = s.position
      const webull = s.lastQuote
        ? { price: s.lastQuote.price, source: s.lastQuote.source, asOf: s.lastQuote.asOf ?? s.lastQuote.fetchedAt }
        : null
      const yahoo = strategyPriceMap.get(s.symbol) ?? null
      const quote = pickFreshQuote(webull, yahoo)
      const pendingSide = s.pendingOrder?.side
      const pnlPct =
        pos !== null && quote !== null && pos.avgPrice > 0
          ? ((quote.price - pos.avgPrice) / pos.avgPrice) * 100
          : null
      const pnlClass = pnlPct === null ? 'muted' : pnlPct >= 0 ? 'ok' : 'err'
      const quoteCell = quote
        ? `${fmtNumber(quote.price, 2)} <span class="muted" style="font-size:11px">(${esc(quote.source)}, ${esc(formatQuoteAsOf(quote.asOf))})</span>`
        : '<span class="muted">—</span>'
      return `<tr${rowClass}>
        <td><strong><span${symbolClass}${titleAttr}>${esc(displaySymbol(s.symbol, universe))}</span></strong></td>
        <td>${pos ? esc(pos.qty) : '<span class="muted">—</span>'}</td>
        <td>${pos ? fmtNumber(pos.avgPrice, 2) : '<span class="muted">—</span>'}</td>
        <td>${quoteCell}</td>
        <td class="${pnlClass}">${pnlPct === null ? '—' : fmtNumber(pnlPct, 2) + '%'}</td>
        <td>${pendingSide ? esc(pendingSide) : '<span class="muted">—</span>'}</td>
        <td>${formatCooldown(s.cooldownUntil)}</td>
        <td class="muted">${esc(fmtJst(s.updatedAt))}</td>
      </tr>`
    })
    .join('')
  return `<p class="muted" style="font-size:12px">
    評価損益は未実現 (現在値 vs 平均取得単価)。実約定損益は
    <a href="/dashboard/cron">/dashboard/cron</a> 「実 損益」列を参照。
  </p>
  <table>
    <thead><tr>
      <th>銘柄</th><th>数量</th><th>平均取得単価</th><th>現在値 (source, asOf)</th><th>評価損益</th>
      <th>未約定</th><th>クールダウン</th><th>更新時刻</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function portfolioBody(p: {
  dailyStartEquity: number
  dailyRealizedPnl: number
  tradingDisabledUntil: string | null
  lastRolledAt?: string | null
  updatedAt: string
}, vixRegime: VixRegime | null, equity?: {
  snapshots: PortfolioEquitySnapshotRow[]
  range: EquityRange
}): string {
  const drawdownPct =
    p.dailyStartEquity > 0 ? (p.dailyRealizedPnl / p.dailyStartEquity) * 100 : null
  const ddClass = drawdownPct === null ? 'muted' : drawdownPct >= 0 ? 'ok' : 'err'
  const kill = p.tradingDisabledUntil
  const lastRolledCell = renderLastRolledCell(p.lastRolledAt ?? null)
  const vixCell = renderVixRegimeCell(vixRegime)
  const summaryTable = `<table>
    <tbody>
      <tr><th>当日始値資産 (dailyStartEquity)</th><td>${fmtNumber(p.dailyStartEquity, 2)}</td></tr>
      <tr><th>当日実現損益 (dailyRealizedPnl)</th><td class="${ddClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</td></tr>
      <tr><th>ドローダウン (drawdown)</th><td class="${ddClass}">${drawdownPct === null ? '—' : fmtNumber(drawdownPct, 2) + '%'}</td></tr>
      <tr><th>取引停止解除時刻 (tradingDisabledUntil)</th><td>${kill ? `<span class="warn">${esc(fmtJst(kill))}</span>` : '<span class="ok">稼働中</span>'}</td></tr>
      <tr><th>VIX レジーム (vixRegime)</th><td>${vixCell}</td></tr>
      <tr><th>EOD ロールオーバー実行時刻 (lastRolledAt)</th><td>${lastRolledCell}</td></tr>
      <tr><th>更新時刻 (updatedAt)</th><td class="muted">${esc(fmtJst(p.updatedAt))}</td></tr>
    </tbody>
  </table>`
  const chartSection = equity ? renderPortfolioEquityChart(equity.snapshots, equity.range) : ''
  return summaryTable + chartSection
}

/**
 * `?range=30d|90d|365d|all` の解釈。default は 90d (3 ヶ月で trend が読める粒度)。
 * 不正値は default に倒す。`all` は cap 内 (3650 件) で全件返し。
 */
export type EquityRange = '30d' | '90d' | '365d' | 'all'

export function parseEquityRange(value: string | undefined): EquityRange {
  if (value === '30d' || value === '90d' || value === '365d' || value === 'all') return value
  return '90d'
}

function equityRangeLimit(range: EquityRange): number {
  if (range === '30d') return 30
  if (range === '90d') return 90
  if (range === '365d') return 365
  return 3650
}

/**
 * `loadPortfolioEquitySnapshots` を try/catch で wrap。table 未 migration や
 * D1 エラー時は空配列で fallback → ページ自体は描画。チャート枠は "データ無し"
 * メッセージに置き換わる。
 */
async function safeLoadPortfolioSnapshots(
  db: D1Database,
  range: EquityRange,
): Promise<PortfolioEquitySnapshotRow[]> {
  const opts: LoadPortfolioEquitySnapshotOptions = { limit: equityRangeLimit(range) }
  try {
    return await loadPortfolioEquitySnapshots(db, opts)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'portfolio_equity_snapshot_load_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return []
  }
}

/**
 * `/dashboard/portfolio` の総資産チャート。echarts inline JS で USD / JPY の
 * 2 ライン (片方 NULL は skip)。
 *
 * - X: snapshotAt の日付部分 (UTC date)
 * - Y: dailyStartEquity (通貨別)
 * - range tab で 30d / 90d / 365d / all 切替 (URL `?range=` を維持)
 */
function renderPortfolioEquityChart(
  snapshots: PortfolioEquitySnapshotRow[],
  range: EquityRange,
  basePath = '/dashboard/portfolio',
): string {
  const rangeTabs = renderEquityRangeTabs(range, basePath)
  if (snapshots.length === 0) {
    return `<h3 style="margin-top:24px">総資産チャート</h3>
    ${rangeTabs}
    <p class="muted">まだ roll-daily 実行履歴がありません。<code>/admin/portfolio/roll-daily</code> を実行すると、ここに時系列が描画されます。</p>`
  }
  const usdPoints: Array<{ date: string; value: number | null }> = []
  const jpyPoints: Array<{ date: string; value: number | null }> = []
  let hasUsd = false
  let hasJpy = false
  for (const row of snapshots) {
    const date = (row.snapshotAt ?? '').slice(0, 10)
    const usd =
      typeof row.dailyStartEquityUsd === 'number' && Number.isFinite(row.dailyStartEquityUsd)
        ? row.dailyStartEquityUsd
        : null
    const jpy =
      typeof row.dailyStartEquityJpy === 'number' && Number.isFinite(row.dailyStartEquityJpy)
        ? row.dailyStartEquityJpy
        : null
    if (usd !== null) hasUsd = true
    if (jpy !== null) hasJpy = true
    usdPoints.push({ date, value: usd })
    jpyPoints.push({ date, value: jpy })
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__equityChartData;
      var dates = data.usd.map(function (p) { return p.date; });
      var series = [];
      if (data.hasUsd) {
        series.push({
          name: 'USD',
          type: 'line',
          data: data.usd.map(function (p) { return p.value; }),
          connectNulls: false,
          smooth: false,
          lineStyle: { width: 2, color: '#1471a8' },
          itemStyle: { color: '#1471a8' },
        });
      }
      if (data.hasJpy) {
        series.push({
          name: 'JPY',
          type: 'line',
          yAxisIndex: data.hasUsd ? 1 : 0,
          data: data.jpy.map(function (p) { return p.value; }),
          connectNulls: false,
          smooth: false,
          lineStyle: { width: 2, color: '#b25000' },
          itemStyle: { color: '#b25000' },
        });
      }
      var yAxis = [{ type: 'value', name: 'USD', axisLabel: { formatter: '{value}' } }];
      if (data.hasUsd && data.hasJpy) {
        yAxis.push({ type: 'value', name: 'JPY', axisLabel: { formatter: '{value}' } });
      } else if (!data.hasUsd && data.hasJpy) {
        yAxis = [{ type: 'value', name: 'JPY', axisLabel: { formatter: '{value}' } }];
      }
      var chart = echarts.init(document.getElementById('portfolio-equity-chart'));
      chart.setOption({
        title: { text: '総資産 (dailyStartEquity) 時系列', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return v == null ? '—' : Number(v).toFixed(2); } },
        legend: { top: 24 },
        grid: { left: 60, right: 60, top: 60, bottom: 40 },
        xAxis: { type: 'category', data: dates },
        yAxis: yAxis,
        series: series,
      });
      window.addEventListener('resize', function () { chart.resize(); });
    });
  `
  return `<h3 style="margin-top:24px">総資産チャート</h3>
  ${rangeTabs}
  <p class="muted" style="font-size:12px">
    <code>PortfolioStateDO.dailyStartEquity</code> の roll-daily 時点スナップショット。
    <code>/dashboard/charts?tab=overview</code> は <code>trade_journal.realized_pnl</code> の
    累積で、こちらは口座総資産そのもの (cash + 保有時価)。USD / JPY を別軸でプロット。
  </p>
  <div id="portfolio-equity-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${safeJsonScript('__equityChartData', { usd: usdPoints, jpy: jpyPoints, hasUsd, hasJpy })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

function renderEquityRangeTabs(active: EquityRange, basePath = '/dashboard/portfolio'): string {
  const options: Array<{ id: EquityRange; label: string }> = [
    { id: '30d', label: '30 日' },
    { id: '90d', label: '90 日' },
    { id: '365d', label: '365 日' },
    { id: 'all', label: '全期間' },
  ]
  const links = options
    .map((opt) => {
      const cls = opt.id === active ? 'tab tab-active' : 'tab'
      return `<a class="${cls}" href="${basePath}?range=${opt.id}">${opt.label}</a>`
    })
    .join(' ')
  return `<div class="tab-strip" style="margin-top:12px">${links}</div>`
}

/**
 * VIX regime snapshot を bage 風に表示 (issue #196 3/3)。
 *
 *   - normal:   緑 (size 1.0、通常運用)
 *   - warning:  黄 (size 0.5、新規 BUY 縮小)
 *   - critical: 赤 (新規 BUY 全停止 / SELL は通常)
 *   - null:     灰 (snapshot 未生成、初回 cron tick 前 or DB 未配線)
 *
 * VIX 値そのものは snapshot table に持たないので regime ラベルのみ表示。
 * 値が必要なら strategy_decision_log の VIX reject reason を見る運用 (POC)。
 */
export function renderVixRegimeCell(regime: VixRegime | null): string {
  if (regime === null) {
    return `<span class="muted">— (cron 未到達 or DB 未配線、fail-open で通常運用)</span>`
  }
  if (regime === 'critical') {
    return `<span class="err">critical — 新規買い停止 (売却は通常)</span>`
  }
  if (regime === 'warning') {
    return `<span class="warn">warning — 新規買いを縮小 (size scale 適用)</span>`
  }
  return `<span class="ok">normal — 通常運用</span>`
}

/**
 * Issue #140: `lastRolledAt` の経過時間で badge 色を切替。
 *  - null:       未実行 (muted)
 *  - <24h:       OK (ok)
 *  - 24h–48h:    warning (warn)
 *  - >=48h:      error  (err)
 *
 * EOD cron は毎日 22:00 UTC に走るので 24h 以内なら正常、48h 超は **2 日連続
 * miss** で要調査。閾値は `runStrategyCron.emitStaleRollWarningIfNeeded` の
 * 24h と一貫させている。
 */
export function renderLastRolledCell(
  lastRolledAt: string | null,
  now: () => number = Date.now,
): string {
  if (lastRolledAt === null) {
    return `<span class="warn">未実行 (EOD cron 未到達 or PORTFOLIO_STATE 未配線)</span>`
  }
  const ms = new Date(lastRolledAt).getTime()
  if (!Number.isFinite(ms)) {
    return `<span class="err">${esc(lastRolledAt)} (parse 不能)</span>`
  }
  const elapsedHours = (now() - ms) / 3_600_000
  const formatted = esc(fmtJst(lastRolledAt))
  const elapsedLabel = `${elapsedHours.toFixed(1)}h 前`
  if (elapsedHours >= 48) {
    return `<span class="err">${formatted} <small>(${esc(elapsedLabel)}, 48h 超 — EOD cron 要確認)</small></span>`
  }
  if (elapsedHours >= 24) {
    return `<span class="warn">${formatted} <small>(${esc(elapsedLabel)}, 24h 超)</small></span>`
  }
  return `<span class="ok">${formatted} <small class="muted">(${esc(elapsedLabel)})</small></span>`
}

function tradesBody(
  rows: Array<{
    id: number
    timestamp: string
    tradeEventType: string
    symbol: string | null
    side: string | null
    quantity: number | null
    limitPrice: number | null
    filledQty: number | null
    filledPrice: number | null
    brokerStatus: string | null
    mode: string | null
    errorMessage: string | null
  }>,
  limit: number,
  universe?: SymbolUniverse | null,
): string {
  if (rows.length === 0) {
    return `<p class="muted">trade_journal にレコードがありません (limit=${limit})。</p>`
  }
  const tbody = rows
    .map((r) => {
      const statusClass =
        r.errorMessage
          ? 'err'
          : r.brokerStatus === 'FILLED'
            ? 'ok'
            : r.brokerStatus
              ? 'warn'
              : 'muted'
      // status セルは enum 値 (FILLED/CANCELED 等) は英字のまま、error は
      // "エラー: " を和訳 prefix。運用者が grep / broker API と突き合わせ
      // しやすい粒度を保つ。
      const statusText =
        r.errorMessage ? `エラー: ${r.errorMessage}` : r.brokerStatus ?? r.tradeEventType
      const symbolText = r.symbol ? displaySymbol(r.symbol, universe) : '—'
      const inactive = r.symbol ? isSymbolInactive(r.symbol, universe) : false
      const symbolCellInner = r.symbol && inactive
        ? `<span class="symbol-disabled" title="${esc(inactiveTooltip(r.symbol, universe))}">${esc(symbolText)}</span>`
        : esc(symbolText)
      return `<tr>
        <td>${r.id}</td>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td>${esc(r.tradeEventType)}</td>
        <td><strong>${symbolCellInner}</strong></td>
        <td>${esc(r.side ?? '—')}</td>
        <td>${r.quantity === null ? '—' : esc(r.quantity)}</td>
        <td>${r.limitPrice === null ? '—' : fmtNumber(r.limitPrice, 2)}</td>
        <td>${r.filledQty === null ? '—' : esc(r.filledQty)}</td>
        <td>${r.filledPrice === null ? '—' : fmtNumber(r.filledPrice, 2)}</td>
        <td class="${statusClass}">${esc(statusText)}</td>
        <td>${esc(r.mode ?? '—')}</td>
      </tr>`
    })
    .join('')
  return `<p class="muted">直近 ${rows.length} 件 (limit=${limit}、最大 200)。</p>
  <table>
    <thead><tr>
      <th>ID</th><th>日時</th><th>イベント</th><th>銘柄</th><th>売買</th>
      <th>数量</th><th>指値</th><th>約定数量</th><th>約定単価</th><th>状態</th><th>モード</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function configBody(
  global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>,
  universe: Awaited<ReturnType<typeof loadSymbolUniverse>>,
  overviewPanels: Set<OverviewPanel>,
): string {
  // #dashboard-mf-layout: overview パネル ON/OFF。POST → PRG redirect (#293 と同型)。
  const panelForm = `<details open>
    <summary>ダッシュボード overview パネル表示</summary>
    <form method="post" action="/dashboard/config/overview-panels" style="margin:8px 0;display:flex;flex-direction:column;gap:6px;max-width:560px">
      ${ALL_OVERVIEW_PANELS.map((k) => `<label style="font-size:13px"><input type="checkbox" name="panels" value="${k}"${overviewPanels.has(k) ? ' checked' : ''}/> ${esc(OVERVIEW_PANEL_LABELS[k])}</label>`).join('')}
      <div><button type="submit" style="padding:4px 12px;font-size:13px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer">保存</button></div>
    </form>
    <p class="muted" style="font-size:12px"><code>/dashboard</code> の overview に表示するパネル。全て OFF にすると全表示に戻ります。</p>
  </details>`
  // 列名 (snake_case) は SQL での copy-paste 互換のため英字のまま残し、
  // 日本語説明は別列に分離。これで `UPDATE global_config SET xxx = ...` が
  // そのまま使える。
  const globalRows = Object.entries(global as unknown as Record<string, unknown>)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => {
      const camelKey = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
      // DB 列名の digit 前 underscore は列ごとに揺れがある
      // (min_return_50d は有 / require_above_sma50 は無)。
      // naive 版 → digit 前 underscore 版の順でフォールバック。
      const camelKeyWithDigitUnderscore = camelKey.replace(/([a-z])(\d)/g, '$1_$2')
      const meta =
        CONFIG_KEY_META[camelKey] ??
        CONFIG_KEY_META[camelKeyWithDigitUnderscore] ??
        CONFIG_KEY_META[k]
      const label = meta?.label ?? '—'
      const detail = meta?.detail ?? '—'
      return `<tr><th>${esc(camelKey)}</th><td>${esc(formatConfigValue(v))}</td><td class="muted">${esc(label)}</td><td class="muted" style="font-size:11px">${esc(detail)}</td></tr>`
    })
    .join('')
  // active + inactive 両方を 1 つの table で表示。inactive 行は grayed-out 化し、
  // 「状態」「メモ (notes)」列で disable 経緯が読める。cron 評価対象は active=1 のみ
  // (allowedSymbols)、表示のみ全件出すのが今 PR の趣旨。
  const allConfigSymbols = [...universe.allowedSymbols, ...universe.inactiveSymbols]
  const symRows = allConfigSymbols
    .map((sym) => {
      const inactive = isSymbolInactive(sym, universe)
      const rowClass = inactive ? ' class="symbol-disabled-row"' : ''
      const symbolClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(inactiveTooltip(sym, universe))}"` : ''
      const stateCell = inactive
        ? '<span class="muted">inactive</span>'
        : '<span class="ok">active</span>'
      const noteText = universe.symbolNotes[sym] ?? null
      const noteCell = noteText ? esc(noteText) : '<span class="muted">—</span>'
      return `<tr${rowClass}>
          <td><strong><span${symbolClass}${titleAttr}>${esc(displaySymbol(sym, universe))}</span></strong></td>
          <td>${stateCell}</td>
          <td>${esc(universe.symbolCurrency[sym] ?? '—')}</td>
          <td>${universe.symbolMaxNotional[sym] != null ? esc(universe.symbolMaxNotional[sym]) : '<span class="muted">—</span>'}</td>
          <td>${universe.inversePairs[sym] ? esc(universe.inversePairs[sym]) : '<span class="muted">—</span>'}</td>
          <td>${noteCell}</td>
        </tr>`
    })
    .join('')
  return `${panelForm}
  <details open>
    <summary>グローバル設定 (global_config)</summary>
    <table>
      <thead><tr><th>Key</th><th>値</th><th>説明</th><th>詳細</th></tr></thead>
      <tbody>${globalRows}</tbody>
    </table>
  </details>
  <details open>
    <summary>銘柄別設定 (symbol_config) — active ${universe.allowedSymbols.length} / inactive ${universe.inactiveSymbols.length} 銘柄</summary>
    <p class="muted" style="font-size:12px">
      inactive (active=0) 銘柄も表示しています。cron / risk gate の評価対象は active=1 のみで、
      inactive 銘柄は灰色斜体・取消線で区別しています。再有効化は <code>UPDATE symbol_config SET active = 1 WHERE symbol = '...'</code>。
    </p>
    <table>
      <thead><tr><th>銘柄</th><th>状態</th><th>通貨</th><th>1注文あたり上限 (max_notional)</th><th>インバース対 (inverse)</th><th>メモ (notes)</th></tr></thead>
      <tbody>${symRows}</tbody>
    </table>
  </details>`
}

/**
 * global_config 列のメタ情報 (label + detail)。
 *
 * - `label`: 短い見出し (単位込み)。IT / 汎用英単語 (dry-run / drawdown / spread
 *   等) は英字のまま、日本株固有語 (押し目 / 建玉 / 利食い / 損切り / 騰落率)
 *   のみ日本語化。
 * - `detail`: 株初心者向け advisory。1-3 文、「何をするか」「大小で何が変わるか」
 *   「目安」の順で記述。技術用語を避け具体的な動作で説明。
 *
 * 未登録 key の fallback は em-dash。
 */
interface ConfigKeyMeta {
  label: string
  detail: string
}

const CONFIG_KEY_META: Record<string, ConfigKeyMeta> = {
  dry_run: {
    label: 'dry-run (bool)',
    detail: 'true にすると実際には注文せず動作確認だけ。false で証券会社へ本当に注文します。テスト中は true、本番のみ false に。',
  },
  trading_enabled: {
    label: 'trading enabled (bool)',
    detail: 'false にすると全ての注文を拒否します。緊急停止用のスイッチ。止めたい時だけ false に。',
  },
  market_hours_check: {
    label: '場中チェック (bool)',
    detail: 'true で市場時間外の注文を防ぎます。false は 24 時間発注可 (sandbox 確認用)。',
  },
  max_order_notional: {
    label: '1注文上限 (非推奨)',
    detail: '旧 generic 上限 (通貨別 cap 導入前の互換)。現在は参照されないので触らなくて OK。',
  },
  max_order_notional_usd: {
    label: '1注文上限 (USD)',
    detail: 'US 株 1 回あたりの発注上限額 (ドル)。大きすぎる注文を防ぐ安全装置。$2000 なら 1 銘柄最大 $2000 まで。',
  },
  max_order_notional_jpy: {
    label: '1注文上限 (JPY)',
    detail: '日本株 1 回あたりの発注上限額 (円)。同上の円版。¥100000 なら 1 銘柄最大 10 万円まで。',
  },
  total_capital_usd: {
    label: '運用資本 (USD)',
    detail:
      'risk-% sizing (stop 距離ベース) の US 株 equity 基準 (ドル)。budget配分% (budget_alloc_pct) 指定銘柄は通貨に関係なく total_capital_jpy 単一プールを使うため、こちらは不要 (USD risk-% 銘柄がある時のみ設定)。',
  },
  total_capital_jpy: {
    label: '運用資本 (JPY / 口座総額)',
    detail:
      '口座の運用資本 (円)。budget配分% (budget_alloc_pct) 指定銘柄は通貨に関係なく **この円総額が単一プール基準** (USD 銘柄も USD/JPY で円換算して sizing、#407)。risk-% sizing の日本株 equity 基準も兼ねる。買付余力 pool ゲートの円換算基準でもある (#415)。',
  },
  max_portfolio_exposure_pct: {
    label: 'portfolio exposure 上限率 (比率)',
    detail: '同時保有の合計上限を「資本 × この率」で決めます。0.6 なら 60%。大きくすると分散度↑、損失時の衝撃↑。',
  },
  drawdown_kill_threshold: {
    label: 'drawdown kill 閾値 (比率、負)',
    detail: 'その日の損失がこの割合を超えたら、その日は新規売買を止めます。きつく -2% だと早く止まる、緩く -8% だと下げを我慢して継続。',
  },
  stale_quote_ms: {
    label: '気配値鮮度上限 (ms)',
    detail: '気配値が古すぎる時に判定を止める閾値。900000 = 15 分。短いと厳格、長いと古い気配でも売買。',
  },
  gap_reject_pct: {
    label: 'gap reject 閾値 (比率)',
    detail: '前日終値からの寄付 gap がこの率を超えた銘柄は買わない。0.03 = 3% 以上の gap で見送り。寄付の高値掴みを防ぐ。',
  },
  spread_limit_pct_us: {
    label: 'spread 上限率 (US、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。US は 0.25% 目安。',
  },
  spread_limit_pct_jp: {
    label: 'spread 上限率 (JP、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。日本株は 0.6% 目安。',
  },
  pullback_default_stop_pct: {
    label: '損切り幅 (比率、負)',
    detail: '損切りライン。買値からこの率下がったら売却。-0.04 = -4%。深いと耐えるが大損失リスク、浅いと早く切るが騙し上げで空振り。',
  },
  pullback_default_take_profit_pct: {
    label: '利食い目標 (比率)',
    detail: '利食い目標。買値からこの率上がったら売却。0.07 = +7%。高いと大きな利益を狙うが取り逃す、低いとコツコツ確定。',
  },
  pullback_default_time_stop_days: {
    label: '最大保有日数 (営業日)',
    detail: '建玉を保有する最大日数。この日数を超えても利食い/損切りに達しなければ強制売却。10 = 約 2 週間。',
  },
  pullback_default_pullback_max: {
    label: '押し目上限 (比率、負)',
    detail: '押し目買いを狙う「浅い側」の下落率閾値。-0.03 なら「-3% 以上下げた銘柄を候補に」。緩めると機会↑、騙し↑。',
  },
  pullback_default_pullback_min: {
    label: '押し目下限 (比率、負)',
    detail: '押し目買いを狙う「深い側」の下落率閾値。-0.06 なら「-6% より深い下げは敬遠」。深すぎる下げは反発せず転換の可能性。',
  },
  pullback_default_min_return_50d: {
    label: '50日最低騰落率 (比率)',
    detail: '過去 50 日の騰落率がこの値以上の銘柄だけ押し目買い対象。0.08 = +8%。上昇トレンド銘柄を絞るフィルター。',
  },
  pullback_default_require_above_sma50: {
    label: 'SMA50 超必須 (bool)',
    detail: 'true で 50 日移動平均線より上の銘柄だけ買い対象。上昇トレンドフィルターを厳しくする。',
  },
  pullback_default_k_atr: {
    label: 'ATR 倍率',
    detail: '損切り幅を ATR (日々の値動き幅) の何倍にするか。2.0 が標準。大きくすると激しい値動き銘柄でも余裕を持って保有、小さいと早めに損切り。',
  },
  pullback_default_max_sma50_deviation_pct: {
    label: '過熱ガード: SMA50 上方乖離上限 (比率)',
    detail: '株価が 50 日移動平均をこの比率超で上回る過熱局面では押し目買いを見送る。0.6 = +60%。+3x レバ ETF の高値掴み回避。小さいほど厳しく BUY を抑制。',
  },
  pullback_default_max_atr_ratio: {
    label: '過熱ガード: ATR比上限 (倍)',
    detail: '直近 ATR が baseline (長期平均) のこの倍率を超える高ボラ局面では押し目買いを見送る。1.5 = baseline の 1.5 倍。ボラ・レジーム破綻時の entry を抑制。',
  },
  risk_base_per_trade_pct: {
    label: '基本リスク率 (比率)',
    detail: '1 回のトレードで失ってよい割合 (対 総資本)。0.004 = 0.4%。大きくすると 1 回あたりの建玉サイズ↑、連敗時の損失↑。',
  },
  risk_dd_half_threshold: {
    label: 'risk half 閾値 (比率、負)',
    detail: '日次損失がこの率を超えたら 1 回のリスクを半分に減らす。-0.05 = -5%。連敗時の傷を浅く保つ自動ブレーキ。',
  },
  risk_dd_halt_threshold: {
    label: 'risk halt 閾値 (比率、負)',
    detail: '日次損失がこの率を超えたら 1 回のリスクを 0 に (新規 entry 停止)。-0.10 = -10%。drawdown_kill より前の緊急ブレーキ。',
  },
  vix_warning_threshold: {
    label: 'VIX 警戒閾値',
    detail: '恐怖指数 (VIX) がこの値を超えたら新規買いの数量を縮小。25 が標準。下げると早めに用心、上げると VIX 高でも普段通り。',
  },
  vix_critical_threshold: {
    label: 'VIX 緊急閾値',
    detail: '恐怖指数 (VIX) がこの値を超えたら新規買いを全停止 (売却は通常通り)。30 が標準。下げると守り重視、上げると荒れ相場でも買いに行く。',
  },
  vix_warning_size_scale: {
    label: 'VIX 警戒時の建玉縮小率 (比率)',
    detail: 'VIX 警戒時 (warning ≤ VIX < critical) の発注数量倍率。0.5 = 半分に縮小。1.0 で縮小なし、0 で停止と同義。',
  },
}

/**
 * cooldownUntil をポートフォリオテーブル向けに整形。null または past timestamp
 * (admin /clear-cooldown で epoch 0 が書き込まれた状態等) は「解除済」
 * 扱いで em-dash を返す。strategy 側の `cooldownUntil > now` 判定と表示を
 * 整合させ、"1970-01-01 09:00:00 JST" がクールダウン列に残るように見える
 * 不具合を解消する (#145 admin clear-cooldown の副作用)。
 */
function formatCooldown(cooldownUntil: string | null): string {
  if (!cooldownUntil) return '<span class="muted">—</span>'
  const ms = new Date(cooldownUntil).getTime()
  if (!Number.isFinite(ms) || ms <= Date.now()) {
    return '<span class="muted">—</span>'
  }
  return `<span class="warn">${esc(fmtJst(cooldownUntil))}</span>`
}

/**
 * QuoteSnapshot.asOf (ISO) を JST の絶対表記 `MM/DD HH:MM JST` に。
 * 相対表記 (NN日前) は週末・場外で必ず古く見えてしまい「壊れている風」に
 * 誤読されやすいため、絶対時刻を出して「金曜引け」と一目で分かるようにする。
 */
export function formatQuoteAsOf(asOf: string): string {
  const d = new Date(asOf)
  if (!Number.isFinite(d.getTime())) return '?'
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')} ${pick('hour')}:${pick('minute')} JST`
}

function formatConfigValue(v: unknown): string {
  // null placeholder は他ページと同じ em-dash (—) に統一。"null" 文字列は
  // 運用者が誤って "null" という string 値と混同するリスクがあるので避ける。
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/**
 * Numeric string ratio → 符号付き % 表記 (0.0108 → "+1.08%"、-0.04 → "-4.00%")。
 * fallback は原文字列 (数値 parse 失敗時は canonical な reason を見せる方が安全)。
 */
function fmtPct(s: string): string {
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  const pct = n * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

/**
 * Strategy / sizing が出力する英語 reason を **初心者にも分かる日本語** に翻訳
 * する display helper。ログ DB は英語 canonical のまま、表示層でのみ翻訳
 * (tests / journal の契約に影響させない)。
 *
 * 統一テンプレ: `[判定ラベル]: [事実] ([具体値])`
 *
 * 判定ラベル (10 種):
 *   - 保有前の評価系 4 種: 様子見 / 買い / 発注中 / データ不足
 *   - 保有中の exit 系 4 種: 利食い / 損切り / 時間切れ / 保有継続
 *   - 発注拒否系 2 種: 発注スキップ (pre-submit) / 発注エラー (broker 拒否)
 *
 * `発注スキップ` は sizing / 同グループ建玉上限 / 売買単位未満などで
 * **注文送出前** に止めた場合。`発注エラー` は broker に送ったが拒否された
 * 場合 (broker submit error) — 原因が手元か相手方かを区別するため別ラベル。
 *
 * trading-strategist review に基づき、日本株・信用取引の伝統語 (押し目 /
 * 含み損益 / 建玉 / 単元 / 移動平均線割れ / 日柄 / 手仕舞い / 騰落率 / ロスカット
 * 派生の損切りライン) と証券アプリ準拠の英字 (SMA50, ATR) を混在。
 */
export function localizeReason(en: string | null | undefined): string {
  if (!en) return '-'
  let s = en

  // === 発注中 / 取引停止 (entry 前ガード) ===
  s = s.replace(/^pending order in flight$/, '発注中: 直前注文の約定待ち')
  // cooldown の timestamp は UTC ISO で emit されるが operator 向けには JST 表記が
  // 読みやすい。fmtJst は parse 失敗時に原文字列を返すので安全 (CodeRabbit)。
  s = s.replace(
    /^cooldown active until (.+)$/,
    (_m, ts) => `様子見: 取引停止中 (${fmtJst(ts)} まで)`,
  )
  s = s.replace(/^pending order already in flight$/, '発注中: 同銘柄の注文処理中')

  // === 保有中の exit 判定 ===
  // 「含み益/含み損」= 未実現損益の日本株標準語。strategy.ts の pnlPct は
  // (現値 - 取得価格)/取得価格 で未実現なのでこちらを採用。
  s = s.replace(
    /^take-profit hit: pnl (\S+) >= (\S+)$/,
    (_m, p, t) => `利食い: 利確目標到達 (含み損益 ${fmtPct(p)} ≥ 目標 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^stop-loss hit: pnl (\S+) <= (\S+)$/,
    (_m, p, t) => `損切り: 損切りライン到達 (含み損益 ${fmtPct(p)} ≤ ライン ${fmtPct(t)})`,
  )
  s = s.replace(
    /^time-stop hit: held (\S+) >= (\S+)$/,
    '時間切れ: 保有期限到達 (保有 $1 ≥ 上限 $2)',
  )
  s = s.replace(
    /^holding: pnl (\S+) within \(([^,]+),\s*([^)]+)\)$/,
    (_m, p, low, high) =>
      `保有継続: 含み損益 ${fmtPct(p)} (利食い ${fmtPct(high)} / 損切り ${fmtPct(low)} の範囲内)`,
  )

  // === 未保有の entry 判定 (様子見) ===
  // 「移動平均線割れ」は日本株の慣用表現。
  // #318: trend filter の reason は `20d return ...`、historical decision_log
  // 行は `50d return ...` (#318 前) を含むので両方を受ける。
  s = s.replace(
    /^(?:20d|50d) return (\S+) <= (\S+) trend threshold$/,
    (_m, r, t) =>
      `様子見: 上昇トレンド未成立 (騰落率 ${fmtPct(r)} ≤ 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^price (\S+) <= sma50 (\S+)$/,
    '様子見: 50日移動平均線割れ (株価 $1 ≤ 移動平均 $2)',
  )
  // #318: invalid high reason も新旧両形式を受ける。
  s = s.replace(/^invalid (?:10d|20d) high$/, 'データ不足: 直近高値を算出できず')
  s = s.replace(
    /^pullback (\S+) > (\S+) \(not deep enough\)$/,
    (_m, p, t) => `様子見: 押し目が浅い (下落率 ${fmtPct(p)} > 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^pullback (\S+) < (\S+) \(too deep\)$/,
    (_m, p, t) =>
      `様子見: 押し目が深すぎる/下落転換懸念 (下落率 ${fmtPct(p)} < 許容 ${fmtPct(t)})`,
  )
  // #strategy-overextension-guards: 過熱 / ボラ過熱 ガード。
  s = s.replace(
    /^sma50 deviation (\S+) > (\S+) \(overextended\)$/,
    (_m, d, t) => `様子見: 過熱 (移動平均からの上方乖離 ${fmtPct(d)} > 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^atr ratio (\S+) > (\S+) \(volatility elevated\)$/,
    (_m, r, t) => `様子見: ボラ過熱 (ATR比 ${r}倍 > 条件 ${t}倍)`,
  )

  // === BUY signal (押し目買い成立) ===
  // #318: BUY reason は `20d return ...`、historical 行 (`50d return ...`) も受ける。
  s = s.replace(
    /^pullback (\S+) in uptrend \((?:20d|50d) return (\S+)\)$/,
    (_m, p, r) =>
      `買い: 上昇トレンド中の押し目買い (下落率 ${fmtPct(p)}、騰落率 ${fmtPct(r)})`,
  )

  // === Sizing 系 reject (発注スキップ) ===
  // 「建玉可」= risk 予算で保有可能な建玉数 (信用取引等での "許容建玉" 用法)
  s = s.replace(
    /^sizing rejected: lot-size-round \(raw qty (\S+) < lot (\S+), stop (\S+), entry (\S+)\)$/,
    '発注スキップ: 売買単位未満 (建玉可 $1 株 < 1単元 $2 株、損切り幅 $3/株、株価 $4)',
  )
  s = s.replace(
    /^sizing rejected: insufficient-risk-budget \(budget (\S+)\)$/,
    '発注スキップ: リスク予算枯渇 (残 $1)',
  )
  s = s.replace(/^sizing rejected: atr-floor$/, '発注スキップ: ボラティリティ低下 (ATR 下限割れ)')
  s = s.replace(/^sizing rejected: symbol-cap$/, '発注スキップ: 銘柄別投資上限超過')
  s = s.replace(
    /^sizing rejected: invalid-stop \(stopDistance (\S+)\)$/,
    '発注スキップ: 損切り幅が算出不能 ($1)',
  )
  s = s.replace(/^sizing rejected: zero qty$/, '発注スキップ: 発注株数が 0')

  // === Scheduler inline ===
  s = s.replace(/^SELL without position$/, '発注スキップ: 手仕舞い対象の建玉なし')
  s = s.replace(/^insufficient bars for indicators$/, 'データ不足: 指標計算に必要な日柄不足')
  s = s.replace(/^invalid price: (\S+)$/, 'データ不足: 株価が無効 ($1)')
  s = s.replace(/^invalid notional:/, 'データ不足: 発注金額が無効:')
  s = s.replace(/^invalid position qty: (\S+)$/, 'データ不足: 建玉数が無効 ($1)')
  s = s.replace(/^invalid expiresAt/, 'データ不足: 注文有効期限が無効')
  s = s.replace(/^bar fetch: /, 'データ不足: 日足取得失敗 — ')
  s = s.replace(/^broker submit error: /, '発注エラー: 証券会社側で拒否 — ')

  return s
}

/**
 * `?limit=N` を 1〜500 の範囲に丸める。`/dashboard/alerts` 専用 (cron 系の
 * `clampLimit` は既定 50 / max 200 で別ロール)。
 */
function clampAlertLimit(raw: string | undefined): number {
  const n = raw === undefined ? 100 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(n, 500)
}

/**
 * `c.req.url` から `URLSearchParams` を取り出す。filter pill が他の query
 * (例: `limit=500`) を保持するために使う (CodeRabbit #210)。
 *
 * URL 構築失敗時は空 URLSearchParams にフォールバック。
 */
function parseAlertsQuery(rawUrl: string): URLSearchParams {
  try {
    return new URL(rawUrl).searchParams
  } catch {
    return new URLSearchParams()
  }
}

const SEVERITY_VALUES: ReadonlyArray<NotificationSeverity> = ['critical', 'warning', 'info']

function parseSeverityFilter(raw: string | undefined): NotificationSeverity[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is NotificationSeverity =>
      (SEVERITY_VALUES as readonly string[]).includes(s),
    )
}

const EVENT_TYPE_VALUES: ReadonlyArray<NotificationEvent['type']> = [
  'TRADE',
  'ERROR',
  'STATE_CHANGE',
]

function parseEventTypeFilter(raw: string | undefined): NotificationEvent['type'] | undefined {
  if (!raw) return undefined
  const upper = raw.trim().toUpperCase() as NotificationEvent['type']
  return (EVENT_TYPE_VALUES as readonly string[]).includes(upper) ? upper : undefined
}

interface AlertsBodyArgs {
  rows: AlertRow[]
  limit: number
  severityFilter: NotificationSeverity[]
  eventTypeFilter: NotificationEvent['type'] | undefined
  /** 現在の query string。filter pill が他の param (limit 等) を保持するために使う。 */
  currentQuery: URLSearchParams
  /** symbol 列の表示を JP 銘柄向け 番号-会社名 形式にするための universe (load 失敗は null)。 */
  universe?: SymbolUniverse | null
}

/**
 * `/dashboard/alerts` の HTML 本文 (#141)。
 *
 *   - severity ピル (critical / warning / info / 全件) で絞り込み
 *   - event type ピル (TRADE / ERROR / STATE_CHANGE / 全件) で絞り込み
 *   - 表示は最新 100 件 (`?limit=N` で 1〜500)
 *   - 行クリックで Slack/Discord に出したのと同じ message を JST 時刻と一緒に確認
 */
function alertsBody(args: AlertsBodyArgs): string {
  const { rows, limit, severityFilter, eventTypeFilter, currentQuery, universe } = args
  const filterDescription =
    severityFilter.length === 0 && eventTypeFilter === undefined
      ? '全件'
      : [
          severityFilter.length > 0 ? `severity=${severityFilter.join(',')}` : null,
          eventTypeFilter ? `eventType=${eventTypeFilter}` : null,
        ]
          .filter((s): s is string => s !== null)
          .join(' / ')
  const header = `<p class="muted">直近 ${rows.length} 件のアラート (${esc(filterDescription)}, limit=${limit}, max 500)。Webhook が未設定でも D1 には記録されています。</p>`
  const filterPills = renderAlertFilterPills(severityFilter, eventTypeFilter, currentQuery)
  if (rows.length === 0) {
    return `${header}${filterPills}<p class="muted">該当するアラートは見つかりませんでした。</p>`
  }
  const tbody = rows
    .map((r) => {
      const cls =
        r.severity === 'critical'
          ? 'err'
          : r.severity === 'warning'
            ? 'warn'
            : 'muted'
      const symbolInactive = r.symbol ? isSymbolInactive(r.symbol, universe) : false
      const symbolCell = r.symbol
        ? `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}"${symbolInactive ? ` title="${esc(inactiveTooltip(r.symbol, universe))}"` : ''}><span${symbolInactive ? ' class="symbol-disabled"' : ''}>${esc(displaySymbol(r.symbol, universe))}</span></a>`
        : '<span class="muted">-</span>'
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td class="${cls}"><strong>${esc(r.severity)}</strong></td>
        <td>${esc(r.eventType)}</td>
        <td>${symbolCell}</td>
        <td>${esc(r.cause ?? '-')}</td>
        <td><code style="white-space:pre-wrap">${esc(r.message)}</code></td>
        <td class="muted"><code>${esc(r.requestId ?? '-')}</code></td>
      </tr>`
    })
    .join('')
  return `${header}${filterPills}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>severity</th><th>event</th><th>symbol</th><th>cause / field</th><th>message</th><th>requestId</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

/**
 * `/dashboard/alerts` の severity / eventType filter ピルを描画する。
 *
 * `currentQuery` の他 param (例: `limit=500`) は preserve したまま、対象 key
 * のみを差し替える / 削除する (CodeRabbit #210)。
 *
 * Exported for unit test (URL preservation).
 */
export function renderAlertFilterPills(
  active: NotificationSeverity[],
  activeEventType: NotificationEvent['type'] | undefined,
  currentQuery: URLSearchParams,
): string {
  const buildHref = (updatedKey: string, updatedValue: string | null): string => {
    const next = new URLSearchParams(currentQuery)
    if (updatedValue === null) next.delete(updatedKey)
    else next.set(updatedKey, updatedValue)
    const qs = next.toString()
    return qs.length === 0 ? '/dashboard/alerts' : `/dashboard/alerts?${qs}`
  }
  const pill = (label: string, href: string, isActive: boolean): string =>
    `<a href="${esc(href)}" style="margin-right:6px;${isActive ? 'background:#1d1d1f;color:#fff;' : ''}">${esc(label)}</a>`
  const sev = [
    pill('全 severity', buildHref('severity', null), active.length === 0),
    pill(
      'critical',
      buildHref('severity', 'critical'),
      active.length === 1 && active[0] === 'critical',
    ),
    pill(
      'warning',
      buildHref('severity', 'warning'),
      active.length === 1 && active[0] === 'warning',
    ),
    pill(
      'critical+warning',
      buildHref('severity', 'critical,warning'),
      active.length === 2 && active.includes('critical') && active.includes('warning'),
    ),
    pill('info', buildHref('severity', 'info'), active.length === 1 && active[0] === 'info'),
  ].join('')
  const ev = [
    pill('全 type', buildHref('eventType', null), activeEventType === undefined),
    pill('ERROR', buildHref('eventType', 'ERROR'), activeEventType === 'ERROR'),
    pill('TRADE', buildHref('eventType', 'TRADE'), activeEventType === 'TRADE'),
    pill(
      'STATE_CHANGE',
      buildHref('eventType', 'STATE_CHANGE'),
      activeEventType === 'STATE_CHANGE',
    ),
  ].join('')
  return `<nav style="margin-bottom:12px">${sev}<span class="muted" style="margin:0 8px">|</span>${ev}</nav>`
}

interface AuditBodyArgs {
  rows: ConfigAuditRow[]
  limit: number
  actorFilter: string | undefined
  endpointFilter: string | undefined
  /** Raw query string values for the form inputs (passthrough so a typo round-trips). */
  fromFilter: string
  toFilter: string
}

/**
 * `/dashboard/audit` の HTML 本文 (#274)。
 *
 *   - 直近 100 件 (`?limit=N` で 1〜500)
 *   - actor / endpoint / from / to で絞り込み (GET form)
 *   - before_json / after_json は `<details>` で展開表示
 */
function auditBody(args: AuditBodyArgs): string {
  const { rows, limit, actorFilter, endpointFilter, fromFilter, toFilter } = args
  const form = `<form method="get" action="/dashboard/audit" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
  <label>actor<br><input name="actor" value="${esc(actorFilter ?? '')}" placeholder="ai-agent" style="padding:4px 8px"></label>
  <label>endpoint<br><input name="endpoint" value="${esc(endpointFilter ?? '')}" placeholder="/admin/symbols/:symbol/seed-cash" style="padding:4px 8px;min-width:280px"></label>
  <label>from<br><input name="from" type="date" value="${esc(fromFilter)}" style="padding:4px 8px"></label>
  <label>to<br><input name="to" type="date" value="${esc(toFilter)}" style="padding:4px 8px"></label>
  <label>limit<br><input name="limit" type="number" min="1" max="500" value="${limit}" style="padding:4px 8px;width:90px"></label>
  <button type="submit" style="padding:6px 14px">絞り込み</button>
  <a href="/dashboard/audit" style="padding:6px 14px;text-decoration:none">リセット</a>
</form>`
  const header = `<p class="muted">直近 ${rows.length} 件 (limit=${limit}, max 500)。状態変更系 admin POST の before/after diff。before == after の no-op 呼び出しは記録されません。</p>`
  if (rows.length === 0) {
    return `${header}${form}<p class="muted">該当する監査ログは見つかりませんでした。</p>`
  }
  const tbody = rows
    .map((r) => {
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td><strong>${esc(r.actor)}</strong></td>
        <td><code>${esc(r.endpoint)}</code></td>
        <td>${esc(r.targetKey ?? '-')}</td>
        <td><details><summary class="muted">before</summary><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:#fafafa;padding:6px;border-radius:4px">${esc(formatAuditJson(r.beforeJson))}</pre></details></td>
        <td><details><summary class="muted">after</summary><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:#fafafa;padding:6px;border-radius:4px">${esc(formatAuditJson(r.afterJson))}</pre></details></td>
        <td class="muted"><code>${esc(r.requestId ?? '-')}</code></td>
      </tr>`
    })
    .join('')
  return `${header}${form}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>actor</th><th>endpoint</th><th>target</th><th>before</th><th>after</th><th>requestId</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

/**
 * `?limit=N` を 1〜500 に丸める。`/dashboard/audit` 既定 100。
 */
function clampAuditLimit(raw: string | undefined): number {
  const n = raw === undefined ? 100 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(n, 500)
}

function trimQuery(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * `YYYY-MM-DD` 日付フィルタを ISO timestamp に展開。`isEnd=true` は `T23:59:59.999Z`、
 * false は `T00:00:00.000Z` を付ける (UTC base — 監査ログの timestamp は
 * ISO UTC で書かれる)。文法が合わない値は undefined を返す (フィルタ skip)。
 */
function parseAuditDateFilter(raw: string | undefined, isEnd: boolean): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined
  return isEnd ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`
}

/**
 * `before_json` / `after_json` を整形して表示。JSON parse が成功すれば 2-space
 * indent、失敗 (= マイグレ前の raw 文字列など) は原文をそのまま返す。
 */
function formatAuditJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function cronBody(
  rows: Array<{
    id: number
    timestamp: string
    requestId: string | null
    symbol: string
    decision: string
    reason: string | null
    price: number | null
    indicatorsJson?: string | null
    clientOrderId?: string | null
    filledPrice?: number | null
    filledQty?: number | null
    realizedPnl?: number | null
    brokerStatus?: string | null
  }>,
  limit: number,
  symbolFilter: string | undefined,
  universe?: SymbolUniverse | null,
): string {
  const header = symbolFilter
    ? `<p class="muted">Showing ${rows.length} decisions for <strong>${esc(displaySymbol(symbolFilter, universe))}</strong> (limit=${limit}, max 200)。<a href="/dashboard/cron">全銘柄へ戻る</a> / <a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a></p>`
    : `<p class="muted">Showing ${rows.length} decisions (limit=${limit}, max 200)。<code>?symbol=SOXL</code> で絞り込み可能。<a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a></p>`
  if (rows.length === 0) {
    return `${header}<p class="muted">判定ログがまだありません。</p>`
  }
  const tbody = rows
    .map((r) => {
      const cls =
        r.decision === 'BUY'
          ? 'ok'
          : r.decision === 'SELL'
            ? 'warn'
            : r.decision === 'ERROR'
              ? 'err'
              : r.decision === 'REJECT'
                ? 'warn'
                : 'muted'
      // 実 fill 結果 (trade_journal post_submit から JOIN、#143)
      // realized_pnl は主に SELL で非 null (利確/損切のドル額)。BUY の realized は null。
      const realizedCell =
        r.realizedPnl === null || r.realizedPnl === undefined
          ? '-'
          : formatRealizedPnl(r.realizedPnl)
      const fillCell =
        r.filledPrice === null || r.filledPrice === undefined
          ? '-'
          : `${fmtNumber(r.filledPrice, 2)} × ${r.filledQty ?? '?'}`
      const inactive = isSymbolInactive(r.symbol, universe)
      const symbolClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(inactiveTooltip(r.symbol, universe))}"` : ''
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td><a href="/dashboard/cron?symbol=${encodeURIComponent(r.symbol)}"${titleAttr}><strong><span${symbolClass}>${esc(displaySymbol(r.symbol, universe))}</span></strong></a></td>
        <td class="${cls}">${esc(r.decision)}</td>
        <td>${cronReasonCell(r)}</td>
        <td>${r.price === null ? '-' : fmtNumber(r.price, 2)}</td>
        <td class="muted">${esc(fillCell)}</td>
        <td>${realizedCell}</td>
      </tr>`
    })
    .join('')
  return `${header}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>symbol</th><th>decision</th><th>reason (評価時の含み損益など)</th><th>price</th><th>実 fill (価格 × 数量)</th><th>実 損益</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function cronReasonCell(row: {
  id: number
  timestamp: string
  requestId: string | null
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson?: string | null
  clientOrderId?: string | null
  filledPrice?: number | null
  filledQty?: number | null
  realizedPnl?: number | null
  brokerStatus?: string | null
}): string {
  const localized = localizeReason(row.reason)
  const rawReason = row.reason ?? '-'
  const decisionJson = JSON.stringify(cronDecisionJson(row), null, 2)
  const humanDetails = describeCronReason(row.reason)

  return `<details class="reason-details">
    <summary>${esc(localized || '-')}</summary>
    <div class="reason-panel">
      <div><strong>読み方</strong>${humanDetails}</div>
      <div><strong>RUNID</strong><br><code>${esc(row.requestId ?? '-')}</code></div>
      <div><strong>raw reason</strong><br><code>${esc(rawReason)}</code></div>
      <div><strong>decision id / clientOrderId</strong><br><code>${row.id}</code> / <code>${esc(row.clientOrderId ?? '-')}</code></div>
      <div><strong>JSON</strong><br><pre>${esc(decisionJson)}</pre></div>
    </div>
  </details>`
}

function cronDecisionJson(row: {
  id: number
  timestamp: string
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson?: string | null
  clientOrderId?: string | null
  filledPrice?: number | null
  filledQty?: number | null
  realizedPnl?: number | null
  brokerStatus?: string | null
}) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    symbol: row.symbol,
    decision: row.decision,
    reason: row.reason,
    localizedReason: localizeReason(row.reason),
    price: row.price,
    indicators: parseJsonObject(row.indicatorsJson),
    clientOrderId: row.clientOrderId,
    broker: {
      status: row.brokerStatus,
      filledPrice: row.filledPrice,
      filledQty: row.filledQty,
      realizedPnl: row.realizedPnl,
    },
  }
}

function describeCronReason(reason: string | null | undefined): string {
  if (!reason) return '<p class="muted">詳細理由なし</p>'

  const lotSizeRound = reason.match(
    /^sizing rejected: lot-size-round \(raw qty (\S+) < lot (\S+), stop (\S+), entry (\S+)\)$/,
  )
  if (lotSizeRound) {
    const [, rawQty, lot, stop, entry] = lotSizeRound
    return `<ul>
      <li>計算上は ${esc(rawQty)} 株まで建てられるが、必要な売買単位 ${esc(lot)} 株に届かないため発注しません。</li>
      <li>評価時の株価は ${esc(entry)}、損切り幅は ${esc(stop)} / 株です。</li>
      <li>このままだと単元未満なので、リスク予算・銘柄上限・売買単位のいずれかが変わらない限り発注されません。</li>
    </ul>`
  }

  return `<p>${esc(localizeReason(reason))}</p>`
}

/**
 * realized_pnl ($ / ¥ raw 値) を符号付き小数 2 桁で。loss は赤、profit は緑。
 */
function formatRealizedPnl(value: number): string {
  const sign = value > 0 ? '+' : ''
  const cls = value > 0 ? 'ok' : value < 0 ? 'err' : 'muted'
  return `<span class="${cls}">${sign}${value.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
}

/**
 * 戦略妥当性チャート (#158)。
 *
 * 設計方針:
 * - ECharts CDN load (jsdelivr)、build step 導入しない (POC scope 維持)
 * - データは `<script>` で window.__chartData に埋込、`</script>` を escape
 * - CDN 失敗時は chart 部分のみ unavailable 表示で fail-graceful
 *
 * Phase 0+1 では equity curve + drawdown のみ。Phase 2-4 で追加予定。
 */

const ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js'

interface EquityPoint {
  date: string // YYYY-MM-DD (JST)
  dailyPnl: number
  cumulativePnl: number
  drawdownPct: number // 0 or 負 (peak からの低下率)
}

/**
 * trade_journal の post_submit で realized_pnl が記録されている SELL fill を
 * 日次集計し、累積 PnL とドローダウン率を計算する。
 *
 * - peak は cumulativePnl の rolling max
 * - drawdownPct は peak が 0 以下のとき null 相当 (= 0%) として扱う
 *   (peak が小さい初期は割り算が暴れるため)
 */
export async function loadEquityCurve(db: D1Database): Promise<EquityPoint[]> {
  // SQLite の date(timestamp) はデフォルト UTC。JST 表示にするため +9h shift。
  const result = await db
    .prepare(
      `SELECT date(timestamp, '+9 hours') AS day,
              SUM(realized_pnl) AS daily_pnl
       FROM trade_journal
       WHERE realized_pnl IS NOT NULL
         AND trade_event_type = 'post_submit'
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all<{ day: string; daily_pnl: number }>()
  const rows = result.results ?? []
  return computeEquitySeries(rows.map((r) => ({ date: r.day, dailyPnl: Number(r.daily_pnl) })))
}

export function computeEquitySeries(
  daily: Array<{ date: string; dailyPnl: number }>,
): EquityPoint[] {
  const points: EquityPoint[] = []
  let cumulative = 0
  let peak = 0
  for (const d of daily) {
    cumulative += d.dailyPnl
    if (cumulative > peak) peak = cumulative
    // peak が +側になるまでは drawdown を 0 表示 (シード資金規模が不明なので
    // % 計算は意味をなさない。peak を絶対額として比較するのも手だが、トレーダー
    // 視点では「最高益からの下落率」が読みたいので peak>0 で初めて非ゼロに)
    const dd = peak > 0 ? (cumulative - peak) / peak : 0
    points.push({ date: d.date, dailyPnl: d.dailyPnl, cumulativePnl: cumulative, drawdownPct: dd })
  }
  return points
}

/**
 * Decision breakdown chart 用の日次集計 (#158 Phase 2)。
 *
 * strategy_decision_log を JST 日次でグルーピングし、各 decision
 * (BUY/SELL/HOLD/REJECT/ERROR) のカウントを返す。トレーダーは
 * 「BUY/SELL が出すぎ・出なさすぎ」「REJECT が偏ってないか」を一目で
 * 見たいので、1 日 1 行 × 5 系列の stacked bar 用のデータ形にする。
 *
 * 直近 90 日のみ (それ以上はチャートが詰まって読めない)。
 */
const DECISION_KEYS = ['BUY', 'SELL', 'HOLD', 'REJECT', 'ERROR'] as const
type DecisionKey = (typeof DECISION_KEYS)[number]

export interface DecisionBreakdownPoint {
  date: string
  counts: Record<DecisionKey, number>
}

export async function loadDecisionBreakdown(db: D1Database): Promise<DecisionBreakdownPoint[]> {
  const result = await db
    .prepare(
      `SELECT date(timestamp, '+9 hours') AS day,
              decision,
              COUNT(*) AS n
       FROM strategy_decision_log
       WHERE timestamp >= date('now', '-90 days')
       GROUP BY day, decision
       ORDER BY day ASC`,
    )
    .all<{ day: string; decision: string; n: number }>()
  return aggregateDecisionRows(result.results ?? [])
}

export function aggregateDecisionRows(
  rows: Array<{ day: string; decision: string; n: number }>,
): DecisionBreakdownPoint[] {
  const map = new Map<string, Record<DecisionKey, number>>()
  for (const r of rows) {
    let bucket = map.get(r.day)
    if (!bucket) {
      bucket = { BUY: 0, SELL: 0, HOLD: 0, REJECT: 0, ERROR: 0 }
      map.set(r.day, bucket)
    }
    // 想定外 decision (将来追加など) は ERROR バケットに寄せて見落とし防止
    const key: DecisionKey = (DECISION_KEYS as readonly string[]).includes(r.decision)
      ? (r.decision as DecisionKey)
      : 'ERROR'
    bucket[key] += Number(r.n)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, counts]) => ({ date, counts }))
}

/**
 * Per-trade realized PnL を全件取得 (#158 Phase 3)。
 *
 * trade_journal.realized_pnl は SELL fill に確定損益が記録される (BUY は null)。
 * 戦略のエッジが本物か偽物かを見るために、勝率・profit factor・expectancy を
 * 計算 + 分布を histogram で可視化する。
 */
export async function loadTradePnls(db: D1Database): Promise<number[]> {
  const result = await db
    .prepare(
      `SELECT realized_pnl AS pnl
       FROM trade_journal
       WHERE realized_pnl IS NOT NULL
         AND trade_event_type = 'post_submit'
       ORDER BY id ASC`,
    )
    .all<{ pnl: number }>()
  return (result.results ?? []).map((r) => Number(r.pnl)).filter((n) => Number.isFinite(n))
}

export interface TradeStats {
  count: number
  wins: number
  losses: number
  /** 0..1 (勝率) */
  winRate: number
  avgWin: number
  avgLoss: number // 負値
  /** 総利益 / |総損失|。loss=0 のときは Infinity (UI 側で "—" 表示) */
  profitFactor: number
  /** 1 trade あたり期待損益 = winRate * avgWin + (1-winRate) * avgLoss */
  expectancy: number
  total: number
}

/**
 * 「エッジが本物か」を 1 表で見るためのサマリ統計。break-even (pnl=0) は wins / losses
 * どちらにも入れない (エクスペクタンシ計算で 0 として中立に効く)。
 */
export function computeTradeStats(pnls: number[]): TradeStats {
  if (pnls.length === 0) {
    return { count: 0, wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, total: 0 }
  }
  let wins = 0
  let losses = 0
  let sumWin = 0
  let sumLoss = 0
  let total = 0
  for (const p of pnls) {
    total += p
    if (p > 0) {
      wins += 1
      sumWin += p
    } else if (p < 0) {
      losses += 1
      sumLoss += p
    }
  }
  const decisive = wins + losses
  const winRate = decisive > 0 ? wins / decisive : 0
  const avgWin = wins > 0 ? sumWin / wins : 0
  const avgLoss = losses > 0 ? sumLoss / losses : 0
  const profitFactor = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss
  return { count: pnls.length, wins, losses, winRate, avgWin, avgLoss, profitFactor, expectancy, total }
}

export interface PnlHistogramBin {
  label: string // "(-5, -3]" など
  binStart: number
  binEnd: number
  binCenter: number
  count: number
}

/**
 * pnl 値を最大 12 ビンの histogram に。範囲は対称 (max(|min|, max)) で
 * 0 を境に正/負で色分け可能にする。サンプルが少なすぎるとビン数を減らす。
 */
export function computePnlHistogram(pnls: number[], maxBins = 12): PnlHistogramBin[] {
  if (pnls.length === 0) return []
  const absMax = Math.max(...pnls.map(Math.abs))
  if (absMax === 0) {
    return [{ label: '0', binStart: 0, binEnd: 0, binCenter: 0, count: pnls.length }]
  }
  const bins = Math.min(maxBins, Math.max(3, Math.ceil(Math.sqrt(pnls.length))))
  const range = absMax * 2
  const width = range / bins
  const out: PnlHistogramBin[] = []
  for (let i = 0; i < bins; i += 1) {
    const start = -absMax + width * i
    const end = start + width
    out.push({
      label: `(${start.toFixed(1)}, ${end.toFixed(1)}]`,
      binStart: start,
      binEnd: end,
      binCenter: (start + end) / 2,
      count: 0,
    })
  }
  for (const p of pnls) {
    // 末尾の bin は閉区間 [end, end] を含むよう特別処理
    let idx = Math.floor((p - -absMax) / width)
    if (idx >= bins) idx = bins - 1
    if (idx < 0) idx = 0
    out[idx]!.count += 1
  }
  return out
}

function renderTradeStatsTable(s: TradeStats): string {
  if (s.count === 0) return ''
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—')
  const pct = (n: number) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—')
  const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'
  const expClass = s.expectancy > 0 ? 'ok' : s.expectancy < 0 ? 'err' : 'muted'
  return `<table style="margin-top:12px">
    <thead><tr><th>件数</th><th>勝</th><th>負</th><th>勝率</th><th>平均利益</th><th>平均損失</th><th>profit factor</th><th>expectancy / trade</th><th>合計</th></tr></thead>
    <tbody><tr>
      <td>${s.count}</td>
      <td class="ok">${s.wins}</td>
      <td class="err">${s.losses}</td>
      <td>${pct(s.winRate)}</td>
      <td class="ok">${fmt(s.avgWin)}</td>
      <td class="err">${fmt(s.avgLoss)}</td>
      <td>${pf}</td>
      <td class="${expClass}">${fmt(s.expectancy)}</td>
      <td class="${s.total > 0 ? 'ok' : s.total < 0 ? 'err' : 'muted'}">${fmt(s.total)}</td>
    </tr></tbody>
  </table>`
}

/**
 * 銘柄チャートで focus する銘柄を決める (#158 Phase 4)。
 * クエリ ?symbol=X が universe にあればそれ、無ければ「直近で BUY/SELL
 * fill のあった銘柄」、それも無ければ universe の先頭。
 *
 * 「実際に売買したことがある銘柄」を優先する理由: トレーダーが
 * 「rule の解釈が現実と合ってるか」を最初に見たいのは、エントリーが
 * あった銘柄だから。
 */
export async function pickDefaultSymbol(db: D1Database): Promise<string | null> {
  const result = await db
    .prepare(
      `SELECT symbol FROM trade_journal
       WHERE trade_event_type = 'post_submit' AND filled_qty IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .all<{ symbol: string }>()
  return result.results?.[0]?.symbol ?? null
}

export interface SymbolChartPoint {
  timestamp: string // ISO UTC (time axis 用、client 側 Intl で JST 表示)
  price: number
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

export interface SymbolChartMarker {
  timestamp: string
  side: 'BUY' | 'SELL'
  price: number
  qty: number | null
  realizedPnl: number | null
}

export interface SymbolChartPosition {
  /** 平均取得単価 (= 直近 BUY filled_price、partial fill / add は未対応 POC) */
  avgPrice: number
  /** entry timestamp (JST 表示用文字列) */
  openedAt: string
}

export interface SymbolChartRules {
  /** -0.03 = -3% (押し目浅すぎ閾値) */
  pullbackMax: number
  /** -0.15 = -15% (押し目深すぎ閾値) */
  pullbackMin: number
  /** -0.04 = -4% (損切ライン) */
  stopPct: number
  /** 0.07 = +7% (利食ライン) */
  takeProfitPct: number
  /** 営業日。chart の SQL window 計算に使う (chart logic では非使用) */
  timeStopDays: number
}

/**
 * Chart window の上限日数。schema の MAX_TIME_STOP_DAYS (365) から計算。
 * timeStopDays が大きくても肥大化を防ぐ。
 * MAX_TIME_STOP_DAYS=365 → 2*365+4 = 734 カレンダー日。
 */
const MAX_WINDOW_DAYS = Math.ceil(MAX_TIME_STOP_DAYS * 2 + 4)

/**
 * Chart SQL の window 日数を timeStopDays から動的に決める。
 * 営業日 N → カレンダー N×7/5 + 祝日バッファ + 安全マージン ≈ 2N+4。
 * timeStopDays=10 → 24 日。年末年始 / 大型連休跨ぎでも entry 取りこぼさない。
 * floor=14, ceiling=MAX_WINDOW_DAYS で clamp してカレンダー window の肥大化を防ぐ。
 */
export function computeChartWindowDays(timeStopDays: number): number {
  const dynamic = Math.ceil(timeStopDays * 2 + 4)
  return Math.min(Math.max(dynamic, 14), MAX_WINDOW_DAYS)
}

export interface PivotPoint {
  /** ISO UTC timestamp of the daily bar */
  timestamp: string
  price: number
  type: 'high' | 'low'
}

/**
 * 直線セグメント。
 *
 * 旧仕様 (pivot ベース) では `pivots` は「採用した 2 swing pivot」だったが、
 * 現仕様 (linear regression) では `pivots[0]` = 線の左端、`pivots[1]` = 同じ
 * slope 上の参照点 (densify では未使用) を入れる。`end` は線の右端 (= chart
 * 最新 timestamp 上の外挿点)。`densifyTrendLine` は `pivots[0]` と `end` の
 * 2 点だけを使うため、両用途で同じ型が再利用できる。
 */
export interface TrendLineSegment {
  pivots: [PivotPoint, PivotPoint]
  end: { timestamp: string; price: number }
}

/** 15 分足 OHLC (Yahoo intraday bars 由来)、candlestick 描画用 */
export interface OhlcBar {
  /** ISO UTC (Yahoo intraday は秒精度の bar 開始時刻) */
  timestamp: string
  open: number
  high: number
  low: number
  close: number
}

export interface SymbolChartData {
  symbol: string
  points: SymbolChartPoint[]
  markers: SymbolChartMarker[]
  /** 現保有 (BUY → SELL がまだない) ならその情報、なければ null */
  position: SymbolChartPosition | null
  rules: SymbolChartRules
  /**
   * 直近 30 日 daily close の最小二乗 (linear regression) で fit した
   * 「価格の中心トレンド線」。データ点が 2 未満なら null。
   *
   * 旧仕様 (resistanceLine / supportLine の上下 2 本) は、ローソク足の上下を
   * flat に走る形で「価格の中心を辿る」という user の期待と乖離していた。
   * regression で価格中央を best-fit する形に変更。
   */
  trendLine: TrendLineSegment | null
  /** Yahoo 日次 OHLC、candlestick 描画用 (空配列 = Yahoo fetch 失敗) */
  intradayBars: OhlcBar[]
  /**
   * 最新の cron-eval point (= strategy_decision_log 由来) の price。
   * Yahoo daily filler を含めず、merge 前 cron-eval の末尾を採用する。
   *
   * preview stop/TP の virtualAvg はこの値を使う。`points` 末尾は
   * Yahoo filler だと「古い日次 close」になる可能性があり、preview に使うと
   * 「実 strategy 評価で参照していない過去価格」で線が引かれて誤解を招く。
   * cron eval 履歴が無い (= strategy_decision_log が空) 場合は null。
   */
  latestCronPrice: number | null
  /** `latestCronPrice` の timestamp (ISO Z)。preview line の to-end 用。null 時 preview 描画スキップ。 */
  latestCronTimestamp: string | null
}

/**
 * 直近 200 件の strategy_decision_log と全 fill markers + 現保有 + ルール閾値を返す。
 * - sma50 / high20d は indicators_json から抜く (JSON.parse 失敗は null fallback)
 * - timestamp は DB 上の UTC ISO をそのまま保持し、ECharts time axis に渡す。
 *   JST 表示は client 側 Intl.DateTimeFormat (Asia/Tokyo) でやる
 * - position は SymbolStateDO の値を最優先 (partial fill / position add 対応)、
 *   binding 無し or 失敗時は trade_journal からの derive にフォールバック
 */
export async function loadSymbolChart(
  env: Env,
  symbol: string,
  rules: SymbolChartRules,
): Promise<SymbolChartData> {
  const db = env.DB
  if (!db) throw new Error('DB binding not available')
  const windowDays = computeChartWindowDays(rules.timeStopDays)
  const [logsResult, fillsResult, doPosition] = await Promise.all([
    db
      // 動的 window: timeStopDays から computeChartWindowDays(N) で計算
      // (default 10 営業日 → 24 カレンダー日)。祝日 / 連休跨ぎでも entry を
      // 取りこぼさない。strftime で右辺を ISO UTC 形式 ("...T...:...Z") に
      // 揃える (default datetime() の空白区切りでは stored ISO と境界がぶれる)。
      .prepare(
        `SELECT timestamp, price, indicators_json
         FROM strategy_decision_log
         WHERE symbol = ?
           AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         ORDER BY id ASC`,
      )
      .bind(symbol, `-${windowDays} days`)
      .all<{ timestamp: string; price: number | null; indicators_json: string | null }>(),
    db
      // post_submit 行は side が null (writer は pre_submit にしか side を入れない)。
      // client_order_id で pre_submit と self-JOIN して side を引く。古い fill で
      // pre_submit が無い場合は realized_pnl の有無から推測 (null=BUY, 非 null=SELL)。
      .prepare(
        `SELECT
           ps.timestamp AS timestamp,
           pre.side AS pre_side,
           ps.filled_price AS filled_price,
           ps.filled_qty AS filled_qty,
           ps.realized_pnl AS realized_pnl
         FROM trade_journal AS ps
         LEFT JOIN trade_journal AS pre
           ON pre.client_order_id = ps.client_order_id
           AND pre.trade_event_type = 'pre_submit'
         WHERE ps.symbol = ?
           AND ps.trade_event_type = 'post_submit'
           AND ps.filled_price IS NOT NULL
         ORDER BY ps.id ASC`,
      )
      .bind(symbol)
      .all<{
        timestamp: string
        pre_side: string | null
        filled_price: number | null
        filled_qty: number | null
        realized_pnl: number | null
      }>(),
    fetchDoPosition(env, symbol),
  ])
  const logs = logsResult.results ?? [] // SQL は既に ASC で返している
  const points: SymbolChartPoint[] = logs
    .filter((r) => r.price !== null && Number.isFinite(Number(r.price)))
    .map((r) => {
      const indicators = parseIndicators(r.indicators_json)
      return {
        timestamp: r.timestamp,
        price: Number(r.price),
        sma50: indicators.sma50,
        high20d: indicators.high20d,
        low20d: indicators.low20d,
      }
    })
  const markers: SymbolChartMarker[] = (fillsResult.results ?? [])
    .filter((r) => r.filled_price !== null)
    .map((r) => ({
      timestamp: r.timestamp,
      side: resolveFillSide(r.pre_side, r.realized_pnl),
      price: Number(r.filled_price),
      qty: r.filled_qty === null ? null : Number(r.filled_qty),
      realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
    }))
  // DO query の結果が undefined = binding 無し or fetch 失敗 → derive にフォールバック
  const position = doPosition !== undefined ? doPosition : deriveOpenPosition(markers)

  // Yahoo daily bars 60 日: chart 全体の price line + pivot 検出に使う。
  // Yahoo fetch 失敗時は cron-eval points のみで描画 (短い price line になるが
  // 致命的ではない)。lastTimestamp が無い (chart 自体空) なら filtering 不要。
  const yahooBarsRaw = await fetchYahooBarsForChart(symbol, 60)
  const cronLastTs = points.length > 0 ? points[points.length - 1]!.timestamp : null
  const yahooBars =
    cronLastTs == null ? yahooBarsRaw : yahooBarsRaw.filter((b) => b.timestamp <= cronLastTs)

  // 最新 cron-eval point (= 実 strategy 評価で使った値) を merge 前に snapshot。
  // mergedPoints[末尾] は Yahoo daily filler の可能性があり (cron 停止中 / 古い銘柄)、
  // preview stop/TP に使うと「strategy 上は触ってない過去 Yahoo 値」で線が引かれて
  // 誤解を招く。preview は cron eval 履歴がある時だけ描く方針 → null フィールドで
  // 「描画スキップ」シグナルにする。
  const { latestCronPrice, latestCronTimestamp } = selectLatestCronSnapshot(points)

  // Yahoo bar を points にマージして全期間 price line を実現。同 timestamp で
  // 既に cron-eval point があればそちらを優先 (indicators が乗っているため)。
  // Yahoo bar 由来の point は indicators フィールド全 null。
  const mergedPoints = mergeYahooAndCronPoints(yahooBars, points)
  const lastTimestamp =
    mergedPoints.length > 0 ? mergedPoints[mergedPoints.length - 1]!.timestamp : null

  // 価格トレンド: 直近 30 暦日 (regime shift を跨がない短期) の daily close
  // を最小二乗で fit した linear regression line。pivot ベース (上値抵抗 /
  // 下値支持) は candle の「上下を flat に走る bound 線」になりやすく、user
  // 期待である「ローソク足の中心を辿る trend」を表現できなかったため、close
  // の重心を通る best-fit 1 本に置き換えた (#190 系の見直し)。
  //
  // データ source: Yahoo daily が ≥5 本あればそれ、不足なら cron-eval 由来の
  // 日次 close fallback。30 日に満たないデータでも残っている分すべて使う
  // (< 2 なら null 返却 → 描画スキップ)。
  const TREND_WINDOW_DAYS = 30
  const trendCutoffMs = lastTimestamp
    ? new Date(lastTimestamp).getTime() - TREND_WINDOW_DAYS * 24 * 3600 * 1000
    : 0
  const trendDailySource: Array<{ jstDate: string; close: number; timestamp: string }> = (() => {
    if (!lastTimestamp) return []
    const fromYahoo = yahooBars.filter((b) => new Date(b.timestamp).getTime() >= trendCutoffMs)
    if (fromYahoo.length >= 5) return fromYahoo
    return aggregateDailyCloses(points).filter(
      (p) => new Date(p.timestamp).getTime() >= trendCutoffMs,
    )
  })()
  const trendLine = lastTimestamp
    ? computeLinearRegressionLine(
        trendDailySource.map((d) => ({ timestamp: d.timestamp, close: d.close })),
        lastTimestamp,
      )
    : null
  // candlestick: 1 時間足 (intraday) を Yahoo から fetch。15m は overnight gap
  // 後の clustering と barWidth 調整がシビアだったため、daily-trader 向けに
  // 1h を default 採用 (Pullback Uptrend のような multi-day 戦略では十分な
  // granularity)。Yahoo intraday range 制限 60d で chart 全期間カバー可能。
  // 失敗 (network 等) なら空配列で fallback (candle 自体スキップ)。
  let intradayBars: OhlcBar[] = []
  try {
    const intraday = await new YahooBarClient().getIntradayBars(symbol, '60m')
    // lastTimestamp フィルタ: chart x 軸範囲を超える bar (将来に出るはずの bar)
    // を除外。lastTimestamp が無いときは全件採用。
    intradayBars = (cronLastTs == null
      ? intraday
      : intraday.filter((b) => b.timestamp <= cronLastTs)
    ).map((b) => ({
      timestamp: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
  } catch (err) {
    if (err instanceof RangeError) throw err
    // network / parse error → 空 fallback
  }
  return {
    symbol,
    points: mergedPoints,
    markers,
    position,
    rules,
    trendLine,
    intradayBars: intradayBars,
    latestCronPrice,
    latestCronTimestamp,
  }
}

/**
 * 銘柄グリッドビュー用: ALLOWED_SYMBOLS 全銘柄の SymbolChartData を並列取得。
 *
 * 個別 symbol の `loadSymbolChart` 失敗 (Yahoo fetch error / D1 一時的エラー /
 * DO unbound 等) は per-symbol で catch して `{ chart: null, error }` に落とす。
 * 1 銘柄の失敗で grid 全画面が 500 にならないよう、grid view では panel 単位で
 * 「データ取得失敗」を可視化する fallback に倒す (POC 段階で trader が生産に
 * 戻れない事故を避ける)。
 *
 * 注意: Cloudflare Workers の subrequest 制限 (50 / request) を考慮。
 * `loadSymbolChart` は 銘柄あたり ~5 subrequest (Yahoo daily + intraday + D1
 * query + DO query) なので 9 銘柄で ~45 subrequest。ALLOWED_SYMBOLS が増えた
 * 場合は paging or 段階表示が必要だが、POC 規模では十分に余裕がある前提。
 *
 * 並列度は `Promise.all` でフル並列。Workers の I/O concurrency 上限に当たる
 * ようなら `p-limit` 等で絞ることになるが、現状 9 並列なら問題ない。
 */
export async function loadAllSymbolCharts(
  env: Env,
  symbols: string[],
  rules: SymbolChartRules,
): Promise<Array<{ symbol: string; chart: SymbolChartData | null; error: string | null }>> {
  if (symbols.length === 0) return []
  return await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const chart = await loadSymbolChart(env, symbol, rules)
        return { symbol, chart, error: null as string | null }
      } catch (err) {
        // 個別失敗は audit log のため console.warn (Workers logs に流れる)。
        // panel 側は error 文字列を表示して trader に「この 1 銘柄だけ取得失敗」
        // を分からせる。
        // eslint-disable-next-line no-console
        console.warn('[dashboard] loadAllSymbolCharts symbol failed', { symbol, err: messageOf(err) })
        return { symbol, chart: null, error: messageOf(err) }
      }
    }),
  )
}

/**
 * cron-eval points の末尾 (= 実 strategy 評価で参照した最新価格) を取り出して
 * `{ latestCronPrice, latestCronTimestamp }` を返す。preview stop/TP は
 * Yahoo filler を含む `mergedPoints[末尾]` ではなくこちらを使う方針。
 *
 * - cron 履歴空 / 末尾 price 非有限 / 末尾 timestamp 不正 → 全 null
 *   (= preview 描画スキップのシグナル)。
 * - 末尾の price は >= 0 で finite なものだけ採用 (株価の sanity check)。
 *
 * 入力は merge 前 (= strategy_decision_log 由来) の SymbolChartPoint[] を想定。
 * 呼出側が誤って merged points を渡しても動くが、その場合は filler 末尾を
 * 拾うので preview の意図と乖離する。設計上、`loadSymbolChart` 内で merge
 * 前に呼ぶこと。
 */
export function selectLatestCronSnapshot(
  cronPoints: SymbolChartPoint[],
): { latestCronPrice: number | null; latestCronTimestamp: string | null } {
  if (cronPoints.length === 0) {
    return { latestCronPrice: null, latestCronTimestamp: null }
  }
  const last = cronPoints[cronPoints.length - 1]!
  const tsValid = Number.isFinite(new Date(last.timestamp).getTime())
  const priceValid = Number.isFinite(last.price)
  if (!tsValid || !priceValid) {
    return { latestCronPrice: null, latestCronTimestamp: null }
  }
  return { latestCronPrice: last.price, latestCronTimestamp: last.timestamp }
}

/**
 * Yahoo daily bars と cron-eval points をマージ。同 JST 日では cron-eval を
 * 優先 (indicators が乗っているため)、それ以外の日は Yahoo bar を price-only
 * の point として追加。timestamp 昇順で返す。
 */
export function mergeYahooAndCronPoints(
  yahooBars: Array<{ jstDate: string; close: number; sma50?: number | null; timestamp: string }>,
  cronPoints: SymbolChartPoint[],
): SymbolChartPoint[] {
  // 不正 timestamp の cron point は最初に除外。残すと ECharts time 軸 / chart
  // 末尾判定 (lastTimestamp = mergedPoints[-1]) が壊れる。
  const validCronPoints = cronPoints.filter((p) =>
    Number.isFinite(new Date(p.timestamp).getTime()),
  )
  // cron eval は同 JST 日の sma50 が null になりうる (古い row)。Yahoo 側で
  // 算出した sma50 を JST 日キーで参照できるよう Map にしておく。同 JST 日
  // 内の cron eval が複数あっても全部に同じ Yahoo SMA50 が振られる。
  const yahooSmaByJstDate = new Map<string, number | null>(
    yahooBars.map((b) => [b.jstDate, b.sma50 ?? null]),
  )
  const cronJstDates = new Set(
    validCronPoints.map((p) =>
      new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    ),
  )
  // Yahoo bar の SMA50 を cron point にも反映 (cron 側 indicators_json の sma50
  // が null の古い row でも線が途切れない)。cron 側が既に sma50 を持っていれば
  // それを優先 (より最新かつ rules と整合する)。
  const enrichedCronPoints: SymbolChartPoint[] = validCronPoints.map((p) => {
    if (p.sma50 != null) return p
    const jstDate = new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const fallback = yahooSmaByJstDate.get(jstDate) ?? null
    return fallback == null ? p : { ...p, sma50: fallback }
  })
  const yahooFiller: SymbolChartPoint[] = yahooBars
    .filter((b) => !cronJstDates.has(b.jstDate))
    .map((b) => ({
      timestamp: b.timestamp,
      price: b.close,
      sma50: b.sma50 ?? null,
      high20d: null,
      low20d: null,
    }))
  return [...yahooFiller, ...enrichedCronPoints].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
}

/**
 * Yahoo daily bars を chart 用に fetch (lookback 営業日)。timestamp は date
 * 部分 + 16:00 UTC (≈ 1:00 JST 翌日 ≈ "evening of date") で擬似生成、
 * trend line の傾き計算には相対精度として十分。
 *
 * エラー方針: caller contract 違反 (RangeError = lookback 不正) は呼出元の
 * 実装バグなので throw 再送出する。それ以外 (network / parse / 一時的
 * fetch 失敗) のみ空配列で fallback を呼出元に伝える。
 */
export async function fetchYahooBarsForChart(
  symbol: string,
  lookback: number,
): Promise<Array<{ jstDate: string; open: number; high: number; low: number; close: number; sma50: number | null; timestamp: string }>> {
  // warmup を足してから getDailyBars に渡す方式だと lookback=0 / 小さな負値で
  // も内側の lookback (lookback+warmup) が正の整数になり validation を素通り
  // してしまう (slice(-0)=slice(0) で warmup 区間が全部返る等)。caller contract
  // を維持するためここで先に弾く。整数性は getDailyBars 側の `Number.isInteger`
  // と整合させる。
  if (!Number.isInteger(lookback) || lookback <= 0) {
    throw new RangeError(
      `fetchYahooBarsForChart: lookback must be a positive integer, got ${lookback}`,
    )
  }
  const client = new YahooBarClient()
  try {
    // SMA50 を「先頭の chart 表示日」から埋めたいので、表示 lookback に加えて
    // SMA50 warmup の 50 日を上乗せして fetch する。表示時に lookback 件分を
    // 末尾から切り出す。
    const warmup = 50
    const bars = await client.getDailyBars(symbol, lookback + warmup)
    const closes = bars.map((b) => b.close)
    const smaSeries = computeRollingSma(closes, 50)
    const enriched = bars.map((b, i) => ({
      jstDate: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      sma50: smaSeries[i] ?? null,
      // JST 00:00 anchor: ECharts time axis (UTC) で JST formatter にかけると
      // b.date と同じ JST カレンダー日に column が配置される。
      // 旧実装 `${b.date}T16:00Z` だと JST 翌 01:00 に shift し、
      // 例えば US bar "04/25" が JST 04/26 列に表示される回帰があった。
      timestamp: anchorJstMidnight(b.date),
    }))
    // 表示は lookback 件分のみ (warmup 区間は SMA50 算出に使い切ったので破棄)。
    // bars が要求件数より少ない (上場初日近辺など) ケースもそのまま素通し。
    return enriched.length > lookback ? enriched.slice(-lookback) : enriched
  } catch (err) {
    // RangeError は呼出元コード側の lookback 不正 (実装ミス)。silent fallback で
    // 隠さず再送出して dashboard handler の try/catch まで伝える。
    if (err instanceof RangeError) throw err
    return []
  }
}

/**
 * `values[i]` を window 期間の単純移動平均に変換。i < window-1 は null。
 * SMA50 に流用するが任意 window で使える素朴実装。NaN/Infinity が混じった
 * 場合 sum が壊れるので入力側で予め弾く前提。
 */
export function computeRollingSma(values: number[], window: number): Array<number | null> {
  if (window <= 0) return values.map(() => null)
  const out: Array<number | null> = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!
    if (i >= window) sum -= values[i - window]!
    if (i >= window - 1) out[i] = sum / window
  }
  return out
}

/**
 * "YYYY-MM-DD" を「その日の JST 00:00 = UTC -9h 前日 15:00」の ISO Z 文字列に。
 * 例: "2026-04-25" → "2026-04-24T15:00:00.000Z" (JST 04/25 00:00)。
 * Yahoo bar / 他のロジックとの timestamp 比較を Z 形式で揃えるため。
 */
export function anchorJstMidnight(date: string): string {
  return new Date(`${date}T00:00:00+09:00`).toISOString()
}

/**
 * cron-eval price (Yahoo daily close を 15 分毎に複製したもの) を JST 日次で
 * dedupe して、その日の最終 cron eval を「日次 close」として採用。
 * trend line / pivot 検出は日足ベースで行うのが標準。
 */
export function aggregateDailyCloses(
  points: SymbolChartPoint[],
): Array<{ jstDate: string; close: number; timestamp: string }> {
  const byDay = new Map<string, { jstDate: string; close: number; timestamp: string }>()
  for (const p of points) {
    if (p.price == null || !Number.isFinite(p.price)) continue
    const ms = new Date(p.timestamp).getTime()
    if (!Number.isFinite(ms)) continue
    // JST date = UTC + 9h、ISO の前 10 文字
    const jstDate = new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
    // last write wins → その日の最終 cron eval
    byDay.set(jstDate, { jstDate, close: p.price, timestamp: p.timestamp })
  }
  return [...byDay.values()].sort((a, b) => (a.jstDate < b.jstDate ? -1 : 1))
}

/**
 * Daily close の最小二乗 (ordinary least squares) で価格中央を best-fit する
 * linear regression line を返す。「ローソク足の中心を辿るトレンド」を出すた
 * めの実装で、pivot ベースの上下 bound 線とは目的が違う。
 *
 * 戻り値の形は既存 `TrendLineSegment` を再利用 (densifyTrendLine が `pivots[0]`
 * と `end` の 2 点を読むだけ):
 * - `pivots[0]`: regression line 上の最古 sample timestamp 上の点 (= 線の左端)
 * - `pivots[1]`: 同じ slope を持つ参照点として `end` と同じ点を入れている
 *               (densify では未使用、互換のため形を保つ)
 * - `end`: `endTimestamp` (通常は chart の最新 timestamp) 上の外挿点
 *
 * 入力は `{ timestamp, close }` の配列 (順序不問、内部で時系列に並べる)。
 * 以下のケースで null:
 * - 有効な data point (Number.isFinite な timestamp / close) が 2 未満
 * - 全 sample が同 timestamp (slope 不定)
 * - `endTimestamp` が解釈不能
 * - 計算結果が NaN / Infinity
 *
 * regime filter は意図的に持たない: regression は close 全体の重心を取るので
 * 「別 regime の pivot」概念がそもそも存在しない。窓を 30 日程度に絞ること
 * が regime 跨ぎ対策を兼ねる。
 */
export function computeLinearRegressionLine(
  samples: ReadonlyArray<{ timestamp: string; close: number }>,
  endTimestamp: string,
): TrendLineSegment | null {
  // 有効値のみ抽出 (NaN / Infinity / 不正 timestamp は除外)
  const points: Array<{ t: number; y: number; timestamp: string }> = []
  for (const s of samples) {
    const t = new Date(s.timestamp).getTime()
    const y = s.close
    if (!Number.isFinite(t)) continue
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    points.push({ t, y, timestamp: s.timestamp })
  }
  if (points.length < 2) return null
  // 時系列で安定 sort (同 t は input 順を維持)
  points.sort((a, b) => a.t - b.t)
  // 全 sample が同 timestamp なら slope 不定
  if (points[0]!.t === points[points.length - 1]!.t) return null

  const tEnd = new Date(endTimestamp).getTime()
  if (!Number.isFinite(tEnd)) return null

  // OLS: y = a*t + b。t を「最古 sample 基準のオフセット」に正規化して
  // epoch ms (~1.7e12) 由来の桁あふれを抑える (slope は同じ)。
  const t0 = points[0]!.t
  let sumT = 0
  let sumY = 0
  for (const p of points) {
    sumT += p.t - t0
    sumY += p.y
  }
  const n = points.length
  const meanT = sumT / n
  const meanY = sumY / n
  let num = 0
  let den = 0
  for (const p of points) {
    const dt = p.t - t0 - meanT
    num += dt * (p.y - meanY)
    den += dt * dt
  }
  if (den === 0) return null
  const slope = num / den
  const intercept = meanY - slope * meanT
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null

  // 線の左端 = 最古 sample timestamp 上の regression y
  const startT = points[0]!.t
  const startY = intercept + slope * (startT - t0)
  // 右端 = endTimestamp 上の regression y (将来 / 既知点いずれでも線形外挿)
  const endY = intercept + slope * (tEnd - t0)
  if (!Number.isFinite(startY) || !Number.isFinite(endY)) return null

  const startPoint: PivotPoint = {
    timestamp: points[0]!.timestamp,
    price: startY,
    // type は描画上未使用。互換のため 'low' を入れておく (意味はない)
    type: 'low',
  }
  const endPoint: PivotPoint = {
    timestamp: endTimestamp,
    price: endY,
    type: 'low',
  }
  return {
    pivots: [startPoint, endPoint],
    end: { timestamp: endTimestamp, price: endY },
  }
}

/**
 * Trend line を「描画用の密点列」に展開する。
 *
 * 背景: ECharts の dataZoom + 2 点 line series は「片方の点が zoom 範囲外
 * になると線が引かれない」既知挙動が widely 報告されている (issue #3637 系)。
 * #189 で `filterMode: 'weakFilter'` に変更したが、それでもユーザ環境で
 * trend line が描画されないケースが残った。
 *
 * 最も robust な解決策は line の data 自体を「常に zoom 範囲内に複数点が
 * 入る粒度」にすること。ここでは intradayBars (1h candle、60 日で ~720 点)
 * の各 timestamp で trend line の y 値を線形補間して、`[[t, y], ...]` の
 * dense path に展開する。これで 5D (~120 点) や 1D zoom でも常に複数点が
 * visible になり filterMode 不問で確実に描画される。
 *
 * 線形外挿: trend line は本来両側に伸びる概念線なので、p1 より過去側 / end
 * より未来側の sample timestamp も同じ slope で外挿する (chart の見た目で
 * 線が早期に「途切れる」のを避ける)。
 *
 * Fallback: sampleTimestamps が空 (Yahoo intraday fetch 失敗時 = 0 件) の
 * とき、または line の 2 点が degenerate (t1 == t2) のときは 2 点
 * endpoint をそのまま返す (旧挙動 = 描画は zoom 不安定だが少なくとも
 * 全期間表示では出る)。
 */
export function densifyTrendLine(
  line: TrendLineSegment | null,
  sampleTimestamps: ReadonlyArray<string | number>,
): Array<[number, number]> | null {
  if (!line) return null
  const t1 = new Date(line.pivots[0].timestamp).getTime()
  const t2 = new Date(line.end.timestamp).getTime()
  const y1 = line.pivots[0].price
  const y2 = line.end.price
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null
  // degenerate: 2 点が同 timestamp → 線の slope 不定。fallback で 2 点返し。
  if (t1 === t2) return [[t1, y1], [t2, y2]]
  const slope = (y2 - y1) / (t2 - t1)
  // sample timestamps を epoch ms に正規化、無効値は除外、unique + 昇順
  const tsSet = new Set<number>()
  for (const s of sampleTimestamps) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (Number.isFinite(t)) tsSet.add(t)
  }
  // line の 2 点も常に含めて「pivot / end ちょうどでの y」を保証
  tsSet.add(t1)
  tsSet.add(t2)
  const sorted = Array.from(tsSet).sort((a, b) => a - b)
  // sample 0 件 (intradayBars 空) のときは 2 点 fallback
  if (sorted.length < 2) return [[t1, y1], [t2, y2]]
  const out: Array<[number, number]> = []
  for (const t of sorted) {
    const y = y1 + slope * (t - t1)
    if (Number.isFinite(y)) out.push([t, y])
  }
  // out が空になることは tsSet に t1/t2 を入れているのでまず無いが、
  // 安全のため最終 fallback。
  if (out.length < 2) return [[t1, y1], [t2, y2]]
  return out
}

/**
 * 保有中の avg / stop / take-profit のような「水平線分」を「描画用の密点列」
 * に展開する (`densifyTrendLine` と同じ目的の slope=0 特殊化)。
 *
 * 背景: 旧実装では candlestick の `markLine` に [{coord:[fromTs,y]}, {coord:[toTs,y]}]
 * の 2 点だけを渡していたが、ECharts の dataZoom + markLine は trend line と
 * 同様に「片端が zoom 範囲外になると markLine 全体が描画されない」回帰が
 * 起きる (#190 / #191 の trend line と同根、issue #3637 系)。1D zoom in で
 * `openedAt` が範囲外になり avg / stop / TP が一斉に消えるユーザ報告に
 * 対応するため、本関数で fromTs〜toTs を intradayBars timestamps で密化した
 * `[[t, y], ...]` に展開し、独立 `type: 'line'` series として描画する。
 *
 * 仕様:
 * - 戻り値は ascending order の `[t, y]` 配列。`fromTs` と `toTs` は端点として
 *   常に含む (sample に存在しなくても)。`samples` のうち `[fromTs, toTs]`
 *   範囲内のものを併合してユニーク化 + 昇順 sort。
 * - 水平線なので y は常に `yValue` (一定)。
 * - `fromTs > toTs` の degenerate ケース (openedAt > 最新 timestamp、cron が
 *   未だ走っていない直後) は 2 点 fallback `[[fromTs, y], [toTs, y]]`。
 *   呼び元側で既に `endTs = max(latestTs, openedAt)` の clamp をかけている
 *   ため通常は通らないが防御。
 * - `yValue` / `fromTs` / `toTs` が NaN / Infinity / 不正 ISO string なら null
 *   (描画 skip)。
 * - `samples` の不正値 (NaN / non-ISO string) は除外。
 */
export function densifyHorizontalLine(
  yValue: number,
  fromTs: string | number,
  toTs: string | number,
  samples: ReadonlyArray<string | number>,
): Array<[number, number]> | null {
  if (!Number.isFinite(yValue)) return null
  const a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime()
  const b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  // degenerate: fromTs >= toTs。端点 2 点だけ返す (描画は実質 1 点と同等
  // だが series.data が空にならないようにする)。
  if (a >= b) return [[a, yValue], [b, yValue]]
  const tsSet = new Set<number>()
  // 端点を必ず含める
  tsSet.add(a)
  tsSet.add(b)
  for (const s of samples) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (!Number.isFinite(t)) continue
    if (t < a || t > b) continue
    tsSet.add(t)
  }
  const sorted = Array.from(tsSet).sort((x, y) => x - y)
  return sorted.map((t) => [t, yValue] as [number, number])
}

/**
 * fill 行の BUY/SELL を決定する。
 * - 1st: pre_submit 行から JOIN で取得した side ('BUY'/'SELL') を採用
 * - 2nd: それも無い場合は realized_pnl の有無で推測
 *   - realized_pnl が null = entry trade (= BUY)
 *   - realized_pnl が非 null = exit trade (= SELL、reconcileFills が
 *     `(filled_price - prior avg) * filled_qty` で計算する)
 * - 3rd (defensive): どちらでも判断できなければ BUY (entry が圧倒的多数)
 */
export function resolveFillSide(
  preSide: string | null,
  realizedPnl: number | null,
): 'BUY' | 'SELL' {
  if (preSide === 'BUY' || preSide === 'SELL') return preSide
  if (realizedPnl !== null && Number.isFinite(realizedPnl)) return 'SELL'
  return 'BUY'
}

/**
 * SymbolStateDO から現保有を引く。binding 無し / 失敗時は undefined を返して
 * 呼び元に「derive にフォールバックすべき」と伝える (null は「DO 上明示的に無保有」)。
 */
async function fetchDoPosition(
  env: Env,
  symbol: string,
): Promise<SymbolChartPosition | null | undefined> {
  if (!env.SYMBOL_STATE) return undefined
  try {
    const state = await new SymbolStateClient(env.SYMBOL_STATE).getState(symbol)
    if (!state.position) return null
    return { avgPrice: state.position.avgPrice, openedAt: state.position.openedAt }
  } catch {
    return undefined
  }
}

/**
 * 直近 fills を時系列で巻き戻し、最後に「BUY → SELL」で閉じていなければ
 * 現保有とみなす。partial fill / position add は POC 未対応 (直近 BUY だけ採用)。
 */
export function deriveOpenPosition(markers: SymbolChartMarker[]): SymbolChartPosition | null {
  let latestBuy: SymbolChartMarker | null = null
  for (const m of markers) {
    if (m.side === 'BUY') latestBuy = m
    else if (m.side === 'SELL') latestBuy = null
  }
  return latestBuy ? { avgPrice: latestBuy.price, openedAt: latestBuy.timestamp } : null
}

export function extractSma50(indicatorsJson: string | null): number | null {
  return parseIndicators(indicatorsJson).sma50
}

interface ExtractedIndicators {
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

/**
 * indicators_json から chart で使う数値を一括抽出。JSON.parse 失敗 / 数値外は null。
 * low20d は #158 follow-up で追加されたため、既存の indicators_json には未収録 →
 * 古い行は null fallback で grace 化。新しい cron 実行から徐々に出揃う。
 */
function parseIndicators(indicatorsJson: string | null): ExtractedIndicators {
  if (!indicatorsJson) return { sma50: null, high20d: null, low20d: null }
  try {
    const obj = JSON.parse(indicatorsJson) as {
      sma50?: unknown
      high20d?: unknown
      low20d?: unknown
    }
    return {
      sma50:
        typeof obj.sma50 === 'number' && Number.isFinite(obj.sma50) ? obj.sma50 : null,
      high20d:
        typeof obj.high20d === 'number' && Number.isFinite(obj.high20d) ? obj.high20d : null,
      low20d:
        typeof obj.low20d === 'number' && Number.isFinite(obj.low20d) ? obj.low20d : null,
    }
  } catch {
    return { sma50: null, high20d: null, low20d: null }
  }
}

/**
 * `<script>...</script>` 内に埋め込む JSON を XSS 安全にする。
 * ブラウザは `</script>` を「文字列の中でも」script 終端と解釈するので、
 * `<` を unicode escape して中和する。
 */
export function safeJsonScript(varName: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script>window.${varName} = ${json};</script>`
}

export type ChartsTab = 'overview' | 'quality' | 'symbol' | 'grid'

export function parseChartsTab(value: string | undefined): ChartsTab {
  if (value === 'quality' || value === 'symbol' || value === 'grid') return value
  return 'overview'
}

const CHART_TABS: Array<{ id: ChartsTab; label: string; hint: string }> = [
  { id: 'overview', label: '概要', hint: 'エクイティカーブ + ドローダウン (戦略を続けるか止めるかの判断)' },
  { id: 'quality', label: '取引品質', hint: 'PnL 分布 + 統計 + Decision breakdown (エッジ / rule の機能性)' },
  { id: 'symbol', label: '個別銘柄', hint: '価格 + SMA50 + entry/exit (rule と現実の整合)' },
  { id: 'grid', label: '銘柄グリッド', hint: 'ALLOWED_SYMBOLS を 4 列 grid で並列表示。dataZoom は全 panel 同期 (Datadog 風)' },
]

interface ChartsBodyOverview {
  tab: 'overview'
  equity: EquityPoint[]
}

interface ChartsBodyQuality {
  tab: 'quality'
  decisions: DecisionBreakdownPoint[]
  pnls: number[]
  stats: TradeStats
  histogram: PnlHistogramBin[]
}

/**
 * 戦略パラメータの現在値スナップショット (PullbackUptrendStrategy)。
 * チャート併置パネルで「今どのルールで動いているか」を見せるための
 * read-only view (#168)。default 値からの変更はパネル側で ⚠ flag。
 */
export interface StrategyParamsSnapshot {
  stopPct: number
  takeProfitPct: number
  timeStopDays: number
  pullbackMax: number
  pullbackMin: number
  minReturn50d: number
  requireAboveSma50: boolean
  kAtr: number
}

/**
 * ISO UTC timestamp (例: "2026-04-15T00:00:00Z") をパースして Date を返す。
 * timezone marker (末尾 Z または ±HH:MM offset) が無い datetime 文字列は
 * `new Date` だと local time 扱いになり (JST runner で意図しないシフト)、
 * JSDoc の "UTC timestamp" 約束に違反する。`T` を含むのに tz が無ければ
 * `Z` を補って UTC と解釈させる。date-only ("2026-04-15") は ECMAScript
 * 仕様で既に UTC 解釈なので変更不要。
 */
export function parseIsoTimestamp(raw: string | undefined): Date | null {
  if (!raw || raw.trim() === '') return null
  let s = raw.trim()
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)
  if (s.includes('T') && !hasTz) {
    s = `${s}Z`
  }
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return null
  return d
}

/** chart の zoom 初期 window 既定: 直近 7 日 (UI で zoom 操作可能) */
export const DEFAULT_ZOOM_WINDOW_MS = 7 * 24 * 3600 * 1000

/**
 * chart x-axis の zoom 範囲を決める:
 * 1. URL params (zoomFrom / zoomTo) が valid (from < to) → それを採用
 * 2. URL に無い + chart に points がある → 直近 7 日 (lastTimestamp - 7d ～ lastTimestamp)
 * 3. それ以外 (chart 自体空) → null (= 全体表示 / no zoom)
 *
 * lastTimestamp 基準なので、休場日や POC 開始直後で `now()` 基準が data
 * 範囲外になるケースでも broken にならない。
 */
export function computeZoomRange(
  zoomFrom: Date | null,
  zoomTo: Date | null,
  chart: SymbolChartData | null,
): { from: Date; to: Date } | null {
  if (zoomFrom !== null && zoomTo !== null && zoomFrom < zoomTo) {
    return { from: zoomFrom, to: zoomTo }
  }
  if (!chart || chart.points.length === 0) return null
  const lastPoint = chart.points[chart.points.length - 1]!
  const lastMs = new Date(lastPoint.timestamp).getTime()
  if (!Number.isFinite(lastMs)) return null
  return {
    from: new Date(lastMs - DEFAULT_ZOOM_WINDOW_MS),
    to: new Date(lastMs),
  }
}

interface ChartsBodySymbol {
  tab: 'symbol'
  focusSymbol: string | null
  symbolChart: SymbolChartData | null
  availableSymbols: string[]
  strategyParams: StrategyParamsSnapshot
  /** dataZoom 初期範囲。null なら全期間 (full data) */
  zoom: { from: Date; to: Date } | null
  /** symbol picker / chart title を JP 銘柄向け 番号-会社名 形式に整形するための universe。 */
  universe?: SymbolUniverse | null
}

/**
 * 銘柄グリッドビュー: ALLOWED_SYMBOLS を 4 列 (responsive) grid で並列表示。
 * `echarts.connect` で **dataZoom + axisPointer (縦線)** を全 panel 同期、
 * **tooltip popup は hover 中の panel だけ** に表示する (formatter 内で
 * window.__gridHoveredPanelId !== elId の panel は空文字を返し popup を抑制、
 * PR #242)。preset zoom (1D/5D/1M/All) も dispatchAction で全 chart に配信。
 */
interface ChartsBodyGrid {
  tab: 'grid'
  /**
   * Grid に表示する全銘柄 (active + inactive) の SymbolChartData。load 失敗時は
   * `chart === null`。inactive 銘柄も同じ Map から render し、panel header に
   * INACTIVE バッジ + grayed style を付与して識別する (`isSymbolInactive` で判定)。
   *
   * PR #229 で inactive を grid から外したが、operator から「inactive 銘柄も
   * 動向確認したい」要望があったため復活。subrequest budget は per-symbol catch
   * で graceful degrade (個別 panel が空になるだけ、grid 全体は描画される)。
   */
  charts: Array<{ symbol: string; chart: SymbolChartData | null; error: string | null }>
  /** dataZoom 初期範囲。null なら全期間 */
  zoom: { from: Date; to: Date } | null
  /** panel header の銘柄表示を JP 銘柄向け 番号-会社名 形式にするための universe。 */
  universe?: SymbolUniverse | null
}

type ChartsBodyArgs =
  | ChartsBodyOverview
  | ChartsBodyQuality
  | ChartsBodySymbol
  | ChartsBodyGrid

/**
 * Chart 上部に出す tab strip。現在 tab には active 装飾、他は通常リンク。
 */
function renderTabStrip(active: ChartsTab, focusSymbol?: string): string {
  const tabs = CHART_TABS.map((t) => {
    const style =
      t.id === active
        ? 'font-weight:600;text-decoration:underline;background:#fff;border-color:#06c;color:#06c'
        : ''
    const baseStyle = 'display:inline-block;padding:4px 12px;margin-right:6px;border:1px solid #d0d0d5;border-radius:6px;background:#fafafa;color:#1d1d1f;text-decoration:none;'

    if (t.id === active) {
      return `<span title="${esc(t.hint)}" style="${baseStyle}${style}">${esc(t.label)}</span>`
    }

    let href = `/dashboard/charts?tab=${t.id}`
    if (t.id === 'symbol' && focusSymbol) {
      href += `&symbol=${encodeURIComponent(focusSymbol)}`
    }

    return `<a href="${href}" title="${esc(t.hint)}" style="${baseStyle}${style}">${esc(t.label)}</a>`
  }).join('')
  return `<nav style="margin:0 0 12px 0">${tabs}</nav>`
}

function chartsBody(args: ChartsBodyArgs): string {
  const focusSymbol = args.tab === 'symbol' ? args.focusSymbol ?? undefined : undefined
  const tabStrip = renderTabStrip(args.tab, focusSymbol)
  if (args.tab === 'overview') return tabStrip + renderOverviewTab(args)
  if (args.tab === 'quality') return tabStrip + renderQualityTab(args)
  if (args.tab === 'grid') return tabStrip + renderGridTab(args)
  return tabStrip + renderSymbolTab(args)
}

function renderOverviewTab(args: ChartsBodyOverview): string {
  if (args.equity.length === 0) {
    return `<p class="muted">まだ実 fill (realized_pnl) が無いためエクイティカーブを描けません。最初の SELL が約定すると表示されます。</p>`
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var dates = data.equity.map(function (p) { return p.date; });
      var equity = data.equity.map(function (p) { return p.cumulativePnl; });
      var dd = data.equity.map(function (p) { return p.drawdownPct * 100; });
      var equityChart = echarts.init(document.getElementById('equity-chart'));
      equityChart.setOption({
        title: { text: '累積 realized PnL', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2); } },
        grid: { left: 50, right: 20, top: 40, bottom: 40 },
        xAxis: { type: 'category', data: dates },
        yAxis: { type: 'value', name: 'PnL', axisLabel: { formatter: '{value}' } },
        series: [{ type: 'line', data: equity, smooth: false, areaStyle: { opacity: 0.1 }, lineStyle: { width: 2 } }],
      });
      var ddChart = echarts.init(document.getElementById('dd-chart'));
      ddChart.setOption({
        title: { text: 'ドローダウン (累積 PnL の peak からの低下率)', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2) + '%'; } },
        grid: { left: 50, right: 20, top: 40, bottom: 40 },
        xAxis: { type: 'category', data: dates },
        yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
        series: [{ type: 'line', data: dd, areaStyle: { color: '#c22', opacity: 0.2 }, lineStyle: { color: '#c22', width: 1 } }],
      });
      window.addEventListener('resize', function () { equityChart.resize(); ddChart.resize(); });
    });
  `
  return `<p class="muted" style="font-size:12px">
    累積 realized PnL と peak からの下落率 (MaxDD)。戦略の長期パフォーマンス指標。
    シード資金額を保持していないため下落率は「累積 PnL の peak からの相対」で計算
    (peak ≤ 0 のときは 0%)。当日 intraday の risk halt 閾値 (drawdown_kill /
    risk_dd_halt) は別概念のため重畳しない。
  </p>
  <div id="equity-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  <div id="dd-chart" style="width:100%;height:280px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${safeJsonScript('__chartData', { equity: args.equity })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

function renderQualityTab(args: ChartsBodyQuality): string {
  if (args.pnls.length === 0 && args.decisions.length === 0) {
    return `<p class="muted">まだ判定ログも実 fill も無いため取引品質を描けません。cron が動き出すと judgement breakdown、SELL が約定すると PnL 分布が出ます。</p>`
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var DECISION_KEYS = ['BUY', 'SELL', 'HOLD', 'REJECT', 'ERROR'];
      var DECISION_COLORS = { BUY: '#057a55', SELL: '#1471a8', HOLD: '#aaa', REJECT: '#b25000', ERROR: '#c22' };
      var dbDates = data.decisions.map(function (p) { return p.date; });
      var dbEl = document.getElementById('decision-chart');
      if (dbEl && dbDates.length > 0) {
        var dbChart = echarts.init(dbEl);
        dbChart.setOption({
          title: { text: '日次 Decision breakdown (BUY / SELL / HOLD / REJECT / ERROR)', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 22 },
          grid: { left: 50, right: 20, top: 60, bottom: 40 },
          xAxis: { type: 'category', data: dbDates },
          yAxis: { type: 'value', name: '判定数' },
          series: DECISION_KEYS.map(function (k) {
            return { name: k, type: 'bar', stack: 'decisions',
              data: data.decisions.map(function (p) { return p.counts[k] || 0; }),
              itemStyle: { color: DECISION_COLORS[k] } };
          }),
        });
        window.addEventListener('resize', function () { dbChart.resize(); });
      }
      var pnlHistEl = document.getElementById('pnl-hist-chart');
      if (pnlHistEl && data.histogram && data.histogram.length > 0) {
        var pnlHist = echarts.init(pnlHistEl);
        pnlHist.setOption({
          title: { text: 'Per-trade realized PnL 分布', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: function (params) { var p = params[0]; return p.name + ': ' + p.value + ' trades'; } },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: data.histogram.map(function (b) { return b.label; }) },
          yAxis: { type: 'value', name: 'trades' },
          series: [{ type: 'bar',
            data: data.histogram.map(function (b) {
              return { value: b.count, itemStyle: { color: b.binCenter >= 0 ? '#057a55' : '#c22' } };
            }) }],
        });
        window.addEventListener('resize', function () { pnlHist.resize(); });
      }
    });
  `
  return `<div id="pnl-hist-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${renderTradeStatsTable(args.stats)}
  <div id="decision-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${safeJsonScript('__chartData', { decisions: args.decisions, histogram: args.histogram })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

function renderSymbolTab(args: ChartsBodySymbol): string {
  const noData =
    args.symbolChart === null ||
    args.symbolChart.points.length === 0
  if (noData) {
    return (
      renderSymbolPickerForTab(args) +
      `<p class="muted">この銘柄にはまだ判定ログ / fill がありません。</p>` +
      renderStrategyParamsPanel(args.strategyParams)
    )
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var sc = data.symbolChart;
      if (!sc || sc.points.length === 0) return;

      // xAxis 戦略:
      //   intradayBars が揃っているとき → category axis (categories = 各 bar の
      //     ISO timestamp)。overnight / 週末 / 米国祝日の空白を「詰めて」表示する
      //     (TradingView 等と同様の挙動)。ECharts の time axis では非取引時間を
      //     skip する native 機能が無いため、category 化が standard 解。
      //   intradayBars が空 (Yahoo intraday fetch 失敗) → time axis fallback。
      //     candle が無いので gap も発生せず、line / markPoint だけ実時刻で描画。
      // category mode では「category index」を全 series の x として揃える。
      // markPoint も coord に [categoryIndex, price] を渡す。
      var ohlcBars = sc.intradayBars || [];
      var useCategoryAxis = ohlcBars.length > 0;
      var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
      var categories = ohlcBars.map(function (b) { return b.timestamp; });

      // セッション境界 (休場 → 開場) 検出:
      // category axis 化で休場 gap が詰まった結果 (#193)、視覚的に
      // 「どこから新セッションか」が分かりにくくなった。1h interval なので
      // 隣接 bar は通常 60 分差。週末 / 夜間 closed 後の最初の bar は数時間〜
      // 数十時間ぶんの差が空く。閾値 90 分 (= 1.5h) で safe に検出し、後ろ側
      // category index を「新セッションの開場点」として markLine 描画する。
      // useCategoryAxis === false (intradayBars 空) の場合は描画 skip。
      var sessionOpenIndices = [];
      if (useCategoryAxis) {
        var SESSION_GAP_MS = 90 * 60 * 1000;
        for (var si = 1; si < ohlcMs.length; si++) {
          if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
        }
      }

      // Map a millisecond timestamp to the nearest category index.
      // ohlcMs は intradayBars の順序 (= Yahoo の昇順) を保つ前提。binary search
      // で近接 index を返す。ohlcMs 空 (= time axis fallback) なら -1。
      function nearestIndex(ms) {
        if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
        var lo = 0, hi = ohlcMs.length - 1;
        if (ms <= ohlcMs[0]) return 0;
        if (ms >= ohlcMs[hi]) return hi;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
        }
        // lo は ms 以上の最初の index。一つ前と比べて近い方を採用。
        if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
        return lo;
      }

      // category mode では x = category index、time mode では x = ISO timestamp
      // (= category 値そのもの)。両 mode を同じ shape (x, y) で扱えるよう抽象化。
      function xForTimestamp(ts) {
        if (useCategoryAxis) {
          var idx = nearestIndex(new Date(ts).getTime());
          return idx;
        }
        return ts;
      }
      function xForMs(ms) {
        if (useCategoryAxis) return nearestIndex(ms);
        return ms;
      }

      var jstFmt = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      function jstLabel(value) {
        return jstFmt.format(new Date(value)).replace(/\\//g, '/');
      }
      // fill 時刻は秒精度で表示 (同分内 fills を区別するため)。axisLabel は
      // 分単位で密度を保つ (秒まで出すと x 軸ラベルが詰まる)。
      var jstFmtSec = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      function jstLabelSec(value) {
        return jstFmtSec.format(new Date(value)).replace(/\\//g, '/');
      }
      // category index → 表示 label。category 値は ISO timestamp なのでそのまま JST 化。
      function jstLabelForX(value) {
        if (useCategoryAxis) {
          // value は category 値 (ISO string) または index。axisLabel formatter に
          // 来るのは index/value (params.value=ISO)、dataZoom labelFormatter は
          // value=ISO string が来る (slider 端点の category 値)。
          if (typeof value === 'number') {
            // index として渡される場合 (recomputeYAxis 由来等)
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }
        return jstLabel(value);
      }

      // candlestick の data shape: [open, close, low, high]。category mode では
      // index ベースなので 4 値だけ並べれば ECharts が categories 配列と対応付ける。
      // time mode では [timestamp, open, close, low, high] の 5 値タプル。
      var ohlcXY = useCategoryAxis
        ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
        : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });
      // SMA50 line: cron-eval points から取得 (daily で計算された値の推移)。
      // category mode では point の timestamp を最近接 ohlc index に snap して
      // [index, value] で渡す。時間軸の連続性は category 上で保たれる。
      var smasXY = sc.points.map(function (p) {
        if (p.sma50 == null) return [xForTimestamp(p.timestamp), null];
        return [xForTimestamp(p.timestamp), p.sma50];
      });
      // (close line は削除: candle が close を含むので冗長、overnight gap で
      //  斜めに横断する視覚ノイズが発生していたため #176 → #177 で除去)

      // 押し目買いゾーン:
      // - 上端 = high20d × (1 + pullbackMax)  ≒ 教科書の「上値抵抗線 (resistance)」
      // - 下端 = high20d × (1 + pullbackMin)  = 押し目買いの下限 (-15% 以下は深すぎ)
      var pullbackMaxMul = 1 + sc.rules.pullbackMax;
      var pullbackMinMul = 1 + sc.rules.pullbackMin;
      // 帯の描画は 3 層で構成 (#237 follow-up):
      //   1. markArea fill (薄オレンジ): 「現在の押し目ゾーン (latest high20d 基準)」
      //      を flat に塗って即座にレンジを把握させる。
      //   2. per-timestamp dashed line × 2 (上端 / 下端): 各日の high20d × mul を
      //      たどる斜めライン。SOXL のように high20d が右肩上がりで動く銘柄では
      //      flat な markArea とのズレが大きく、傾きで「押し目ゾーンが日々どう動
      //      いてるか」を可視化する。
      // 元々 (#232 follow-up) は 1 だけにしていたが、価格 momentum が大きい銘柄で
      // 「平行な帯が実態とズレて見える」issue → 1+2 のハイブリッドに戻す。
      // markArea の opacity は重ね描きで濃くなりすぎないよう 0.12 → 0.08 に下げる。
      var latestHigh20d = null;
      for (var lhi = sc.points.length - 1; lhi >= 0; lhi -= 1) {
        var lhp = sc.points[lhi];
        if (lhp && typeof lhp.high20d === 'number' && isFinite(lhp.high20d)) {
          latestHigh20d = lhp.high20d;
          break;
        }
      }
      var bandUpperY = latestHigh20d == null ? null : latestHigh20d * pullbackMaxMul;
      var bandLowerY = latestHigh20d == null ? null : latestHigh20d * pullbackMinMul;
      var bandTopY = null;
      var bandBottomY = null;
      if (Number.isFinite(bandUpperY) && Number.isFinite(bandLowerY)) {
        bandTopY = Math.max(bandUpperY, bandLowerY);
        bandBottomY = Math.min(bandUpperY, bandLowerY);
      }
      var pullbackBandMarkArea = (bandTopY != null && bandBottomY != null) ? {
        silent: true,
        itemStyle: {
          color: 'rgba(255, 180, 50, 0.08)',
          borderColor: 'rgba(255, 140, 0, 0.35)',
          borderWidth: 1,
          borderType: 'dashed',
        },
        data: [[
          { yAxis: bandBottomY },
          { yAxis: bandTopY },
        ]],
      } : null;

      // per-timestamp の押し目ゾーン上下端 (sloped 2 lines)。各 point.high20d ×
      // pullbackMaxMul / pullbackMinMul を辿る。high20d が null の point は
      // null を入れて echarts に segment break させる (connectNulls=false)。
      var pullbackUpperXY = sc.points.map(function (p) {
        var x = xForTimestamp(p.timestamp);
        if (typeof p.high20d !== 'number' || !isFinite(p.high20d)) return [x, null];
        return [x, p.high20d * pullbackMaxMul];
      });
      var pullbackLowerXY = sc.points.map(function (p) {
        var x = xForTimestamp(p.timestamp);
        if (typeof p.high20d !== 'number' || !isFinite(p.high20d)) return [x, null];
        return [x, p.high20d * pullbackMinMul];
      });
      // 全点 null の場合は line series を出さない (legend を汚さない)。
      var pullbackBandHasData =
        pullbackUpperXY.some(function (xy) { return xy[1] != null; }) &&
        pullbackLowerXY.some(function (xy) { return xy[1] != null; });

      // 価格トレンド線 (server-side で daily close の linear regression fit)。
      // 旧仕様の「上値抵抗線 / 下値支持線」上下 2 本は、ローソク足の上下を
      // flat に走り「価格の中心を辿る trend」という user 期待と乖離していた
      // ため、close の重心を通る best-fit 1 本に統一した。
      //
      // 検出失敗 (sample < 2 / 同時刻のみ) なら null → 描画スキップ。
      //
      // 過去 #185 / #187 / #188 / #189 で「描画されない」回帰があったが、
      // 根因は ECharts の dataZoom + 2 点 line series が「片方の点が zoom
      // 範囲外になると線が引かれない」既知挙動 (issue #3637 系)。#189 で
      // dataZoom の filterMode を 'weakFilter' に変えて改善したが、それでも
      // ユーザ環境で残ケースがあった。本質的に robust にするため、line の
      // data 自体を「常に zoom 範囲内に複数点が入る粒度」に展開する。
      //
      // 具体的には intradayBars (1h candle、60 日で ~720 点) の各 timestamp
      // で trend line の y 値を線形補間し、[[t, y], ...] の dense path にす
      // る。これで 5D (~120 点) や 1D zoom でも複数点が必ず visible になり
      // filterMode 不問で線分が描画される。intradayBars が空 (Yahoo fetch
      // 失敗) のときは 2 点 endpoint fallback (旧挙動)。
      //
      // 線形外挿: trend line は概念上両側に伸びる線なので、p1 より過去側 /
      // end より未来側の sample も同じ slope で外挿する。
      //
      // ※ Server-side densifyTrendLine (export) と同じアルゴリズム。
      //    unit test はそちらで担保する。client 側に inline するのは sc.*
      //    オブジェクトを HTML script に埋めて echarts.init で消費するため。
      // category mode では sample を「各 ohlc bar の ms」として展開した後、
      // 結果の [t, y] 配列を index ベース [i, y] に変換する (ohlcMs[i] === t を
      // 満たすので 1:1 対応)。time mode では従来通り [t, y] のまま渡す。
      var ohlcTimestamps = ohlcMs.slice();
      function densifyTrendLine(line, sampleTimestamps) {
        if (!line) return null;
        var t1 = new Date(line.pivots[0].timestamp).getTime();
        var t2 = new Date(line.end.timestamp).getTime();
        var y1 = line.pivots[0].price;
        var y2 = line.end.price;
        if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
        if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
        if (t1 === t2) return [[t1, y1], [t2, y2]];
        var slope = (y2 - y1) / (t2 - t1);
        var seen = Object.create(null);
        var arr = [];
        for (var i = 0; i < sampleTimestamps.length; i += 1) {
          var t = sampleTimestamps[i];
          if (!Number.isFinite(t)) continue;
          if (seen[t]) continue;
          seen[t] = true;
          arr.push(t);
        }
        if (!seen[t1]) { seen[t1] = true; arr.push(t1); }
        if (!seen[t2]) { seen[t2] = true; arr.push(t2); }
        arr.sort(function (a, b) { return a - b; });
        if (arr.length < 2) return [[t1, y1], [t2, y2]];
        var out = [];
        for (var j = 0; j < arr.length; j += 1) {
          var tj = arr[j];
          var yj = y1 + slope * (tj - t1);
          if (Number.isFinite(yj)) out.push([tj, yj]);
        }
        if (out.length < 2) return [[t1, y1], [t2, y2]];
        return out;
      }
      // category mode 用: [t, y] 配列を [index, y] に変換。t が ohlcMs に
      // 一致しない (= line endpoint が intradayBars の外) なら最近接 index に
      // snap される。line の中で同じ index に複数 y が落ちる場合は最初の y
      // のみ採用 (理論上 slope=0 の degenerate / endpoint クランプ時のみ発生)。
      function toCategoryXY(tyArr) {
        if (!tyArr) return null;
        if (!useCategoryAxis) return tyArr;
        var seenIdx = Object.create(null);
        var out = [];
        for (var i = 0; i < tyArr.length; i += 1) {
          var t = tyArr[i][0];
          var y = tyArr[i][1];
          var idx = nearestIndex(t);
          if (idx < 0) continue;
          if (seenIdx[idx]) continue;
          seenIdx[idx] = true;
          out.push([idx, y]);
        }
        // sort by index (nearest snap might reorder when endpoints clamp to same idx)
        out.sort(function (a, b) { return a[0] - b[0]; });
        return out.length > 0 ? out : null;
      }
      var trendLineXY = toCategoryXY(densifyTrendLine(sc.trendLine, ohlcTimestamps));

      // markPoint は xAxis: ISO timestamp (time axis 上の実時刻位置)。category 不一致問題なし。
      // pin label を短縮: BUY/SELL は色 (緑/赤) で識別、price だけ表示。
      // close-time fill (15 分以内) で label 重なりが起きにくい。pnl は SELL のみ
      // 末尾に小数 1 桁で付与 (例: "120.19 +0.4")。詳細 (full-precision PnL /
      // qty / timestamp) は markPoint hover tooltip で表示。
      // realizedPnl と filledQty を data に保持し tooltip.formatter から
      // full-precision で読む (label の toFixed(1) で丸めた値とは独立)。
      // pin label は「全 fill 中で最新」の 1 個だけ表示。それより古いのは
      // 全部 marker のみで label.show: false。BUY と SELL を別々に最新採用
      // していた旧仕様だと近接する BUY→SELL pair で label が重なる回帰が
      // あったため、現保有 status を表す「最後のアクション」だけ強調。
      // 過去の fill 詳細は hover tooltip (full-precision PnL / qty / 時刻) で。
      var buys = sc.markers.filter(function (m) { return m.side === 'BUY'; });
      var sells = sc.markers.filter(function (m) { return m.side === 'SELL'; });
      var latestFillTs = sc.markers.length > 0
        ? sc.markers[sc.markers.length - 1].timestamp
        : null;
      // category mode では markPoint coord に [categoryIndex, price] を渡す。
      // fill 時刻を最近接 ohlc bar (= 1h 粒度) の index に snap するため、同 1h
      // 内の複数 fill は同じ index に重なる。pin label は側 (top/bottom) と色で
      // 区別するため重なっても 1 件は読める。fillTimestamp は秒精度を保持して
      // hover tooltip で full-precision 時刻として表示される (情報損失なし)。
      var entries = buys.map(function (m) {
        var showLabel = m.timestamp === latestFillTs;
        return {
          name: 'BUY', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
          realizedPnl: null, qty: m.qty, fillTimestamp: m.timestamp,
          label: { show: showLabel, formatter: m.price.toFixed(2), color: '#057a55', position: 'top', distance: 6, fontSize: 11 },
          itemStyle: { color: '#057a55' },
        };
      });
      var exits = sells.map(function (m) {
        var showLabel = m.timestamp === latestFillTs;
        var pnlLabel = m.realizedPnl == null ? '' : ' ' + (m.realizedPnl >= 0 ? '+' : '') + m.realizedPnl.toFixed(1);
        return {
          name: 'SELL', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
          realizedPnl: m.realizedPnl, qty: m.qty, fillTimestamp: m.timestamp,
          label: { show: showLabel, formatter: m.price.toFixed(2) + pnlLabel, color: '#c22', position: 'bottom', distance: 6, fontSize: 11 },
          itemStyle: { color: '#c22' },
        };
      });

      // 保有中なら avg / stop / take-profit を「dense path の独立 line series」
      // として描画。openedAt から最新までのみ描画 (chart 全幅に伸ばすと
      // 「ずっと前から avg だった」と誤読される) のは旧仕様 (markLine 方式) と
      // 同じだが、ECharts dataZoom + 2 点 markLine は trend line と同様
      // 「片端が zoom 範囲外になると線が消える」回帰があるため (#190 / #191
      // と同根、issue #3637 系)、densifyHorizontalLine で intradayBars
      // 各 timestamp に y を割り当てた dense path に展開する。これで 1D zoom
      // でも複数点が必ず visible になり filterMode 不問で線が描画される。
      // ※ Server-side densifyHorizontalLine (export) と同じアルゴリズム。
      //    unit test はそちらで担保する。
      function densifyHorizontalLine(yValue, fromTs, toTs, samples) {
        if (!Number.isFinite(yValue)) return null;
        var a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime();
        var b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime();
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        if (a >= b) return [[a, yValue], [b, yValue]];
        var seen = Object.create(null);
        var arr = [];
        function push(t) {
          if (seen[t]) return;
          seen[t] = true;
          arr.push(t);
        }
        push(a);
        push(b);
        for (var i = 0; i < samples.length; i += 1) {
          var t = samples[i];
          if (!Number.isFinite(t)) continue;
          if (t < a || t > b) continue;
          push(t);
        }
        arr.sort(function (x, y) { return x - y; });
        var out = [];
        for (var j = 0; j < arr.length; j += 1) {
          out.push([arr[j], yValue]);
        }
        return out;
      }
      var avgLineXY = null;
      var stopLineXY = null;
      var tpLineXY = null;
      var avgLabel = '';
      var stopLabel = '';
      var tpLabel = '';
      // 保有ナシ時に「もし今 BUY したら」の損切り / 利食い水準を仮置きで描く
      // preview lines。virtualAvg = sc.latestCronPrice (= 直近 cron eval で
      // strategy 評価に使った価格) を仮の avg と見立てる。
      // sc.points[末尾] を使うと Yahoo daily filler が末尾に来ているケース
      // (cron 停止中 / 銘柄古い) で「過去 Yahoo close」を avg にしてしまい、
      // user に「最新評価値」と誤解させる。latestCronPrice が null = 評価履歴
      // 自体が無い → preview line そのものを描画スキップする。
      // dotted + opacity 0.5 で「actual position ではない」と区別する。
      var previewStopLineXY = null;
      var previewTpLineXY = null;
      var previewStopLabel = '';
      var previewTpLabel = '';
      var extraYValues = [];
      if (sc.position) {
        var avg = sc.position.avgPrice;
        var stopPrice = avg * (1 + sc.rules.stopPct);
        var tpPrice = avg * (1 + sc.rules.takeProfitPct);
        extraYValues.push(avg, stopPrice, tpPrice);
        var openedAt = sc.position.openedAt;
        // openedAt > 最新 point (chart データが古い / position 直後でまだ
        // strategy_decision_log に記録されていない) のとき、endTs が openedAt
        // より過去に出ると線が逆向き (左側) に伸びる。max で clamp。
        var latestTs = sc.points.length > 0 ? sc.points[sc.points.length - 1].timestamp : openedAt;
        var endTs = new Date(latestTs).getTime() >= new Date(openedAt).getTime()
          ? latestTs
          : openedAt;
        var fromMs = new Date(openedAt).getTime();
        var toMs = new Date(endTs).getTime();
        avgLineXY = toCategoryXY(densifyHorizontalLine(avg, fromMs, toMs, ohlcTimestamps));
        stopLineXY = toCategoryXY(densifyHorizontalLine(stopPrice, fromMs, toMs, ohlcTimestamps));
        tpLineXY = toCategoryXY(densifyHorizontalLine(tpPrice, fromMs, toMs, ohlcTimestamps));
        avgLabel = 'avg ' + avg.toFixed(2);
        stopLabel = 'stop ' + stopPrice.toFixed(2) + ' (' + (sc.rules.stopPct * 100).toFixed(0) + '%)';
        tpLabel = 'TP ' + tpPrice.toFixed(2) + ' (+' + (sc.rules.takeProfitPct * 100).toFixed(0) + '%)';
      } else if (
        sc.points.length > 0 &&
        sc.latestCronPrice != null &&
        sc.latestCronPrice > 0 &&
        sc.latestCronTimestamp != null
      ) {
        var virtualAvg = sc.latestCronPrice;
        var pStopPrice = virtualAvg * (1 + sc.rules.stopPct);
        var pTpPrice = virtualAvg * (1 + sc.rules.takeProfitPct);
        extraYValues.push(pStopPrice, pTpPrice);
        // preview line の x 範囲: chart 開始 → 最新 cron eval timestamp。
        // 末尾を Yahoo filler 末尾まで伸ばすと「最新 cron 以降の Yahoo 区間」
        // にも線が出てしまい virtualAvg と整合しないので latestCron まで。
        var pFromMs = new Date(sc.points[0].timestamp).getTime();
        var pToMs = new Date(sc.latestCronTimestamp).getTime();
        if (Number.isFinite(pFromMs) && Number.isFinite(pToMs)) {
          previewStopLineXY = toCategoryXY(densifyHorizontalLine(pStopPrice, pFromMs, pToMs, ohlcTimestamps));
          previewTpLineXY = toCategoryXY(densifyHorizontalLine(pTpPrice, pFromMs, pToMs, ohlcTimestamps));
          // label は actual stop/TP と長さを揃える (右端で見切れないよう
          // "preview" prefix ではなく "(preview)" suffix にして、actual の
          // "stop X (-Y%)" と同等の幅に収める)。
          previewStopLabel = 'stop ' + pStopPrice.toFixed(2) + ' (preview)';
          previewTpLabel = 'TP ' + pTpPrice.toFixed(2) + ' (preview)';
        }
      }

      // ECharts の scale:true は markLine を yAxis range に含めないため、
      // TP / stop が data 範囲外だと枠の外で見えなくなる。data 全体 +
      // position lines + markers を考慮した explicit min/max + padding。
      // NaN / Infinity が混入すると Math.min/max が NaN を返し、
      // 結果 yAxis が壊れる (axis label に巨大数が出る回帰例あり) ので
      // pushIfFinite で防御。
      var allY = [];
      function pushIfFinite(v) {
        if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
      }
      // y軸は candle の高低 + markers + position 線だけで decide。
      // SMA50 (long-term、現在価格と乖離大) / band / low20d / trend line を
      // 入れると軸 range が必要以上に広がり candle が縦圧縮される
      // (trader-strategist 助言)。これらは line として描画はする
      // (auto-clip で軸外は切れる) が、軸 range には影響させない。
      (sc.intradayBars || []).forEach(function (b) {
        pushIfFinite(b.high);
        pushIfFinite(b.low);
      });
      sc.markers.forEach(function (m) { pushIfFinite(m.price); });
      extraYValues.forEach(function (v) { pushIfFinite(v); });
      var yMin, yMax;
      if (allY.length > 0) {
        var rawMin = Math.min.apply(null, allY);
        var rawMax = Math.max.apply(null, allY);
        if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
          var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
          yMin = rawMin - pad;
          yMax = rawMax + pad;
        }
      }

      // dataZoom: 下部 slider + inside (wheel/pinch zoom)。初期 zoom 範囲は
      // ?from / ?to URL params (data.zoomFromMs / zoomToMs)。zoom 操作時に
      // history.replaceState で URL を更新 → 銘柄切替を跨いでも range を維持。
      // category mode では startValue/endValue が「category index」を指す。
      // URL 由来の ms 範囲は最近接 index に snap して dataZoom に渡す。
      // time mode (intradayBars 空) では従来通り ms をそのまま startValue に。
      var dzInitial = (function () {
        if (data.zoomFromMs == null || data.zoomToMs == null) return {};
        if (useCategoryAxis) {
          var fromIdx = nearestIndex(data.zoomFromMs);
          var toIdx = nearestIndex(data.zoomToMs);
          if (fromIdx < 0 || toIdx < 0) return {};
          if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
          return { startValue: fromIdx, endValue: toIdx };
        }
        return { startValue: data.zoomFromMs, endValue: data.zoomToMs };
      })();
      // dataZoom slider 両端ラベルも JST で表示 (default だと UTC date string)。
      // category mode では labelFormatter に category 値 (= ISO timestamp 文字列)
      // が渡されるので jstLabel に直接通せばよい (内部で Date(value) parse)。
      // filterMode: 'weakFilter' は line / markLine など複数点で 1 figure を
      // 構成する series 用。default の 'filter' は data item 単位で評価し、
      // 1 dimension でも zoom 外なら点ごと除外する → 直近 2 pivot を chart 末
      // まで延長する trend line ([oldPivot(~30d 前), chartEnd] の 2 点) は 5D
      // zoom で oldPivot が範囲外 → 1 点だけ残り「線が引けない」回帰になる。
      // 'weakFilter' は同 group 内の全点が同じ側に外れた時のみ filter する
      // ため、片端が範囲内なら線分は描画される (公式 issue #3637 / official
      // PR で line chart が zoom 中に消える問題の対策として実装された挙動)。
      // candle / line / scatter / markLine / markPoint / markArea すべてで
      // 「1 点が範囲外でも視覚的に切れて表示される」のが期待動作なので
      // wide chart (1 銘柄 / 数千点) でも問題ない。
      var dzCommon = {
        labelFormatter: function (value) { return jstLabelForX(value); },
        filterMode: 'weakFilter',
      };
      var dzInside = { filterMode: 'weakFilter' };
      var dataZoomCfg = [
        Object.assign({ type: 'inside', xAxisIndex: 0 }, dzInside, dzInitial),
        Object.assign({ type: 'slider', xAxisIndex: 0, height: 24, bottom: 8 }, dzCommon, dzInitial),
      ];

      var symChart = echarts.init(document.getElementById('symbol-chart'));
      // displayName は server 側で symbol_config.market='JP' なら "番号-会社名" を
      // 入れている。US / fallback は symbol そのまま。chart 内 string concat 時の
      // 安全フォールバックとして '|| sc.symbol' を残す。
      var titleSymbol = sc.displayName || sc.symbol;
      symChart.setOption({
        title: { text: titleSymbol + ' price + トレンドライン + 押し目ゾーン + entry/exit', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: {
          trigger: 'axis',
          axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
          // 既定の trigger:'axis' tooltip は header に axis value (時刻) を
          // UTC 文字列で出すため、JST formatter を当てた custom formatter で上書き。
          // candlestick 値は [open, close, low, high]、line は scalar として処理。
          // category mode では axisValue は category 値 (= ISO timestamp string)。
          formatter: function (params) {
            if (!Array.isArray(params) || params.length === 0) return '';
            var ts = params[0].axisValue;
            var lines = ['<div style="font-weight:600;font-size:11px">' + jstLabelForX(ts) + '</div>'];
            // densified path (intradayBars timestamp ごとに line series を埋める
            // PR #190 / #192) により、同じ seriesName + 同じ y 値の data point が
            // 同一 axis index 周辺に多数並ぶ。ECharts の trigger axis は該当
            // params を全件渡してくるため、tooltip 上で SMA50 65.82 が 16 行
            // 続くような重複表示が発生する。seriesName + 整形後 value を key に
            // した Set で連続行を 1 行に dedup する (系列ごと 1 行)。candle は
            // OHLC 4 値の array なので special-case のまま既存挙動を維持。
            var seenLine = Object.create(null);
            for (var i = 0; i < params.length; i += 1) {
              var p = params[i];
              if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                // ECharts は candlestick の p.value 先頭に系列の x (timestamp/index)
                // を入れて返すことがあるため、長さで分岐。length===4 の場合は
                // [O, C, L, H]、5 以上は [x, O, C, L, H]。
                var off = p.value.length >= 5 ? 1 : 0;
                lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName +
                  '  O ' + Number(p.value[off]).toFixed(2) +
                  '  H ' + Number(p.value[off + 3]).toFixed(2) +
                  '  L ' + Number(p.value[off + 2]).toFixed(2) +
                  '  C ' + Number(p.value[off + 1]).toFixed(2) + '</div>');
              } else {
                var v = Array.isArray(p.value) ? p.value[1] : p.value;
                if (v == null) continue;
                var vText = Number(v).toFixed(2);
                var key = String(p.seriesName) + '|' + vText;
                if (seenLine[key]) continue;
                seenLine[key] = true;
                lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName +
                  ': ' + vText + '</div>');
              }
            }
            return lines.join('');
          },
        },
        legend: { top: 22, type: 'scroll' },
        // plot 面積最大化: grid 余白を絞り、splitLine 淡く、axisLine 非表示で
        // candle が映える背景に (trader-strategist 助言)。bottom は slider 用 64px キープ。
        // right は stop/TP の endLabel ("stop X (preview)" 等) が見切れないよう
        // 80px 確保 (短い "stop X (-Y%)" でも余白として違和感ない範囲)。
        grid: { left: 50, right: 120, top: 56, bottom: 64 },
        dataZoom: dataZoomCfg,
        // category mode: categories = intradayBars 各 bar の ISO timestamp。
        // overnight / 週末 / 米国祝日の空白を「詰めて」表示するため (TradingView
        // 同等)、time axis ではなく category axis を採用。category 間隔は等間隔
        // なので「金曜 16:00 ET 引け」と「月曜 09:30 ET 寄り」が隣接する。これは
        // 「同じ 1 hour 進んだように見える」が、休場で値が動いていない gap を
        // 詰める方が視認性で勝る (user 要望)。
        // time mode (intradayBars 空) では従来の time axis にフォールバック。
        xAxis: useCategoryAxis ? {
          type: 'category',
          data: categories,
          // 連続する category を密に並べた候補の中から ECharts が省略間引きする
          // ので、明示的な intervals 不要。formatter で個々の category 値 (ISO
          // timestamp) を JST に整形。
          axisLabel: { formatter: function (value) { return jstLabel(value); }, hideOverlap: true },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        } : {
          type: 'time',
          axisLabel: { formatter: function (value) { return jstLabel(value); } },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        },
        yAxis: {
          type: 'value', min: yMin, max: yMax,
          axisLabel: { showMinLabel: false, showMaxLabel: false },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        },
        series: [
          // 保有時は押し目バンド非表示 (avg/stop/TP に集中)、非保有時は表示。
          //
          // 帯は markArea fill のみで表現 (#232 follow-up): 以前は per-timestamp
          // の dashed line 2 本も併用していたが、20 日 high はあまり動かず
          // markArea の上下境界とほぼ重なって冗長だった。markArea のみに統一して
          // 凡例もコンパクトにし、chart の視認性を上げる。
          ...((sc.position || !pullbackBandMarkArea) ? [] : [
            {
              name: '押し目ゾーン',
              type: 'line', data: [],
              symbol: 'none', z: 1,
              markArea: pullbackBandMarkArea,
            },
          ]),
          // per-timestamp 上下端 (sloped lines)。markArea の上に重ねて、
          // high20d が動く銘柄での「帯の傾き」を可視化する。保有時 + 押し目
          // markArea 描画なしのケースは line も出さない (chart 過密回避)。
          // 凡例は markArea host series '押し目ゾーン' に集約させたいので、
          // この 2 本は legendHoverLink で同期する独立 series (name のみ別)。
          ...((sc.position || !pullbackBandMarkArea || !pullbackBandHasData) ? [] : [
            {
              name: '押し目上端',
              type: 'line', data: pullbackUpperXY,
              connectNulls: false,
              lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
              itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
              symbol: 'none', z: 2,
            },
            {
              name: '押し目下端',
              type: 'line', data: pullbackLowerXY,
              connectNulls: false,
              lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
              itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
              symbol: 'none', z: 2,
            },
          ]),
          // 価格トレンド (linear regression, 直近 30 日 daily close fit)。
          // 1 本だけ。中間色 (紫 #9333ea) で「上値 / 下値どちらでもない、価格
          // の重心」を表す。dense path (intradayBars 各 timestamp で y 補間)
          // で zoom にかかわらず確実に描画される (2 点 line series で zoom
          // 縮めると seg-droppable な ECharts 既知挙動 #3637 系への根本対処)。
          // z:7 で candle (z:5) / SMA50 (z:6) より上に置き、線本体を最前面に。
          // symbol:'none' で点 marker は出さない。itemStyle.color は legend
          // dot 色を lineStyle.color と揃えるため明示。
          ...(trendLineXY ? [{
            name: '価格トレンド (linear regression, 30日)', type: 'line', data: trendLineXY,
            lineStyle: { width: 1.8, color: '#9333ea', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#9333ea' }, z: 7,
          }] : []),
          // candlestick: 15 分足 OHLC を表示。Western 規約 (close >= open = 緑、
          // candle: 主役。Western 規約 (close >= open = 緑、< = 赤)。
          // markPoint / markLine もここに anchor。barWidth 明示で overnight
          // gap 後の細い candle を視認可能に。borderWidth 強めて
          // body と wick の対比を確保。
          ...(ohlcXY.length > 0 ? [{
            name: 'price (1h OHLC)', type: 'candlestick', data: ohlcXY,
            // 1h は 15m より時間軸の間隔が 4 倍広いので、barWidth も少し
            // 広めに (相対的に gap 比率を一定に保つ)。
            barWidth: 10,
            itemStyle: {
              color: '#057a55',     // bullish (close >= open)
              color0: '#c22',       // bearish (close < open)
              borderColor: '#057a55',
              borderColor0: '#c22',
              borderWidth: 1.5,
            },
            z: 5,
            // position lines (avg/stop/TP) は dense path の独立 line series
            // として描画する (下方参照、densifyHorizontalLine 適用)。
            // candlestick の markLine は trend line / position line いずれも
            // dataZoom + 2 点だと「片端外で線が消える」回帰があるため使わない。
            //
            // ただしセッション境界の縦点線は xAxis: <category index> 指定で
            // y 軸全幅にまたがる「真の vertical markLine」となり、ECharts の
            // 描画 path が trend line (slanted 2-point markLine) とは別系統。
            // 縦線方向は zoom 範囲外でも描画ロバスト (#193 follow-up)。
            // category 軸モード時のみ data を積む (time axis fallback では空)。
            markLine: sessionOpenIndices.length > 0 ? {
              symbol: 'none',
              silent: true,
              label: { show: false },
              lineStyle: { color: '#bbb', width: 1, type: 'dashed' },
              z: 1,
              data: sessionOpenIndices.map(function (idx) {
                return { xAxis: idx };
              }),
            } : undefined,
            markPoint: entries.length + exits.length > 0 ? {
              symbol: 'pin', symbolSize: 24, data: entries.concat(exits),
              tooltip: {
                trigger: 'item',
                formatter: function (p) {
                  var d = p.data;
                  var pnl = d.realizedPnl == null
                    ? ''
                    : '<br/>realized PnL: ' + (d.realizedPnl >= 0 ? '+' : '') + d.realizedPnl.toFixed(2);
                  var qty = d.qty == null ? '' : '<br/>qty: ' + d.qty;
                  var ts = d.fillTimestamp == null ? '' : '<br/>fill: ' + jstLabelSec(d.fillTimestamp);
                  return d.name + ' @ ' + d.value.toFixed(2) + pnl + qty + ts;
                },
              },
            } : undefined,
          }] : []),
          // SMA50 line: Yahoo daily bars から server-side で連続計算 (cron eval
          // 行間も Yahoo 日次で線が繋がる)。candle (z:5) より上に置いて細い
          // candle 帯に重なっても見えるようにする。色は TradingView 系で
          // SMA に多用される orange (#f59e0b)、solid 1.4px。
          // trend line は独立 series で描画する (上方参照)。markLine 方式は
          // legend に出ないため legend と series の対応が崩れる。
          {
            name: 'SMA50', type: 'line', data: smasXY,
            lineStyle: { width: 1.4, color: '#f59e0b', type: 'solid' },
            symbol: 'none', connectNulls: true, z: 6,
          },
          // 保有時の avg / stop / TP 水平線。densifyHorizontalLine で
          // openedAt〜最新の dense path に展開済み (上方参照)。endLabel で
          // 右端に「avg 124.95」等のラベルを出す (zoom in しても右端は常に
          // 描画範囲内なので consistently 見える)。z:8 で candle / SMA50 /
          // trend line のすべてより上に置き、保有 status を最優先で可視化。
          // tooltip / hover には介入させたくないので silent + emphasis disabled。
          ...(avgLineXY ? [{
            name: avgLabel, type: 'line', data: avgLineXY,
            lineStyle: { width: 1, color: '#444', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#444' },
            endLabel: { show: true, formatter: avgLabel, color: '#444', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          ...(stopLineXY ? [{
            name: stopLabel, type: 'line', data: stopLineXY,
            lineStyle: { width: 1, color: '#c22', type: 'dashed' }, symbol: 'none',
            itemStyle: { color: '#c22' },
            endLabel: { show: true, formatter: stopLabel, color: '#c22', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          ...(tpLineXY ? [{
            name: tpLabel, type: 'line', data: tpLineXY,
            lineStyle: { width: 1, color: '#057a55', type: 'dashed' }, symbol: 'none',
            itemStyle: { color: '#057a55' },
            endLabel: { show: true, formatter: tpLabel, color: '#057a55', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          // 保有ナシ時の preview stop / TP (current price ベース)。dotted +
          // opacity 0.5 で「actual position の線ではない、仮置き」と視覚区別。
          // z:7 にして actual の z:8 より下に置く (混在することは無いが、
          // 凡例での視覚上の優先度として明示)。
          ...(previewStopLineXY ? [{
            name: previewStopLabel, type: 'line', data: previewStopLineXY,
            lineStyle: { width: 1, color: '#c22', type: 'dotted', opacity: 0.5 }, symbol: 'none',
            itemStyle: { color: '#c22', opacity: 0.5 },
            endLabel: {
              show: true, formatter: previewStopLabel, color: '#c22', fontSize: 10, opacity: 0.7,
            },
            silent: true, emphasis: { disabled: true }, z: 7,
          }] : []),
          ...(previewTpLineXY ? [{
            name: previewTpLabel, type: 'line', data: previewTpLineXY,
            lineStyle: { width: 1, color: '#057a55', type: 'dotted', opacity: 0.5 }, symbol: 'none',
            itemStyle: { color: '#057a55', opacity: 0.5 },
            endLabel: {
              show: true, formatter: previewTpLabel, color: '#057a55', fontSize: 10, opacity: 0.7,
            },
            silent: true, emphasis: { disabled: true }, z: 7,
          }] : []),
        ],
      });
      window.addEventListener('resize', function () { symChart.resize(); });

      // visible 範囲 (zoom 後の x 軸) 内の candle high/low / markers / position
      // 線を集めて y 軸 range を再計算。zoom out / preset 切替で「縦に空白が
      // 広がる」現象を防ぎプロ chart 風のタイト fit に。
      // category mode では dataZoom.startValue/endValue は category index、
      // time mode では ms。各 bar / marker / point について
      // 「visible 範囲内か」を判定する関数を mode で切り替える。
      function recomputeYAxis() {
        var opt = symChart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return;
        var startVal = dz.startValue;
        var endVal = dz.endValue;
        if (startVal == null || endVal == null) return;
        // mode 共通: 「ts (ISO string) または ms が visible か」を返す。
        // category mode では nearestIndex で snap した index を range と比較。
        // time mode では ms を range と比較。
        function inRangeMs(ms) {
          if (!Number.isFinite(ms)) return false;
          if (useCategoryAxis) {
            var idx = nearestIndex(ms);
            return idx >= startVal && idx <= endVal;
          }
          return ms >= startVal && ms <= endVal;
        }
        // category index ベースの直接判定 (intradayBars iterate 用)
        function inRangeIdx(idx) {
          if (useCategoryAxis) return idx >= startVal && idx <= endVal;
          return true; // time mode では使わない (intradayBars iterate 側で ms 判定)
        }
        var visibleY = [];
        function pushIfFinite(v) {
          if (v != null && typeof v === 'number' && Number.isFinite(v)) visibleY.push(v);
        }
        (sc.intradayBars || []).forEach(function (b, i) {
          if (useCategoryAxis ? inRangeIdx(i) : inRangeMs(new Date(b.timestamp).getTime())) {
            pushIfFinite(b.high);
            pushIfFinite(b.low);
          }
        });
        sc.markers.forEach(function (m) {
          if (inRangeMs(new Date(m.timestamp).getTime())) pushIfFinite(m.price);
        });
        // visible 範囲内の SMA50 値も含める。SMA50 が candle と離れた水準
        // (例: SOXL は 3x rally で SMA50=65 / 価格=128) の銘柄では candle が
        // 縦方向に圧縮されるが、SMA50 line が常時可視になる方を優先する
        // (#181 後の user request)。zoom out すれば candle にとって過剰な
        // 引き伸ばしも緩和される。
        sc.points.forEach(function (p) {
          if (inRangeMs(new Date(p.timestamp).getTime())) pushIfFinite(p.sma50);
        });
        // trend line: regression で fit した 1 本。pivots[0]→end の 2 点で
        // 直線が定義される。visible 範囲内に endpoint または時間軸の交点が
        // 乗るときに y 値を取り込んで axis 外にはみ出さないようにする。両
        // endpoint が範囲外でも線分が visible 帯を横断するなら sample して
        // その y を採用 (= 単純な 2 点線形補間)。
        // category mode では index 基準の visible range を ms に変換して
        // 既存の ms 補間ロジックをそのまま再利用する。
        function sampleTrendY(line) {
          if (!line) return;
          var p1 = line.pivots[0];
          var p2 = line.end;
          var t1 = new Date(p1.timestamp).getTime();
          var t2 = new Date(p2.timestamp).getTime();
          if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 === t2) return;
          var slope = (p2.price - p1.price) / (t2 - t1);
          var startMs, endMs;
          if (useCategoryAxis) {
            var sIdx = Math.max(0, Math.min(categories.length - 1, Math.round(startVal)));
            var eIdx = Math.max(0, Math.min(categories.length - 1, Math.round(endVal)));
            startMs = ohlcMs[sIdx];
            endMs = ohlcMs[eIdx];
          } else {
            startMs = startVal;
            endMs = endVal;
          }
          // visible 範囲と線分の交差区間を [a, b] にクリップして両端を採用
          var a = Math.max(startMs, Math.min(t1, t2));
          var b = Math.min(endMs, Math.max(t1, t2));
          if (a > b) return; // 重なりなし
          pushIfFinite(p1.price + slope * (a - t1));
          pushIfFinite(p1.price + slope * (b - t1));
        }
        sampleTrendY(sc.trendLine);
        // 保有期間が visible 範囲と重なっていれば position 線を含める。
        // category mode では openedAt の最近接 index と endVal を比較。
        if (sc.position) {
          var openedAtMs = new Date(sc.position.openedAt).getTime();
          var openedVisible = false;
          if (Number.isFinite(openedAtMs)) {
            if (useCategoryAxis) {
              var oIdx = nearestIndex(openedAtMs);
              openedVisible = oIdx <= endVal;
            } else {
              openedVisible = openedAtMs <= endVal;
            }
          }
          if (openedVisible) {
            var avg = sc.position.avgPrice;
            pushIfFinite(avg);
            pushIfFinite(avg * (1 + sc.rules.stopPct));
            pushIfFinite(avg * (1 + sc.rules.takeProfitPct));
          }
        } else if (sc.latestCronPrice != null && sc.latestCronPrice > 0) {
          // preview lines は描画範囲が chart 開始 → 最新 cron eval まで。
          // visible 範囲とは常に交差する想定。virtualAvg = latestCronPrice
          // (Yahoo filler ではなく実 strategy 評価値) から stop/TP を算出。
          // latestCronPrice == null のときは preview 線そのものを描いていない
          // ので y range にも含めない (= 軸が無駄に広がるのを防ぐ)。
          var pVirtualAvg = sc.latestCronPrice;
          pushIfFinite(pVirtualAvg * (1 + sc.rules.stopPct));
          pushIfFinite(pVirtualAvg * (1 + sc.rules.takeProfitPct));
        }
        if (visibleY.length === 0) return;
        var rawMin = Math.min.apply(null, visibleY);
        var rawMax = Math.max.apply(null, visibleY);
        if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return;
        var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
        symChart.setOption({ yAxis: { min: rawMin - pad, max: rawMax + pad } });
      }
      // 初回 render 後に一度実行 (default zoom 範囲に y を tight fit)
      recomputeYAxis();

      // dataZoom 変更で URL の ?from / ?to を更新 (replaceState なので history
      // 汚染なし)。debounce 200ms で連続操作中の URL flicker を抑制。
      // 同時に symbol picker / tab strip の '?tab=symbol' リンクの href も
      // 上書き → 銘柄切替で zoom が古い range に reset されない。
      // y 軸も visible 範囲に再 fit (recomputeYAxis、debounce 内で)。
      var dzTimer = null;
      symChart.on('dataZoom', function () {
        if (dzTimer) clearTimeout(dzTimer);
        dzTimer = setTimeout(function () {
          recomputeYAxis();
          var opt = symChart.getOption();
          var dz = opt.dataZoom && opt.dataZoom[0];
          if (!dz) return;
          var sv = dz.startValue;
          var ev = dz.endValue;
          if (sv == null || ev == null) return;
          try {
            // category mode: sv/ev は category index → categories[i] (ISO string)
            // を取り出して ms に変換。time mode: sv/ev は ms (number)。
            var fromMsLocal, toMsLocal;
            if (useCategoryAxis) {
              var sIdx = Math.max(0, Math.min(categories.length - 1, Math.round(sv)));
              var eIdx = Math.max(0, Math.min(categories.length - 1, Math.round(ev)));
              fromMsLocal = new Date(categories[sIdx]).getTime();
              toMsLocal = new Date(categories[eIdx]).getTime();
            } else {
              fromMsLocal = sv;
              toMsLocal = ev;
            }
            var fromIso = new Date(fromMsLocal).toISOString();
            var toIso = new Date(toMsLocal).toISOString();
            var url = new URL(window.location.href);
            url.searchParams.set('from', fromIso);
            url.searchParams.set('to', toIso);
            window.history.replaceState({}, '', url.toString());
            // server-render 時の picker / tab strip リンクは古い from/to を
            // 持っているので、ここで href を新値に書き換える。
            var symbolLinks = document.querySelectorAll('a[href*="tab=symbol"]');
            for (var i = 0; i < symbolLinks.length; i += 1) {
              try {
                var linkUrl = new URL(symbolLinks[i].href);
                linkUrl.searchParams.set('from', fromIso);
                linkUrl.searchParams.set('to', toIso);
                symbolLinks[i].href = linkUrl.toString();
              } catch (e) { /* noop per-link */ }
            }
          } catch (e) { /* noop */ }
        }, 200);
      });

      // preset zoom buttons (1D / 5D / 1M / All) の click handler。
      // dispatchAction で dataZoom を更新 → 既存の dataZoom listener が
      // URL ?from / ?to も連動更新する。
      // category mode では ms 範囲を最近接 index に snap してから dispatch。
      var presetButtons = document.querySelectorAll('.zoom-preset');
      for (var pi = 0; pi < presetButtons.length; pi += 1) {
        presetButtons[pi].addEventListener('click', function (ev) {
          var fromMs = Number(ev.currentTarget.getAttribute('data-from-ms'));
          var toMs = Number(ev.currentTarget.getAttribute('data-to-ms'));
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
          var sv, eV;
          if (useCategoryAxis) {
            sv = nearestIndex(fromMs);
            eV = nearestIndex(toMs);
            if (sv < 0 || eV < 0) return;
            if (sv > eV) { var tmp = sv; sv = eV; eV = tmp; }
          } else {
            sv = fromMs;
            eV = toMs;
          }
          // inside / slider 両方を同期更新
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: sv, endValue: eV });
        });
      }
    });
  `
  // chart payload に displayName を注入。client 側の chart title / tooltip header
  // は `sc.displayName || sc.symbol` で読む (US 銘柄は displayName === symbol)。
  const symbolChartPayload = args.symbolChart
    ? { ...args.symbolChart, displayName: displaySymbol(args.symbolChart.symbol, args.universe) }
    : null
  return `${renderSymbolPickerForTab(args)}
  ${renderCurrentIndicatorsBadge(args.symbolChart)}
  <div id="symbol-chart" style="width:100%;height:460px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${renderZoomPresetButtons(args.symbolChart)}
  ${renderStrategyParamsPanel(args.strategyParams)}
  ${safeJsonScript('__chartData', {
    symbolChart: symbolChartPayload,
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

/**
 * 銘柄グリッドビュー (Datadog dashboard 風)。ALLOWED_SYMBOLS を 4 列 grid で
 * 並列表示。`echarts.connect` で dataZoom + axisPointer (縦線) を全 panel 同期、
 * tooltip popup は hover 中の panel だけに表示 (PR #242、formatter 内で
 * window.__gridHoveredPanelId !== elId のとき空文字を返して描画を抑制)。
 * preset zoom (1D/5D/1M/All) も grid 共通 toolbar から dispatchAction で全 chart
 * に配信。
 *
 * mini chart の構成 (PR #239 で個別銘柄タブと表示要素パリティ):
 * - candle (1h OHLC)
 * - 価格トレンド (linear regression)
 * - SMA50
 * - 押し目ゾーン markArea + sloped 上下端線 (未保有時のみ)
 * - 保有時の avg / stop / TP 水平線 + endLabel
 * - 未保有時の preview stop / TP 点線 + endLabel
 * - BUY/SELL pin (markPoint, hover で qty / PnL / fill 時刻 tooltip)
 * - session divider (vertical lines)
 */
export function renderGridTab(args: ChartsBodyGrid): string {
  if (args.charts.length === 0) {
    return `<p class="muted">ALLOWED_SYMBOLS が空です。<code>symbol_config</code> に少なくとも 1 銘柄登録してください。</p>`
  }
  // grid 共通 toolbar の preset zoom buttons。reference chart (最初に load 成功)
  // の lastTimestamp を基準に from/to を計算。各 panel が個別に同 timestamp 軸
  // を持つため、共通の ms 範囲で全 chart を dispatchAction で同期する。
  const referenceChart = args.charts.find((c) => c.chart !== null)?.chart ?? null
  const presetButtonsHtml = renderZoomPresetButtons(referenceChart)

  // 各 panel: chart 本体は client side で echarts.init される。panel header に
  // symbol 名 (詳細タブへの link) と最新 indicators (price / SMA50) を出して
  // 「市場全体ビュー」で trader が銘柄を一目で識別できるようにする。
  // inactive 銘柄は data 取得は通常通り行うが、panel header に INACTIVE バッジと
  // grayed-out style (`symbol-inactive`) を付けて視覚識別する。
  // panel に data-has-position / data-inactive を付け、上部 toolbar の checkbox
  // で client-side filter (display:none) する。state は localStorage に保存
  // (`dashboard.gridFilter.v1`)。chart=null (取得失敗) の panel は position 不明
  // のため has-position=false 扱い (= 「未保有」フィルタに含める)。
  const panelsHtml = args.charts
    .map((entry, idx) => {
      const inactive = isSymbolInactive(entry.symbol, args.universe)
      const hasPosition = entry.chart?.position != null
      // inactive は background / text-decoration の inline 上書きを避け、
      // CSS class 側 (.grid-panel.symbol-inactive と .symbol-disabled) に任せる。
      // inline style は CSS class より優先されてしまうため (CodeRabbit #230)。
      const baseStyle = inactive
        ? 'border:1px solid #d0d0d5;border-radius:6px;padding:8px'
        : 'border:1px solid #d0d0d5;border-radius:6px;padding:8px;background:#fff'
      const panelClass = inactive ? 'grid-panel symbol-inactive' : 'grid-panel'
      const dataAttrs = ` data-has-position="${hasPosition ? '1' : '0'}" data-inactive="${inactive ? '1' : '0'}"`
      const symbolLink = `/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(entry.symbol)}`
      const headerText = displaySymbol(entry.symbol, args.universe)
      const tooltipText = inactiveTooltip(entry.symbol, args.universe)
      const linkClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(tooltipText)}"` : ''
      const linkStyle = inactive
        ? 'font-weight:600;font-size:14px;color:#06c'
        : 'font-weight:600;font-size:14px;color:#06c;text-decoration:none'
      const headerLink = `<a href="${symbolLink}"${linkClass}${titleAttr} style="${linkStyle}">${esc(headerText)}</a>`
      const inactiveBadge = inactive
        ? `<span class="muted" style="font-size:11px"${titleAttr}>INACTIVE</span>`
        : ''
      const positionBadge = hasPosition
        ? `<span style="font-size:11px;color:#0a8a0a;font-weight:600" title="現保有あり">●保有</span>`
        : ''
      if (entry.chart === null) {
        const errMsg = entry.error ?? 'チャートデータ取得失敗'
        const errBadge = `<span class="warn" style="font-size:11px">取得失敗</span>`
        const rightSide = (inactive ? inactiveBadge : '') + errBadge
        return `<div class="${panelClass}"${dataAttrs} style="${baseStyle}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px">
            ${headerLink}
            <div style="display:flex;gap:6px;align-items:center">${rightSide}</div>
          </div>
          <div class="muted" style="font-size:12px;padding:24px 8px;text-align:center">${esc(errMsg)}</div>
        </div>`
      }
      const badge = renderGridPanelBadge(entry.chart)
      const rightSide = (inactive ? inactiveBadge : '') + positionBadge + badge
      return `<div class="${panelClass}"${dataAttrs} style="${baseStyle}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px">
          ${headerLink}
          <div style="display:flex;gap:6px;align-items:center">${rightSide}</div>
        </div>
        <div id="grid-chart-${idx}" style="width:100%;height:280px"></div>
      </div>`
    })
    .join('')

  // client 側に渡す全銘柄分の chart payload。各 panel が個別 echarts.init で
  // 消費する。__chartData.charts は array of { symbol, chart, displayName }
  // (chart は load 失敗で null)。displayName は server 側で JP 銘柄なら
  // "番号-会社名" を入れている (US は symbol そのまま) — tooltip header
  // (`sc.displayName || sc.symbol`) で読まれる。
  const payload = {
    charts: args.charts.map((c) => ({
      symbol: c.symbol,
      chart: c.chart
        ? { ...c.chart, displayName: displaySymbol(c.chart.symbol, args.universe) }
        : null,
      error: c.error,
      displayName: displaySymbol(c.symbol, args.universe),
    })),
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  }

  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      if (!data || !Array.isArray(data.charts)) return;

      // mini chart factory: 1 panel 分の echarts instance を build して返す。
      // 単一銘柄タブの主要要素 (candle / 価格トレンド / position lines /
      // session divider / BUY-SELL pin) を引き継ぎつつ、SMA50 / band /
      // legend / chart 内 title は panel size のため省略する。
      function buildPanel(elId, sc) {
        if (!sc || !Array.isArray(sc.points) || sc.points.length === 0) return null;
        var el = document.getElementById(elId);
        if (!el) return null;
        var ohlcBars = sc.intradayBars || [];
        var useCategoryAxis = ohlcBars.length > 0;
        var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
        var categories = ohlcBars.map(function (b) { return b.timestamp; });

        var sessionOpenIndices = [];
        if (useCategoryAxis) {
          var SESSION_GAP_MS = 90 * 60 * 1000;
          for (var si = 1; si < ohlcMs.length; si++) {
            if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
          }
        }

        function nearestIndex(ms) {
          if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
          var lo = 0, hi = ohlcMs.length - 1;
          if (ms <= ohlcMs[0]) return 0;
          if (ms >= ohlcMs[hi]) return hi;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
          }
          if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
          return lo;
        }
        function xForTimestamp(ts) {
          if (useCategoryAxis) return nearestIndex(new Date(ts).getTime());
          return ts;
        }

        var jstFmt = new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        function jstLabel(value) {
          return jstFmt.format(new Date(value)).replace(/\\//g, '/');
        }
        function jstLabelForX(value) {
          if (useCategoryAxis && typeof value === 'number') {
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }

        var ohlcXY = useCategoryAxis
          ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
          : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });

        // SMA50: 個別銘柄タブと同形 (sc.points 各点の sma50 値)。null は break 用に
        // そのまま入れる (connectNulls=true でも null は points 間を非描画にする)。
        var smasXY = sc.points.map(function (p) {
          if (p.sma50 == null) return [xForTimestamp(p.timestamp), null];
          return [xForTimestamp(p.timestamp), p.sma50];
        });

        // 押し目ゾーン (#238 個別銘柄タブと同実装)。markArea (latest high20d 基準
        // の flat 帯) + per-timestamp の上下端 sloped line で構成。保有時は非表示。
        var pullbackMaxMul = 1 + sc.rules.pullbackMax;
        var pullbackMinMul = 1 + sc.rules.pullbackMin;
        var latestHigh20d = null;
        for (var lhi = sc.points.length - 1; lhi >= 0; lhi -= 1) {
          var lhp = sc.points[lhi];
          if (lhp && typeof lhp.high20d === 'number' && isFinite(lhp.high20d)) {
            latestHigh20d = lhp.high20d;
            break;
          }
        }
        var bandUpperY = latestHigh20d == null ? null : latestHigh20d * pullbackMaxMul;
        var bandLowerY = latestHigh20d == null ? null : latestHigh20d * pullbackMinMul;
        var bandTopY = null;
        var bandBottomY = null;
        if (Number.isFinite(bandUpperY) && Number.isFinite(bandLowerY)) {
          bandTopY = Math.max(bandUpperY, bandLowerY);
          bandBottomY = Math.min(bandUpperY, bandLowerY);
        }
        var pullbackBandMarkArea = (bandTopY != null && bandBottomY != null) ? {
          silent: true,
          itemStyle: {
            color: 'rgba(255, 180, 50, 0.08)',
            borderColor: 'rgba(255, 140, 0, 0.35)',
            borderWidth: 1,
            borderType: 'dashed',
          },
          data: [[{ yAxis: bandBottomY }, { yAxis: bandTopY }]],
        } : null;
        var pullbackUpperXY = sc.points.map(function (p) {
          var x = xForTimestamp(p.timestamp);
          if (typeof p.high20d !== 'number' || !isFinite(p.high20d)) return [x, null];
          return [x, p.high20d * pullbackMaxMul];
        });
        var pullbackLowerXY = sc.points.map(function (p) {
          var x = xForTimestamp(p.timestamp);
          if (typeof p.high20d !== 'number' || !isFinite(p.high20d)) return [x, null];
          return [x, p.high20d * pullbackMinMul];
        });
        var pullbackBandHasData =
          pullbackUpperXY.some(function (xy) { return xy[1] != null; }) &&
          pullbackLowerXY.some(function (xy) { return xy[1] != null; });

        // dense trend line (個別銘柄タブと同アルゴリズム)
        var ohlcTimestamps = ohlcMs.slice();
        function densifyTrendLine(line, sampleTimestamps) {
          if (!line) return null;
          var t1 = new Date(line.pivots[0].timestamp).getTime();
          var t2 = new Date(line.end.timestamp).getTime();
          var y1 = line.pivots[0].price;
          var y2 = line.end.price;
          if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
          if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
          if (t1 === t2) return [[t1, y1], [t2, y2]];
          var slope = (y2 - y1) / (t2 - t1);
          var seen = Object.create(null);
          var arr = [];
          for (var i = 0; i < sampleTimestamps.length; i += 1) {
            var t = sampleTimestamps[i];
            if (!Number.isFinite(t)) continue;
            if (seen[t]) continue;
            seen[t] = true;
            arr.push(t);
          }
          if (!seen[t1]) { seen[t1] = true; arr.push(t1); }
          if (!seen[t2]) { seen[t2] = true; arr.push(t2); }
          arr.sort(function (a, b) { return a - b; });
          if (arr.length < 2) return [[t1, y1], [t2, y2]];
          var out = [];
          for (var j = 0; j < arr.length; j += 1) {
            var tj = arr[j];
            var yj = y1 + slope * (tj - t1);
            if (Number.isFinite(yj)) out.push([tj, yj]);
          }
          if (out.length < 2) return [[t1, y1], [t2, y2]];
          return out;
        }
        function toCategoryXY(tyArr) {
          if (!tyArr) return null;
          if (!useCategoryAxis) return tyArr;
          var seenIdx = Object.create(null);
          var out = [];
          for (var i = 0; i < tyArr.length; i += 1) {
            var t = tyArr[i][0];
            var y = tyArr[i][1];
            var idx = nearestIndex(t);
            if (idx < 0) continue;
            if (seenIdx[idx]) continue;
            seenIdx[idx] = true;
            out.push([idx, y]);
          }
          out.sort(function (a, b) { return a[0] - b[0]; });
          return out.length > 0 ? out : null;
        }
        var trendLineXY = toCategoryXY(densifyTrendLine(sc.trendLine, ohlcTimestamps));

        // BUY/SELL pin: 個別銘柄タブと同形 (label は最新の fill 1 件のみ表示)
        var buys = (sc.markers || []).filter(function (m) { return m.side === 'BUY'; });
        var sells = (sc.markers || []).filter(function (m) { return m.side === 'SELL'; });
        var latestFillTs = sc.markers && sc.markers.length > 0
          ? sc.markers[sc.markers.length - 1].timestamp
          : null;
        var entries = buys.map(function (m) {
          var showLabel = m.timestamp === latestFillTs;
          return {
            name: 'BUY', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
            label: { show: showLabel, formatter: m.price.toFixed(2), color: '#057a55', position: 'top', distance: 4, fontSize: 10 },
            itemStyle: { color: '#057a55' },
          };
        });
        var exits = sells.map(function (m) {
          var showLabel = m.timestamp === latestFillTs;
          var pnlLabel = m.realizedPnl == null ? '' : ' ' + (m.realizedPnl >= 0 ? '+' : '') + m.realizedPnl.toFixed(1);
          return {
            name: 'SELL', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
            label: { show: showLabel, formatter: m.price.toFixed(2) + pnlLabel, color: '#c22', position: 'bottom', distance: 4, fontSize: 10 },
            itemStyle: { color: '#c22' },
          };
        });

        // 保有時の avg / stop / TP 水平線 (個別銘柄タブと同 dense path 方式)
        function densifyHorizontalLine(yValue, fromTs, toTs, samples) {
          if (!Number.isFinite(yValue)) return null;
          var a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime();
          var b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime();
          if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
          if (a >= b) return [[a, yValue], [b, yValue]];
          var seen = Object.create(null);
          var arr = [];
          function push(t) { if (seen[t]) return; seen[t] = true; arr.push(t); }
          push(a); push(b);
          for (var i = 0; i < samples.length; i += 1) {
            var t = samples[i];
            if (!Number.isFinite(t)) continue;
            if (t < a || t > b) continue;
            push(t);
          }
          arr.sort(function (x, y) { return x - y; });
          var out = [];
          for (var j = 0; j < arr.length; j += 1) out.push([arr[j], yValue]);
          return out;
        }
        var avgLineXY = null, stopLineXY = null, tpLineXY = null;
        // 保有ナシ時の preview stop/TP (latestCronPrice ベースの仮置き)。
        // 個別銘柄タブと同方針 (詳細コメントは上方参照)。Yahoo filler を
        // 含めないために sc.latestCronPrice / sc.latestCronTimestamp を採用。
        var previewStopLineXY = null, previewTpLineXY = null;
        var extraYValues = [];
        if (sc.position) {
          var avg = sc.position.avgPrice;
          var stopPrice = avg * (1 + sc.rules.stopPct);
          var tpPrice = avg * (1 + sc.rules.takeProfitPct);
          extraYValues.push(avg, stopPrice, tpPrice);
          var openedAt = sc.position.openedAt;
          var latestTs = sc.points.length > 0 ? sc.points[sc.points.length - 1].timestamp : openedAt;
          var endTs = new Date(latestTs).getTime() >= new Date(openedAt).getTime() ? latestTs : openedAt;
          var fromMs = new Date(openedAt).getTime();
          var toMs = new Date(endTs).getTime();
          avgLineXY = toCategoryXY(densifyHorizontalLine(avg, fromMs, toMs, ohlcTimestamps));
          stopLineXY = toCategoryXY(densifyHorizontalLine(stopPrice, fromMs, toMs, ohlcTimestamps));
          tpLineXY = toCategoryXY(densifyHorizontalLine(tpPrice, fromMs, toMs, ohlcTimestamps));
        } else if (
          sc.points.length > 0 &&
          sc.latestCronPrice != null &&
          sc.latestCronPrice > 0 &&
          sc.latestCronTimestamp != null
        ) {
          var virtualAvg = sc.latestCronPrice;
          var pStopPrice = virtualAvg * (1 + sc.rules.stopPct);
          var pTpPrice = virtualAvg * (1 + sc.rules.takeProfitPct);
          extraYValues.push(pStopPrice, pTpPrice);
          var pFromMs = new Date(sc.points[0].timestamp).getTime();
          var pToMs = new Date(sc.latestCronTimestamp).getTime();
          if (Number.isFinite(pFromMs) && Number.isFinite(pToMs)) {
            previewStopLineXY = toCategoryXY(densifyHorizontalLine(pStopPrice, pFromMs, pToMs, ohlcTimestamps));
            previewTpLineXY = toCategoryXY(densifyHorizontalLine(pTpPrice, pFromMs, pToMs, ohlcTimestamps));
          }
        }

        // y 軸 range (candle + markers + position lines のみ。SMA50/band は除外)
        var allY = [];
        function pushIfFinite(v) {
          if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
        }
        ohlcBars.forEach(function (b) { pushIfFinite(b.high); pushIfFinite(b.low); });
        (sc.markers || []).forEach(function (m) { pushIfFinite(m.price); });
        extraYValues.forEach(function (v) { pushIfFinite(v); });
        var yMin, yMax;
        if (allY.length > 0) {
          var rawMin = Math.min.apply(null, allY);
          var rawMax = Math.max.apply(null, allY);
          if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
            var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
            yMin = rawMin - pad;
            yMax = rawMax + pad;
          }
        }

        // dataZoom 初期範囲。panel 構築ループ末尾で echarts.connect により全
        // panel 同期される (PR #242、tooltip popup だけは formatter 側で
        // 抑制)。filterMode は trend / position line の dropping 防止目的で
        // 'weakFilter' (個別銘柄タブと同方針)。
        var dzInitial = (function () {
          if (data.zoomFromMs == null || data.zoomToMs == null) return {};
          if (useCategoryAxis) {
            var fromIdx = nearestIndex(data.zoomFromMs);
            var toIdx = nearestIndex(data.zoomToMs);
            if (fromIdx < 0 || toIdx < 0) return {};
            if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
            return { startValue: fromIdx, endValue: toIdx };
          }
          return { startValue: data.zoomFromMs, endValue: data.zoomToMs };
        })();
        var dzCommon = {
          labelFormatter: function (value) { return jstLabelForX(value); },
          filterMode: 'weakFilter',
        };
        var dzInside = { filterMode: 'weakFilter' };
        var dataZoomCfg = [
          Object.assign({ type: 'inside', xAxisIndex: 0 }, dzInside, dzInitial),
          Object.assign({ type: 'slider', xAxisIndex: 0, height: 18, bottom: 4, showDetail: false }, dzCommon, dzInitial),
        ];

        var chart = echarts.init(el);
        chart.setOption({
          animation: false,
          tooltip: {
            trigger: 'axis',
            axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
            // 個別銘柄タブと同形式: candle は OHLC 4 値を 1 行、line は seriesName +
            // value を行ごとに表示。densified path で重複する seriesName+value 行は
            // dedup する (#231 と同方針)。
            //
            // axisPointer は echarts.connect 経由で全 panel 同期するが、tooltip
            // popup は **hover 中の panel だけ** に出したい (PR #241 報告: 16
            // panel 全 popup でダッシュボードが埋め尽くされる問題)。なので
            // hoveredPanelId と elId が一致しない panel は formatter で空文字を
            // 返して popup 描画をスキップする。axisPointer 縦線は formatter と
            // 独立に描画されるので、空文字でも縦線は全 panel に出る。
            formatter: function (params) {
              if (window.__gridHoveredPanelId && window.__gridHoveredPanelId !== elId) return '';
              if (!Array.isArray(params) || params.length === 0) return '';
              var ts = params[0].axisValue;
              var lines = ['<div style="font-weight:600;font-size:11px">' + (sc.displayName || sc.symbol) + ' ' + jstLabelForX(ts) + '</div>'];
              var seenLine = Object.create(null);
              for (var i = 0; i < params.length; i += 1) {
                var p = params[i];
                if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                  var off = p.value.length >= 5 ? 1 : 0;
                  lines.push('<div style="font-size:11px">' + p.marker + ' OHLC ' +
                    Number(p.value[off]).toFixed(2) + ' / ' +
                    Number(p.value[off + 3]).toFixed(2) + ' / ' +
                    Number(p.value[off + 2]).toFixed(2) + ' / ' +
                    Number(p.value[off + 1]).toFixed(2) + '</div>');
                } else {
                  var v = Array.isArray(p.value) ? p.value[1] : p.value;
                  if (v == null) continue;
                  var vText = Number(v).toFixed(2);
                  var key = String(p.seriesName) + '|' + vText;
                  if (seenLine[key]) continue;
                  seenLine[key] = true;
                  lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName + ': ' + vText + '</div>');
                }
              }
              return lines.join('');
            },
          },
          legend: { show: false },
          // right を 60 に拡大して avg/stop/TP の endLabel (右端 'avg X' 等) を
          // 描画範囲に収める。bottom は slider 18px + padding 10 = 28 のまま。
          grid: { left: 40, right: 60, top: 8, bottom: 28 },
          dataZoom: dataZoomCfg,
          xAxis: useCategoryAxis ? {
            type: 'category', data: categories,
            axisLabel: { formatter: function (value) { return jstLabel(value); }, hideOverlap: true, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: false },
          } : {
            type: 'time',
            axisLabel: { formatter: function (value) { return jstLabel(value); }, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value', min: yMin, max: yMax,
            axisLabel: { showMinLabel: false, showMaxLabel: false, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: true, lineStyle: { opacity: 0.1 } },
          },
          series: [
            // 押し目ゾーン markArea (host series)。保有時は非表示。個別銘柄タブと同実装。
            ...((sc.position || !pullbackBandMarkArea) ? [] : [{
              name: '押し目ゾーン',
              type: 'line', data: [], symbol: 'none', z: 1,
              markArea: pullbackBandMarkArea,
            }]),
            // 押し目 sloped 上下端 (#238)。markArea の上に重ねて傾きを可視化。
            ...((sc.position || !pullbackBandMarkArea || !pullbackBandHasData) ? [] : [
              {
                name: '押し目上端', type: 'line', data: pullbackUpperXY,
                connectNulls: false,
                lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
                itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
                symbol: 'none', z: 2,
              },
              {
                name: '押し目下端', type: 'line', data: pullbackLowerXY,
                connectNulls: false,
                lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
                itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
                symbol: 'none', z: 2,
              },
            ]),
            ...(trendLineXY ? [{
              name: 'trend', type: 'line', data: trendLineXY,
              lineStyle: { width: 1.2, color: '#9333ea' }, symbol: 'none',
              itemStyle: { color: '#9333ea' }, z: 7,
            }] : []),
            ...(ohlcXY.length > 0 ? [{
              name: 'price', type: 'candlestick', data: ohlcXY,
              barWidth: 6,
              itemStyle: {
                color: '#057a55', color0: '#c22',
                borderColor: '#057a55', borderColor0: '#c22', borderWidth: 1,
              },
              z: 5,
              markLine: sessionOpenIndices.length > 0 ? {
                symbol: 'none', silent: true, label: { show: false },
                lineStyle: { color: '#bbb', width: 1, type: 'dashed' }, z: 1,
                data: sessionOpenIndices.map(function (idx) { return { xAxis: idx }; }),
              } : undefined,
              // BUY/SELL pin の hover tooltip (qty / realized PnL / fill 時刻)。
              // 個別銘柄タブと同形 (symbolSize は panel に合わせて 18 のまま)。
              markPoint: entries.length + exits.length > 0 ? {
                symbol: 'pin', symbolSize: 18, data: entries.concat(exits),
                tooltip: {
                  trigger: 'item',
                  formatter: function (p) {
                    var d = p.data;
                    var pnl = d.realizedPnl == null
                      ? ''
                      : '<br/>realized PnL: ' + (d.realizedPnl >= 0 ? '+' : '') + d.realizedPnl.toFixed(2);
                    var qty = d.qty == null ? '' : '<br/>qty: ' + d.qty;
                    var ts = d.fillTimestamp == null ? '' : '<br/>fill: ' + jstLabel(d.fillTimestamp);
                    return d.name + ' @ ' + d.value.toFixed(2) + pnl + qty + ts;
                  },
                },
              } : undefined,
            }] : []),
            // SMA50: candle (z:5) より上、trend (z:7) と同じ層に置く。連続値で
            // null は break (gap) させる。色は TradingView 系の orange (#f59e0b)。
            {
              name: 'SMA50', type: 'line', data: smasXY,
              lineStyle: { width: 1.2, color: '#f59e0b' },
              symbol: 'none', connectNulls: true, z: 6,
              itemStyle: { color: '#f59e0b' },
            },
            ...(avgLineXY ? [{
              name: 'avg', type: 'line', data: avgLineXY,
              lineStyle: { width: 1, color: '#444' }, symbol: 'none',
              itemStyle: { color: '#444' },
              endLabel: { show: true, formatter: 'avg', color: '#444', fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            ...(stopLineXY ? [{
              name: 'stop', type: 'line', data: stopLineXY,
              lineStyle: { width: 1, color: '#c22', type: 'dashed' }, symbol: 'none',
              itemStyle: { color: '#c22' },
              endLabel: { show: true, formatter: 'stop', color: '#c22', fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            ...(tpLineXY ? [{
              name: 'tp', type: 'line', data: tpLineXY,
              lineStyle: { width: 1, color: '#057a55', type: 'dashed' }, symbol: 'none',
              itemStyle: { color: '#057a55' },
              endLabel: { show: true, formatter: 'tp', color: '#057a55', fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            // preview stop / TP (保有ナシで current price ベースの仮置き)。
            // dotted + opacity 0.5 で actual position lines と区別。
            ...(previewStopLineXY ? [{
              name: 'preview stop', type: 'line', data: previewStopLineXY,
              lineStyle: { width: 1, color: '#c22', type: 'dotted', opacity: 0.5 }, symbol: 'none',
              itemStyle: { color: '#c22' },
              endLabel: { show: true, formatter: 'p.stop', color: '#c22', opacity: 0.7, fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 7,
            }] : []),
            ...(previewTpLineXY ? [{
              name: 'preview tp', type: 'line', data: previewTpLineXY,
              lineStyle: { width: 1, color: '#057a55', type: 'dotted', opacity: 0.5 }, symbol: 'none',
              itemStyle: { color: '#057a55' },
              endLabel: { show: true, formatter: 'p.tp', color: '#057a55', opacity: 0.7, fontSize: 10 },
              silent: true, emphasis: { disabled: true }, z: 7,
            }] : []),
          ],
        });
        return { elId: elId, chart: chart, useCategoryAxis: useCategoryAxis, nearestIndex: nearestIndex, categories: categories, ohlcMs: ohlcMs };
      }

      // 各 panel を build。null (load 失敗) は skip。
      var panels = [];
      for (var i = 0; i < data.charts.length; i += 1) {
        var entry = data.charts[i];
        var built = buildPanel('grid-chart-' + i, entry.chart);
        if (built) panels.push(built);
      }
      // echarts.connect で dataZoom + axisPointer (縦線) + legend を全 panel
      // 同期する (PR #237/#241 の経緯参照):
      //   - PR #237 で connect 採用 → tooltip popup まで全 panel 同期されてしまい、
      //     16 panel hover で popup の山に (ユーザ #43 報告)。
      //   - PR #241 で connect 撤去、dataZoom のみ手動 broadcast に変更。だが
      //     「縦線 (axisPointer) の同期は欲しかった」というフィードバックを受け、
      //     本 PR (#242) で connect を復活。
      //   - tooltip popup だけ panel ローカルにするため、tooltip.formatter 側で
      //     window.__gridHoveredPanelId !== elId なら空文字を返して描画スキップ
      //     (formatter 内のコメント参照)。axisPointer 縦線は formatter 結果と
      //     独立に描画されるので、空文字でも縦線は出る。
      //
      // panel DOM の mouseenter/leave で window.__gridHoveredPanelId を更新する
      // (DOMContentLoaded 開始時に null で初期化)。
      var instances = panels.map(function (p) { return p.chart; });
      if (instances.length > 0) echarts.connect(instances);

      window.__gridHoveredPanelId = null;
      panels.forEach(function (panel) {
        var dom = panel.chart.getDom();
        if (!dom) return;
        // mouseenter は子要素遷移で再発火しないので panel 単位の追跡に最適。
        dom.addEventListener('mouseenter', function () {
          window.__gridHoveredPanelId = panel.elId;
        });
        dom.addEventListener('mouseleave', function () {
          if (window.__gridHoveredPanelId === panel.elId) {
            window.__gridHoveredPanelId = null;
          }
        });
      });

      // resize 時は全 panel を resize (responsive)
      window.addEventListener('resize', function () {
        for (var i = 0; i < instances.length; i += 1) instances[i].resize();
      });

      // dataZoom event 1 つを listen して URL ?from / ?to を更新。connect 経由
      // で全 panel が同期発火するので panel[0] からだけ読み出せば十分 (debounce
      // 200ms で zoom drag 中の連続発火をまとめる)。
      function panelDataZoomToMs(panel) {
        var opt = panel.chart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return null;
        var sv = dz.startValue, ev = dz.endValue;
        if (sv == null || ev == null) return null;
        if (panel.useCategoryAxis) {
          var sIdx = Math.max(0, Math.min(panel.categories.length - 1, Math.round(sv)));
          var eIdx = Math.max(0, Math.min(panel.categories.length - 1, Math.round(ev)));
          var fromMs = new Date(panel.categories[sIdx]).getTime();
          var toMs = new Date(panel.categories[eIdx]).getTime();
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
          return { fromMs: fromMs, toMs: toMs };
        }
        return { fromMs: sv, toMs: ev };
      }
      var dzTimer = null;
      function onDz() {
        if (dzTimer) clearTimeout(dzTimer);
        dzTimer = setTimeout(function () {
          if (panels.length === 0) return;
          var range = panelDataZoomToMs(panels[0]);
          if (!range) return;
          try {
            var fromIso = new Date(range.fromMs).toISOString();
            var toIso = new Date(range.toMs).toISOString();
            var url = new URL(window.location.href);
            url.searchParams.set('from', fromIso);
            url.searchParams.set('to', toIso);
            window.history.replaceState({}, '', url.toString());
          } catch (e) { /* noop */ }
        }, 200);
      }
      for (var pi2 = 0; pi2 < panels.length; pi2 += 1) {
        panels[pi2].chart.on('dataZoom', onDz);
      }

      // preset zoom buttons (1D/5D/1M/All): 全 panel に dispatchAction で
      // 共通 ms 範囲を broadcast。category mode panel では nearestIndex で
      // index に snap してから dispatch (panel 個別)。connect でも同期するが、
      // panel 毎に category 軸の index が異なるので明示 dispatch が確実。
      var presetButtons = document.querySelectorAll('.zoom-preset');
      for (var pj = 0; pj < presetButtons.length; pj += 1) {
        presetButtons[pj].addEventListener('click', function (ev) {
          var fromMs = Number(ev.currentTarget.getAttribute('data-from-ms'));
          var toMs = Number(ev.currentTarget.getAttribute('data-to-ms'));
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
          for (var pk = 0; pk < panels.length; pk += 1) {
            var p = panels[pk];
            var sv, eV;
            if (p.useCategoryAxis) {
              sv = p.nearestIndex(fromMs);
              eV = p.nearestIndex(toMs);
              if (sv < 0 || eV < 0) continue;
              if (sv > eV) { var tmp = sv; sv = eV; eV = tmp; }
            } else {
              sv = fromMs; eV = toMs;
            }
            p.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
            p.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: sv, endValue: eV });
          }
        });
      }
    });
  `

  return `<p class="muted" style="font-size:12px">
    ALLOWED_SYMBOLS の全銘柄を 4 列 grid で並列表示 (Datadog dashboard 風)。
    ズーム / パン (slider drag, wheel) と axisPointer 縦線は全 panel 間で同期、
    tooltip popup は hover した panel ローカル。panel 左上の銘柄名をクリックする
    と個別銘柄タブの詳細表示に遷移。
  </p>
  ${presetButtonsHtml}
  <div class="grid-filter-bar" style="display:flex;gap:14px;align-items:center;margin-top:8px;font-size:12px;flex-wrap:wrap">
    <span class="muted">表示:</span>
    <label style="cursor:pointer"><input type="checkbox" id="grid-filter-position" checked> 保有あり</label>
    <label style="cursor:pointer"><input type="checkbox" id="grid-filter-flat" checked> 未保有</label>
    <label style="cursor:pointer"><input type="checkbox" id="grid-filter-inactive"> INACTIVE</label>
    <span class="muted" id="grid-filter-count" style="margin-left:auto"></span>
  </div>
  <div class="symbols-grid" style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px;margin-top:12px">
    ${panelsHtml}
  </div>
  <style>
    @media (max-width: 1280px) {
      .symbols-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    }
    @media (max-width: 768px) {
      .symbols-grid { grid-template-columns: 1fr !important; }
    }
  </style>
  ${safeJsonScript('__chartData', payload)}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>
  <script>${filterScript}</script>`
}

/**
 * grid panel filter (保有あり / 未保有 / INACTIVE)。echarts init 後に
 * DOMContentLoaded で発火するよう <script> を initScript より後ろに置く。
 * state は localStorage の `dashboard.gridFilter.v1` に保存。
 *
 * panel の表示/非表示は display:none の toggle のみ。echarts instance は
 * init 済 (= サイズ確定済) なので再表示時に resize 不要。
 */
const filterScript = `
  document.addEventListener('DOMContentLoaded', function () {
    var KEY = 'dashboard.gridFilter.v1';
    var DEFAULT = { position: true, flat: true, inactive: false };
    var state = DEFAULT;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          state = {
            position: parsed.position !== false,
            flat: parsed.flat !== false,
            inactive: parsed.inactive === true,
          };
        }
      }
    } catch (_e) {}

    var cbPosition = document.getElementById('grid-filter-position');
    var cbFlat = document.getElementById('grid-filter-flat');
    var cbInactive = document.getElementById('grid-filter-inactive');
    var counter = document.getElementById('grid-filter-count');
    if (!cbPosition || !cbFlat || !cbInactive) return;
    cbPosition.checked = state.position;
    cbFlat.checked = state.flat;
    cbInactive.checked = state.inactive;

    function apply() {
      var panels = document.querySelectorAll('.symbols-grid .grid-panel');
      var shown = 0;
      // 「今回 visible に切り替わった panel」を resize 対象として記録。echarts は
      // display:none の DOM に init すると 0×0 で残り、後から display:'' にしても
      // 自動 resize しないため、手動で resize() を叩く必要がある (CodeRabbit #237)。
      // 対象を「visible に *なった* panel」だけに絞ってウィンドウ resize 全件再
      // レイアウトのコストを避ける。
      var newlyShown = [];
      for (var i = 0; i < panels.length; i++) {
        var p = panels[i];
        var hasPos = p.getAttribute('data-has-position') === '1';
        var inact = p.getAttribute('data-inactive') === '1';
        // INACTIVE は最優先 (inactive チェックが OFF なら問答無用で隠す)
        var visible;
        if (inact) {
          visible = state.inactive;
        } else if (hasPos) {
          visible = state.position;
        } else {
          visible = state.flat;
        }
        var wasHidden = p.style.display === 'none';
        p.style.display = visible ? '' : 'none';
        if (visible) {
          shown++;
          if (wasHidden) newlyShown.push(p);
        }
      }
      if (counter) counter.textContent = shown + ' / ' + panels.length + ' 銘柄表示';
      // panel が再表示されたら、内部の echarts instance を resize して
      // 0×0 サイズや stale viewport size のままにならないようにする。
      // window resize されてた間に hidden だった panel も含めて safe。
      if (newlyShown.length > 0 && typeof echarts !== 'undefined') {
        for (var j = 0; j < newlyShown.length; j++) {
          var chartDiv = newlyShown[j].querySelector('[id^="grid-chart-"]');
          if (!chartDiv) continue;
          var inst = echarts.getInstanceByDom(chartDiv);
          if (inst) inst.resize();
        }
      }
    }

    function onChange() {
      state = { position: cbPosition.checked, flat: cbFlat.checked, inactive: cbInactive.checked };
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_e) {}
      apply();
    }
    cbPosition.addEventListener('change', onChange);
    cbFlat.addEventListener('change', onChange);
    cbInactive.addEventListener('change', onChange);
    apply();
  });
`

/**
 * grid panel header の右肩に出す軽量 indicators badge (price / SMA50)。
 * 個別銘柄タブの `renderCurrentIndicatorsBadge` の縮小版。
 * 「市場全体ビュー」で trader が「現在価格と SMA50 の位置関係」を一目で
 * 判断するための最小限情報。high20d / low20d / atr は省略 (panel 幅優先)。
 */
function renderGridPanelBadge(chart: SymbolChartData): string {
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  if (!latest) return ''
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  return `<span style="font-size:11px;white-space:nowrap">
    <span class="muted">px:</span> <strong>${esc(fmt(latest.price))}</strong>
    <span class="muted" style="margin-left:6px">SMA50:</span> ${esc(fmt(latest.sma50))}
  </span>`
}

/**
 * PullbackUptrendStrategy の TEST_DEFAULT_RULE と一致 (=コード上の default)。
 * チャートパネルで「default 値から変更されている項目」を ⚠ で flag するための
 * 比較対象。schema 側の default も同値 (pullback_default_*)。
 */
const STRATEGY_DEFAULTS: StrategyParamsSnapshot = {
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.0,
}

/**
 * チャート併置の戦略パラメータパネル (#168)。チャート上のラベル
 * (押し目 ×N、stop -4% 等) はオーバーレイ 4 本制限のため限定的なので、
 * 補助情報として全パラメータを一覧表示。default からの変更を ⚠ で強調し
 * 「設定の意図しない残存」(例: pullback_max=0 のデバッグ残骸) に運用者が
 * 気づきやすくする。
 */
export function renderStrategyParamsPanel(p: StrategyParamsSnapshot): string {
  const flag = (current: number | boolean, def: number | boolean): string =>
    current === def ? '' : ' <span class="warn" title="default 値から変更">⚠</span>'
  const pct = (n: number): string =>
    (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
  const rows: Array<{ label: string; current: string; def: string; flag: string }> = [
    {
      label: '損切ライン (stopPct)',
      current: pct(p.stopPct),
      def: pct(STRATEGY_DEFAULTS.stopPct),
      flag: flag(p.stopPct, STRATEGY_DEFAULTS.stopPct),
    },
    {
      label: '利食ライン (takeProfitPct)',
      current: pct(p.takeProfitPct),
      def: pct(STRATEGY_DEFAULTS.takeProfitPct),
      flag: flag(p.takeProfitPct, STRATEGY_DEFAULTS.takeProfitPct),
    },
    {
      label: '時間切れ (timeStopDays)',
      current: `${p.timeStopDays} 営業日`,
      def: `${STRATEGY_DEFAULTS.timeStopDays} 営業日`,
      flag: flag(p.timeStopDays, STRATEGY_DEFAULTS.timeStopDays),
    },
    {
      label: '押し目 上限 (pullbackMax)',
      current: pct(p.pullbackMax),
      def: pct(STRATEGY_DEFAULTS.pullbackMax),
      flag: flag(p.pullbackMax, STRATEGY_DEFAULTS.pullbackMax),
    },
    {
      label: '押し目 下限 (pullbackMin)',
      current: pct(p.pullbackMin),
      def: pct(STRATEGY_DEFAULTS.pullbackMin),
      flag: flag(p.pullbackMin, STRATEGY_DEFAULTS.pullbackMin),
    },
    {
      label: '50日騰落率 閾値 (minReturn50d)',
      current: pct(p.minReturn50d),
      def: pct(STRATEGY_DEFAULTS.minReturn50d),
      flag: flag(p.minReturn50d, STRATEGY_DEFAULTS.minReturn50d),
    },
    {
      label: 'SMA50 上 必須 (requireAboveSma50)',
      current: p.requireAboveSma50 ? 'true' : 'false',
      def: STRATEGY_DEFAULTS.requireAboveSma50 ? 'true' : 'false',
      flag: flag(p.requireAboveSma50, STRATEGY_DEFAULTS.requireAboveSma50),
    },
    {
      label: 'ATR 倍率 (kAtr、サイジング用)',
      current: p.kAtr.toFixed(2),
      def: STRATEGY_DEFAULTS.kAtr.toFixed(2),
      flag: flag(p.kAtr, STRATEGY_DEFAULTS.kAtr),
    },
  ]
  const tbody = rows
    .map(
      (r) =>
        `<tr><th>${esc(r.label)}</th><td>${esc(r.current)}${r.flag}</td><td class="muted">${esc(r.def)}</td></tr>`,
    )
    .join('')
  return `<details open style="margin-top:12px">
    <summary style="cursor:pointer;font-size:13px">戦略パラメータ (PullbackUptrendStrategy) — <span class="muted">⚠ は default から変更されている項目</span></summary>
    <table style="margin-top:8px">
      <thead><tr><th>項目</th><th>現在値</th><th>default</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">
      設定変更は <code>UPDATE global_config SET pullback_default_* = ... WHERE id = 'default'</code> で。
      per-symbol override は POC scope では未対応。
    </p>
  </details>`
}

/**
 * dataZoom プリセット (1D / 5D / 1M / All)。TradingView ライクの 1 click ズーム。
 * lastTimestamp 基準で from/to を data-attr に焼き、client 側 click handler で
 * symChart.dispatchAction({ type: 'dataZoom', startValue, endValue }) を発火する。
 * 既存の dataZoom listener が URL を replaceState で更新するので、preset でも
 * URL ?from / ?to が同期される。
 */
export function renderZoomPresetButtons(chart: SymbolChartData | null): string {
  if (!chart || chart.points.length === 0) return ''
  const lastPoint = chart.points[chart.points.length - 1]!
  const lastMs = new Date(lastPoint.timestamp).getTime()
  if (!Number.isFinite(lastMs)) return ''
  const earliestMs = (() => {
    const first = chart.points[0]
    if (!first) return lastMs
    const ms = new Date(first.timestamp).getTime()
    return Number.isFinite(ms) ? ms : lastMs
  })()
  const day = 24 * 3600 * 1000
  const presets: Array<{ label: string; fromMs: number; toMs: number }> = [
    { label: '1D', fromMs: lastMs - 1 * day, toMs: lastMs },
    { label: '5D', fromMs: lastMs - 5 * day, toMs: lastMs },
    { label: '1M', fromMs: lastMs - 30 * day, toMs: lastMs },
    { label: 'All', fromMs: earliestMs, toMs: lastMs },
  ]
  const buttons = presets
    .map(
      (p) =>
        `<button class="zoom-preset" data-from-ms="${p.fromMs}" data-to-ms="${p.toMs}" style="margin-right:6px;padding:3px 10px;font-size:12px;background:#fafafa;border:1px solid #d0d0d5;border-radius:4px;cursor:pointer;color:#1d1d1f">${esc(p.label)}</button>`,
    )
    .join('')
  return `<p style="margin:8px 0 0">${buttons}</p>`
}

/**
 * チャート上に「現在の主要 indicator (price / SMA50 / high20d / low20d / atr20)」
 * を inline badge で表示。trader-strategist 助言で SMA50 を chart line から
 * 撤去 (15m chart の y軸を引き伸ばさないため) した代替表示。最新の cron-eval
 * point から取得し、null は em-dash (—) で fallback。
 */
export function renderCurrentIndicatorsBadge(chart: SymbolChartData | null): string {
  if (!chart) return ''
  // 最新の indicator 付き point を末尾から探す (Yahoo filler は indicators null)
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  if (!latest) return ''
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  const items: Array<[string, string]> = [
    ['price', fmt(latest.price)],
    ['SMA50', fmt(latest.sma50)],
    ['high20d', fmt(latest.high20d)],
    ['low20d', fmt(latest.low20d)],
  ]
  const badges = items
    .map(
      ([k, v]) =>
        `<span style="display:inline-block;margin-right:10px;font-size:12px"><span class="muted">${esc(k)}:</span> <strong>${esc(v)}</strong></span>`,
    )
    .join('')
  return `<p style="margin:6px 0 0">${badges}</p>`
}

function renderSymbolPickerForTab(args: ChartsBodySymbol): string {
  if (args.availableSymbols.length === 0) return ''
  // 銘柄切替時にズーム範囲を維持するため、現在の from/to を picker URL に伝搬
  const zoomQs = args.zoom
    ? `&from=${encodeURIComponent(args.zoom.from.toISOString())}&to=${encodeURIComponent(args.zoom.to.toISOString())}`
    : ''
  const opts = args.availableSymbols
    .map((s) => {
      const inactive = isSymbolInactive(s, args.universe)
      const isFocus = s === args.focusSymbol
      const linkClass = inactive ? ' class="symbol-disabled"' : ''
      const titleAttr = inactive ? ` title="${esc(inactiveTooltip(s, args.universe))}"` : ''
      return `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(s)}${zoomQs}"${linkClass}${titleAttr} style="margin-right:6px;${
        isFocus ? 'font-weight:600;text-decoration:underline' : ''
      }">${esc(displaySymbol(s, args.universe))}</a>`
    })
    .join('')
  const focusLabel = args.focusSymbol
    ? displaySymbol(args.focusSymbol, args.universe)
    : '—'
  const focusInactive = args.focusSymbol
    ? isSymbolInactive(args.focusSymbol, args.universe)
    : false
  const focusBadge = focusInactive
    ? ` <span class="muted" style="font-size:11px">(inactive — ${esc(args.universe?.symbolNotes[args.focusSymbol!.toUpperCase()] ?? 'cron 評価対象外')})</span>`
    : ''
  return `<p class="muted" style="font-size:12px">
    銘柄: <strong>${esc(focusLabel)}</strong>${focusBadge} | 切替: ${opts}
  </p>`
}

/**
 * 銘柄管理 (#292) ページの SELECT。`symbol_config` 全行 (active + inactive)
 * を symbol ASC で返す。dashboard 表示専用。
 */
async function loadAllSymbolConfigRows(db: D1Database): Promise<SymbolConfigRow[]> {
  const drizzle = createDb(db)
  return await drizzle.select().from(symbolConfig).orderBy(asc(symbolConfig.symbol))
}

async function findSymbolConfigForView(
  db: D1Database,
  symbol: string,
): Promise<SymbolConfigRow | null> {
  const drizzle = createDb(db)
  const rows = await drizzle
    .select()
    .from(symbolConfig)
    .where(eq(symbolConfig.symbol, symbol))
    .limit(1)
  return rows[0] ?? null
}

interface SymbolsListFilter {
  status: 'all' | 'active' | 'inactive'
  market: 'all' | 'US' | 'JP'
  q: string
}

function applySymbolsListFilter(rows: SymbolConfigRow[], f: SymbolsListFilter): SymbolConfigRow[] {
  const needle = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.status === 'active' && !r.active) return false
    if (f.status === 'inactive' && r.active) return false
    if (f.market !== 'all' && r.market !== f.market) return false
    if (needle) {
      const hay = `${r.symbol} ${r.name ?? ''}`.toLowerCase()
      if (hay.indexOf(needle) === -1) return false
    }
    return true
  })
}

function symbolsListBody(args: {
  rows: SymbolConfigRow[]
  inversePairs?: Record<string, string>
  errorCode?: string | null
  errorSymbol?: string | null
  filter: SymbolsListFilter
}): string {
  const { rows, inversePairs = {}, errorCode = null, errorSymbol = null, filter } = args
  // #415: 買付余力バッジをページ最上部に (全 return が ${errorBanner} を先頭に持つので
  // ここに前置すると一覧・空・フィルタ 0 件の全ケースで表示される)。
  const errorBanner = buyingPowerBadge() + renderSymbolErrorBanner(errorCode, errorSymbol)
  const filtered = applySymbolsListFilter(rows, filter)
  const activeCount = rows.filter((r) => r.active).length
  const inactiveCount = rows.length - activeCount

  const sel = (cur: string, val: string) => (cur === val ? ' selected' : '')
  const filterBar = `<form method="get" action="/dashboard/symbols" style="margin:0 0 12px;padding:8px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
    <input type="search" name="q" value="${esc(filter.q)}" placeholder="🔍 銘柄 / 名前で絞り込み" style="padding:4px 8px;width:200px">
    <select name="status" style="padding:4px 6px">
      <option value="all"${sel(filter.status, 'all')}>全状態</option>
      <option value="active"${sel(filter.status, 'active')}>有効のみ</option>
      <option value="inactive"${sel(filter.status, 'inactive')}>無効のみ</option>
    </select>
    <select name="market" style="padding:4px 6px">
      <option value="all"${sel(filter.market, 'all')}>全市場</option>
      <option value="US"${sel(filter.market, 'US')}>US</option>
      <option value="JP"${sel(filter.market, 'JP')}>JP</option>
    </select>
    <button type="submit" style="padding:4px 12px;background:#06c;color:#fff;border:none;border-radius:4px;cursor:pointer">絞り込み</button>
    <a href="/dashboard/symbols" style="padding:4px 8px;text-decoration:none;font-size:12px;color:#86868b">リセット</a>
  </form>`

  const headerBar = `<p style="margin:0 0 12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols/new" style="padding:6px 12px;background:#06c;color:#fff;border-radius:4px;text-decoration:none">+ 新規追加</a>
    <span class="muted" style="font-size:12px">${filtered.length} / ${rows.length} 件表示 (有効 ${activeCount} / 無効 ${inactiveCount})</span>
  </p>`

  if (rows.length === 0) {
    return `${errorBanner}${headerBar}<p class="muted">登録銘柄なし。「+ 新規追加」から最初の symbol を登録してください。</p>`
  }
  if (filtered.length === 0) {
    return `${errorBanner}${filterBar}${headerBar}<p class="muted">フィルタに一致する銘柄無し。条件を緩めてください。</p>`
  }
  // #315: インバース対が隣接するよう並べ替え、ペアごとに交互の薄色背景 + ツリー表記。
  const ordered = orderRowsByPair(filtered, inversePairs)
  const pairColor = assignPairColors(ordered, inversePairs)
  const roles = pairRoles(ordered, inversePairs)
  const tbody = ordered
    .map((r) => {
      const inactive = !r.active
      const sym = r.symbol.toUpperCase()
      const inverse = inversePairs[sym] ?? null
      const role = roles.get(sym) ?? null
      const bg = pairColor.get(sym)
      const rowStyleParts: string[] = []
      if (inactive) rowStyleParts.push('opacity:0.5')
      if (bg) rowStyleParts.push(`background:${bg}`)
      const rowStyle = rowStyleParts.length ? ` style="${rowStyleParts.join(';')}"` : ''
      const symStyle = inactive ? ' style="text-decoration:line-through;color:#86868b"' : ''
      const toggleLabel = r.active ? '無効化' : '有効化'
      const editHref = `/dashboard/symbols/${encodeURIComponent(r.symbol)}/edit`
      const toggleAction = `/admin/symbol-config/${encodeURIComponent(r.symbol)}/toggle-active`
      const deleteAction = `/admin/symbol-config/${encodeURIComponent(r.symbol)}/delete`
      const deleteForm = r.active
        ? '<span class="muted" style="font-size:11px" title="削除するには先に無効化してください">—</span>'
        : `<form method="post" action="${esc(deleteAction)}" style="display:inline" onsubmit="return confirm('${esc(r.symbol)} を完全に削除します (DB row 自体を消去、インバース対のリンクも解除)。元に戻せません。よろしいですか？');">
            <button type="submit" style="padding:3px 8px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">削除</button>
          </form>`
      const maxNotionalCell = r.maxNotional === null
        ? '<span class="muted" title="未設定 = global の MAX_ORDER_NOTIONAL を使用">— (global)</span>'
        : `${esc(r.maxNotional.toLocaleString('ja-JP'))} <span class="muted" style="font-size:11px">${esc(r.currency)}</span>`
      // 売買単位 (lot_size)。未設定・不正値 (NULL/0/負/非整数) は cron sizing が
      // fail-closed (発注見送り) するので、一覧でも同じ判定で赤字警告を出す
      // (loadSymbolConfig の採用条件 = integer>=1 と揃える、CodeRabbit #409)。
      const lotSizeValid = Number.isInteger(r.lotSize) && (r.lotSize as number) >= 1
      const lotSizeCell = !lotSizeValid
        ? '<span class="err" title="売買単位が未設定または不正です。設定するまで BUY は発注されません (fail-closed)。編集から入力してください。">⚠ 未設定</span>'
        : `${esc(String(r.lotSize))} <span class="muted" style="font-size:11px">${r.lotSize === 1 ? '株/口' : '株'}</span>`
      // 予算配分 ladder slider (#budget-alloc): 5%刻み。確定するまで client 側で仮調整、
      // form="symbol-budget-form" で一括 POST。inverse 相手は JS が同期する。
      const allocPctNum = r.budgetAllocPct != null ? Math.round(r.budgetAllocPct * 1000) / 10 : 0
      const budgetCell = `<div style="display:flex;align-items:center;gap:6px;min-width:170px">
          <input type="range" name="pct_${esc(r.symbol)}" form="symbol-budget-form" min="0" max="100" step="5" value="${allocPctNum}"
            data-symbol="${esc(r.symbol)}"${inverse ? ` data-inverse="${esc(inverse)}"` : ''}
            oninput="window.onBudgetSlide(this)" style="width:110px;vertical-align:middle">
          <span id="budget-label-${esc(r.symbol)}" class="muted" style="font-size:12px;width:42px;text-align:right;font-variant-numeric:tabular-nums">${allocPctNum === 0 ? 'risk' : allocPctNum + '%'}</span>
        </div>`
      // ツリー表記 (#315): 対を縦線で連結。上段は中央→下端に縦線 + 中央で右へ横棒
      // (┌)、下段は上端→中央に縦線 + 中央で右へ横棒 (└)。隣接行で左の縦線が
      // 行境界を跨いで連結し、1 本の bracket に見える。線は相手 edit へのリンク。
      const treeTitle = inverse
        ? `インバース対: ${esc(inverse)} (相手に建玉がある間は BUY 見送り #315)`
        : ''
      const connBase =
        'position:absolute;left:11px;width:9px;border-left:2px solid #06c;display:block'
      const connStyle =
        role === 'top'
          ? `${connBase};top:50%;bottom:0;border-top:2px solid #06c;border-top-left-radius:6px`
          : role === 'bottom'
            ? `${connBase};top:0;bottom:50%;border-bottom:2px solid #06c;border-bottom-left-radius:6px`
            : ''
      const treeCell = connStyle
        ? `<a href="/dashboard/symbols/${encodeURIComponent(inverse!)}/edit" title="${treeTitle}" style="${connStyle}"></a>`
        : ''
      const dateOnly = (r.updatedAt || '').slice(0, 10)
      return `<tr${rowStyle}>
        <td style="position:relative;width:28px;padding:0">${treeCell}</td>
        <td><strong><span${symStyle}>${esc(r.symbol)}</span></strong></td>
        <td>${esc(r.name ?? '')}</td>
        <td><code style="font-size:11px">${esc(r.market)}/${esc(r.currency)}</code></td>
        <td>${lotSizeCell}</td>
        <td>${maxNotionalCell}</td>
        <td>${budgetCell}</td>
        <td>${esc(r.notes ?? '')}</td>
        <td class="muted" style="font-size:11px">${esc(dateOnly)}</td>
        <td>
          <a href="${esc(editHref)}" style="padding:3px 8px;font-size:12px;text-decoration:none">編集</a>
          <form method="post" action="${esc(toggleAction)}" style="display:inline">
            <button type="submit" style="padding:3px 8px;font-size:12px;cursor:pointer">${esc(toggleLabel)}</button>
          </form>
          ${deleteForm}
        </td>
      </tr>`
    })
    .join('')
  return `${errorBanner}${filterBar}${headerBar}
  <table>
    <thead><tr>
      <th style="width:28px" title="インバース対のツリー表記"></th>
      <th>銘柄</th>
      <th>銘柄名</th>
      <th>市場/通貨</th>
      <th>売買単位</th>
      <th>1注文上限</th>
      <th>予算配分</th>
      <th>メモ</th>
      <th>更新日</th>
      <th>操作</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  ${budgetLadderControls()}
  ${safeJsonScript(
    '__budgetBaseline',
    rows
      .filter((r) => r.budgetAllocPct != null && r.budgetAllocPct > 0)
      .map((r) => ({
        s: r.symbol.toUpperCase(),
        pct: Math.round((r.budgetAllocPct as number) * 1000) / 10,
        inv: inversePairs[r.symbol.toUpperCase()] ?? null,
      })),
  )}
  <script>${BUDGET_LADDER_JS}</script>`
}

// #budget-alloc ladder の client JS: slider 移動でラベル更新 + インバース相手の
// slider を同値に同期 + 「未確定」バーを表示。保存は確定ボタン押下の form POST のみ
// (即保存しない = 確定するまで仮)。
const BUDGET_LADDER_JS = `
  window.__budgetDirty = {};
  window.__fmtBudget = function (v) { return Number(v) <= 0 ? 'risk' : v + '%'; };
  window.__setBudgetSlider = function (sym, v) {
    var sl = document.querySelector('input[name="pct_' + sym + '"]');
    var lb = document.getElementById('budget-label-' + sym);
    if (sl) sl.value = v;
    if (lb) lb.textContent = window.__fmtBudget(v);
  };
  window.onBudgetSlide = function (el) {
    var sym = el.getAttribute('data-symbol');
    var inv = el.getAttribute('data-inverse');
    var v = el.value;
    var lb = document.getElementById('budget-label-' + sym);
    if (lb) lb.textContent = window.__fmtBudget(v);
    // インバース対は同値に同期 (#315 regime hedge)。相手 slider が一覧に在れば揃える。
    if (inv) window.__setBudgetSlider(inv, v);
    window.__budgetDirty[sym] = true;
    if (inv) window.__budgetDirty[inv] = true;
    var bar = document.getElementById('symbol-budget-bar');
    var note = document.getElementById('symbol-budget-dirty');
    if (bar) bar.style.display = 'flex';
    if (note) note.textContent = Object.keys(window.__budgetDirty).length + ' 銘柄を変更中';
    window.__recomputeBudgetMeter();
  };
  // 同時建玉ベースの予算使用率を全 slider から再計算してメーターを再描画。
  // インバース対は max を 1 回だけ計上 (片側のみ建つため)。
  window.__recomputeBudgetMeter = function () {
    var barMeter = document.getElementById('symbol-budget-bar-meter');
    if (!barMeter) return;
    // 全銘柄の baseline 配分から開始し、表示中 slider の現在値で上書きする。
    // filter で非表示の銘柄の配分が meter から欠落しないようにするため (CodeRabbit #405)。
    var bySym = {};
    (window.__budgetBaseline || []).forEach(function (b) {
      if (b.pct > 0) bySym[b.s] = { pct: b.pct, inv: b.inv };
    });
    var sliders = document.querySelectorAll('input[name^="pct_"]');
    sliders.forEach(function (s) {
      var sym = s.getAttribute('data-symbol');
      var v = Number(s.value);
      if (v > 0) bySym[sym] = { pct: v, inv: s.getAttribute('data-inverse') };
      else delete bySym[sym]; // 0 にした表示中銘柄は除外 (baseline 値で復活させない)
    });
    // 口座(円)単一プールに対する使用率を 1 本で合算。インバース対は max を1回計上。
    var used = 0;
    var counted = {};
    Object.keys(bySym).forEach(function (sym) {
      var e = bySym[sym];
      if (e.inv) {
        var key = [sym, e.inv].sort().join('|');
        if (counted[key]) return;
        counted[key] = true;
        var invPct = bySym[e.inv] ? bySym[e.inv].pct : 0;
        used += Math.max(e.pct, invPct);
      } else {
        used += e.pct;
      }
    });
    if (used <= 0) { barMeter.innerHTML = ''; return; }
    var w = Math.min(100, used);
    var col = used > 100 ? '#c22' : used > 80 ? '#b25000' : '#057a55';
    barMeter.innerHTML = '<span title="同時建玉ベースの口座(円)予算使用率 (インバース対は max を1回計上)" style="display:flex;align-items:center;gap:6px;font-size:12px;flex:1;min-width:0">'
      + '<span class="muted" style="white-space:nowrap">口座予算</span>'
      + '<span class="bar-track" style="flex:1;min-width:40px;height:8px"><span class="bar-fill" style="display:block;width:' + w.toFixed(0) + '%;height:8px;background:' + col + '"></span></span>'
      + '<span style="font-variant-numeric:tabular-nums;color:' + col + ';white-space:nowrap">' + used.toFixed(0) + '% / 100%' + (used > 100 ? ' ⚠超過' : '') + '</span></span>';
  };
`

/** 予算配分 ladder の確定 / 取消 バー。slider は form attr で此処の form に紐づく。 */
function budgetLadderControls(): string {
  return `<form id="symbol-budget-form" method="post" action="/admin/symbol-config/budget-alloc"></form>
  <div id="symbol-budget-bar" style="position:sticky;bottom:0;margin-top:12px;padding:10px 12px;background:#fff;border:1px solid #d0d0d5;border-radius:8px;display:none;align-items:center;gap:12px;box-shadow:0 -2px 8px rgba(0,0,0,0.06)">
    <strong style="font-size:13px">予算配分の変更（未確定）</strong>
    <span id="symbol-budget-dirty" class="muted" style="font-size:12px;white-space:nowrap"></span>
    <span id="symbol-budget-bar-meter" style="display:flex;gap:14px;align-items:center;flex:1"></span>
    <a href="/dashboard/symbols" style="padding:5px 12px;text-decoration:none;border:1px solid #d0d0d5;border-radius:6px;font-size:13px">取消</a>
    <button type="submit" form="symbol-budget-form" style="padding:5px 14px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">確定して保存</button>
  </div>`
}

/**
 * #budget-jpy-base-fx: 同時建玉ベースの口座(円)予算使用率 (単一 %)。
 * budget_alloc_pct は通貨に関係なく「口座(円)全体に対する割合」なので、通貨で分けず
 * 1 本に合算する。インバース対は同時に片方しか建たないので max(両側) で1回だけ計上、
 * standalone と別ペアは加算 = 「口座に対する最大同時コミット率 (%)」。
 */
export function computeBudgetUsage(
  rows: Array<{ symbol: string; budgetAllocPct: number | null }>,
  inversePairs: Record<string, string>,
): number {
  const pctBySym = new Map<string, number>()
  for (const r of rows) {
    const pct = r.budgetAllocPct != null && r.budgetAllocPct > 0 ? r.budgetAllocPct * 100 : 0
    if (pct > 0) pctBySym.set(r.symbol.toUpperCase(), pct)
  }
  let used = 0
  const countedPair = new Set<string>()
  for (const [sym, pct] of pctBySym) {
    const inv = inversePairs[sym]
    if (inv) {
      const key = [sym, inv].sort().join('|')
      if (countedPair.has(key)) continue
      countedPair.add(key)
      used += Math.max(pct, pctBySym.get(inv) ?? 0)
    } else {
      used += pct
    }
  }
  return used
}

/**
 * #315: インバース対が隣接するよう並べ替える。各 symbol を symbol ASC で走査し、
 * 対の相手が未出力かつ filtered 内に在れば直後に続ける。対なし / 既出は単独。
 */
export function orderRowsByPair(
  rows: SymbolConfigRow[],
  inversePairs: Record<string, string>,
): SymbolConfigRow[] {
  const bySym = new Map(rows.map((r) => [r.symbol.toUpperCase(), r]))
  const emitted = new Set<string>()
  const out: SymbolConfigRow[] = []
  for (const r of rows) {
    const sym = r.symbol.toUpperCase()
    if (emitted.has(sym)) continue
    out.push(r)
    emitted.add(sym)
    const inv = inversePairs[sym]
    if (inv && !emitted.has(inv) && bySym.has(inv)) {
      out.push(bySym.get(inv)!)
      emitted.add(inv)
    }
  }
  return out
}

/**
 * ペアごとに薄色背景を交互割り当て (両 symbol が表示中の対のみ着色)。
 * 片側しか表示されていない対 / 対なしは無着色。
 */
export function assignPairColors(
  ordered: SymbolConfigRow[],
  inversePairs: Record<string, string>,
): Map<string, string> {
  const present = new Set(ordered.map((r) => r.symbol.toUpperCase()))
  const colors = ['#eef4ff', '#fff4ec'] as const // 薄青 / 薄橙を交互
  const color = new Map<string, string>()
  const assignedPair = new Set<string>()
  let idx = 0
  for (const r of ordered) {
    const sym = r.symbol.toUpperCase()
    const inv = inversePairs[sym]
    if (!inv || !present.has(inv)) continue
    const key = [sym, inv].sort().join('|')
    if (!assignedPair.has(key)) {
      assignedPair.add(key)
      const c = colors[idx % colors.length]!
      idx++
      color.set(sym, c)
      color.set(inv, c)
    }
  }
  return color
}

/**
 * ordered list 上で各 symbol のツリー位置を判定 (#315 ツリー表記)。
 * 直後が自分の対 → 'top' (┌)、直前が自分の対 → 'bottom' (└)、対なし → null。
 * orderRowsByPair で対は隣接済みなので前後 1 行で判定できる。
 */
export function pairRoles(
  ordered: SymbolConfigRow[],
  inversePairs: Record<string, string>,
): Map<string, 'top' | 'bottom'> {
  const roles = new Map<string, 'top' | 'bottom'>()
  for (let i = 0; i < ordered.length; i++) {
    const sym = ordered[i]!.symbol.toUpperCase()
    const inv = inversePairs[sym]
    if (!inv) continue
    const next = ordered[i + 1]?.symbol.toUpperCase()
    const prev = ordered[i - 1]?.symbol.toUpperCase()
    if (next === inv) roles.set(sym, 'top')
    else if (prev === inv) roles.set(sym, 'bottom')
  }
  return roles
}

/**
 * /admin/symbol-config 系 form POST が失敗時に redirect で渡してくる
 * `?error=...&symbol=...` を表示する banner。known code 以外は generic msg。
 */
function renderSymbolErrorBanner(code: string | null, symbol: string | null): string {
  if (!code) return ''
  const msg = symbolErrorMessage(code, symbol)
  return `<p class="err" style="margin:0 0 12px">${esc(msg)}</p>`
}

function symbolErrorMessage(code: string, symbol: string | null): string {
  const sym = symbol ?? ''
  switch (code) {
    case 'duplicate':
      return sym
        ? `symbol "${sym}" は既に登録済みです。`
        : 'symbol は既に登録済みです。'
    case 'not_found':
      return sym ? `symbol "${sym}" が見つかりません。` : 'symbol が見つかりません。'
    case 'still_active':
      return sym
        ? `symbol "${sym}" は有効化中のため削除できません。先に無効化してから削除してください。`
        : 'symbol が有効化中のため削除できません。先に無効化してください。'
    case 'validation':
      return '入力値に誤りがあります。'
    case 'inverse_self':
      return 'インバース銘柄に主銘柄と同じ symbol は指定できません。'
    default:
      return `エラーが発生しました (code=${code}).`
  }
}

interface SymbolFormArgs {
  mode: 'new' | 'edit'
  row: SymbolConfigRow | null
  /** validation error message — POST handler が re-render する時に渡す。 */
  error: string | null
  /**
   * Pullback rule の global default。override 入力欄の placeholder に「空欄
   * なら N が適用される」と見せるために使う (#316)。読込失敗時 null。
   */
  globalDefaults: { timeStopDays: number; kAtr: number } | null
  /** 編集対象が既に対を組んでいる相手 symbol (#315)。未ペア / new は null。 */
  currentInverse?: string | null
}

function symbolFormBody(args: SymbolFormArgs): string {
  const { mode, row, error, globalDefaults } = args
  const currentInverse = args.currentInverse ?? null
  const action =
    mode === 'new' ? '/admin/symbol-config' : `/admin/symbol-config/${encodeURIComponent(row!.symbol)}/update`
  const symbolValue = row?.symbol ?? ''
  const nameValue = row?.name ?? ''
  const marketValue = row?.market ?? 'US'
  const currencyValue = row?.currency ?? 'USD'
  const activeChecked = (row?.active ?? true) ? ' checked' : ''
  const maxNotionalValue = row?.maxNotional === null || row?.maxNotional === undefined ? '' : String(row.maxNotional)
  const lotSizeValue = row?.lotSize === null || row?.lotSize === undefined ? '' : String(row.lotSize)
  const notesValue = row?.notes ?? ''
  const timeStopDaysOverrideValue =
    row?.timeStopDaysOverride === null || row?.timeStopDaysOverride === undefined
      ? ''
      : String(row.timeStopDaysOverride)
  const kAtrOverrideValue =
    row?.kAtrOverride === null || row?.kAtrOverride === undefined ? '' : String(row.kAtrOverride)
  const timeStopPlaceholder = globalDefaults
    ? `空欄で global default (${globalDefaults.timeStopDays}日) を使用`
    : '空欄で global default を使用'
  const kAtrPlaceholder = globalDefaults
    ? `空欄で global default (${globalDefaults.kAtr}) を使用`
    : '空欄で global default を使用'
  // 予算配分は DB に fraction (0..1) 保存、表示は % (×100)。
  const budgetAllocPctValue =
    row?.budgetAllocPct === null || row?.budgetAllocPct === undefined
      ? ''
      : String(Math.round(row.budgetAllocPct * 1000) / 10)
  const symbolField =
    mode === 'edit'
      ? `<input type="text" name="symbol" value="${esc(symbolValue)}" readonly style="padding:6px;background:#eee">
         <span></span>
         <p class="muted" style="margin:0;font-size:11px">symbol は immutable です。変更したい場合は一度削除して再追加してください。</p>`
      : `<div>
           <div style="position:relative;display:inline-block">
             <input type="text" name="symbol" id="symbol-form-symbol" value="${esc(symbolValue)}" required maxlength="10" pattern="[A-Za-z0-9]{1,10}" placeholder="SOXL / 7974 / 1570" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" oninput="window.searchSymbolSuggest(this.value)" onfocus="window.searchSymbolSuggest(this.value)" onblur="setTimeout(window.hideSymbolSuggest, 200)" style="padding:6px;width:200px;text-transform:uppercase">
             <ul id="symbol-form-symbol-suggest" style="display:none;position:absolute;top:100%;left:0;margin:2px 0 0;padding:0;list-style:none;background:#fff;border:1px solid #d0d0d5;border-radius:4px;width:380px;max-height:280px;overflow-y:auto;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.1)"></ul>
           </div>
         </div>`
  // #315: 登録モード選択 (単体 / インバース対)。new のみ。
  const modeSelector =
    mode === 'new'
      ? `<div style="grid-column:1/-1;display:flex;gap:16px;align-items:center;padding:8px 10px;background:#f5f5f7;border-radius:6px">
           <strong style="font-size:13px">登録モード:</strong>
           <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
             <input type="radio" name="reg_mode" value="single" checked onchange="window.setSymbolRegMode('single')"> 単体登録
           </label>
           <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
             <input type="radio" name="reg_mode" value="inverse" onchange="window.setSymbolRegMode('inverse')"> インバース対で登録
           </label>
         </div>`
      : ''
  // #315: インバース対。new ではモード選択で表示切替する入力欄 (銘柄欄と同じ Yahoo
  // autocomplete)、edit では現在の対を表示。
  const inverseField =
    mode === 'edit'
      ? `<label>インバース対 <span class="muted" style="font-size:11px">(inverse)</span></label>
         <div>
           ${
             currentInverse
               ? `<span>↔ <a href="/dashboard/symbols/${encodeURIComponent(currentInverse)}/edit"><strong>${esc(currentInverse)}</strong></a></span>
                  <p class="muted" style="margin:4px 0 0;font-size:11px">この銘柄は <strong>${esc(currentInverse)}</strong> と対です。相手に建玉がある間は BUY を見送ります (#315)。対の変更は一度削除して再登録してください。</p>`
               : `<span class="muted">未設定 (対なし)</span>
                  <p class="muted" style="margin:4px 0 0;font-size:11px">対を組むには、相手銘柄の新規追加時に「インバース対で登録」を選んでください。</p>`
           }
         </div>`
      : `<label id="symbol-form-inverse-label" style="display:none">インバース銘柄 <span class="muted" style="font-size:11px">(inverse)</span></label>
         <div id="symbol-form-inverse-row" style="display:none">
           <div style="position:relative;display:inline-block">
             <input type="text" name="inverse_symbol" id="symbol-form-inverse" value="" maxlength="10" pattern="[A-Za-z0-9]{1,10}" placeholder="例: SOXS" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" oninput="window.searchInverseSuggest(this.value)" onfocus="window.searchInverseSuggest(this.value)" onblur="setTimeout(window.hideInverseSuggest, 200)" style="padding:6px;width:200px;text-transform:uppercase">
             <ul id="symbol-form-inverse-suggest" style="display:none;position:absolute;top:100%;left:0;margin:2px 0 0;padding:0;list-style:none;background:#fff;border:1px solid #d0d0d5;border-radius:4px;width:380px;max-height:280px;overflow-y:auto;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.1)"></ul>
             <input type="hidden" name="inverse_name" id="symbol-form-inverse-name" value="">
             <input type="hidden" name="inverse_market" id="symbol-form-inverse-market" value="">
             <input type="hidden" name="inverse_currency" id="symbol-form-inverse-currency" value="">
           </div>
         </div>`
  const errBlock = error ? `<p class="err" style="margin:0 0 12px">${esc(error)}</p>` : ''
  const heading = mode === 'new' ? '新規銘柄追加' : `編集: ${esc(symbolValue)}`
  return `<h2 style="font-size:16px;margin:8px 0 12px">${heading}</h2>
  ${errBlock}
  <form method="post" action="${esc(action)}" style="display:grid;grid-template-columns:160px 1fr;gap:8px;max-width:600px;align-items:center">
    ${modeSelector}
    <label>銘柄 <span class="muted" style="font-size:11px">(symbol)</span></label>${symbolField}
    ${inverseField}
    <label>銘柄名 <span class="muted" style="font-size:11px">(name)</span></label>
    <input type="text" name="name" id="symbol-form-name" value="${esc(nameValue)}" maxlength="256" placeholder="人間可読な銘柄名 (任意)" style="padding:6px">
    <label>市場 <span class="muted" style="font-size:11px">(market)</span></label>
    <select name="market" id="symbol-form-market" required style="padding:6px" onchange="window.syncSymbolFormCurrencyFromMarket(this.value)">
      <option value="US"${marketValue === 'US' ? ' selected' : ''}>US (米国)</option>
      <option value="JP"${marketValue === 'JP' ? ' selected' : ''}>JP (日本)</option>
    </select>
    <label>通貨 <span class="muted" style="font-size:11px">(currency)</span></label>
    <div>
      <select name="currency" id="symbol-form-currency" required style="padding:6px" onchange="window.syncSymbolFormCurrencyUnits(this.value)">
        <option value="USD"${currencyValue === 'USD' ? ' selected' : ''}>USD (米ドル)</option>
        <option value="JPY"${currencyValue === 'JPY' ? ' selected' : ''}>JPY (日本円)</option>
      </select>
      <p class="muted" style="margin:4px 0 0;font-size:11px">通常は市場と一致 (US→USD / JP→JPY)。HKD ADR 等、市場と異なる決済通貨の銘柄を想定して別 select として残してある。</p>
    </div>
    <label>状態 <span class="muted" style="font-size:11px">(active)</span></label>
    <label style="display:flex;align-items:center;gap:6px">
      <input type="hidden" name="active" value="false">
      <input type="checkbox" name="active" value="true"${activeChecked}> 取引対象として有効
    </label>
    <label>売買単位 <span class="muted" style="font-size:11px">(lot_size)</span></label>
    <div>
      <input type="number" name="lot_size" id="symbol-form-lot-size" value="${esc(lotSizeValue)}" required step="1" min="1" max="100000" placeholder="必須: 1注文の最小単位" style="padding:6px;width:160px">
      <span class="muted" style="font-size:12px;margin-left:6px">株/口 (1単元)</span>
      <span id="symbol-form-lot-suggest" class="muted" style="font-size:11px;margin-left:6px"></span>
      <p class="muted" style="margin:4px 0 0;font-size:11px"><strong>入力必須</strong> (fallback しません)。1 注文の最小発注数 = 1単元の株数/口数。<strong>JP 個別株は通常 100、ETF (1570/1357 等) と US 株は 1</strong>。未設定の銘柄は cron が発注を見送ります (fail-closed)。Yahoo から銘柄を選ぶと種別 (ETF/個別株) に応じた推奨値を自動入力します (確定は手入力で上書き可)。</p>
    </div>
    <label>1注文上限 <span class="muted" style="font-size:11px">(max_notional)</span></label>
    <div>
      <input type="number" name="max_notional" value="${esc(maxNotionalValue)}" step="0.01" min="0.01" placeholder="空欄で global default を使用" style="padding:6px;width:160px">
      <span class="muted" style="font-size:12px;margin-left:6px"><span id="symbol-form-max-notional-unit">${esc(currencyValue)}</span> / 1 発注</span>
      <p class="muted" style="margin:4px 0 0;font-size:11px">空欄 → global の <code>max_order_notional_<span id="symbol-form-max-notional-global-key">${currencyValue.toLowerCase()}</span></code> を使用。設定値は per-symbol cap として global より優先。</p>
    </div>
    <label>予算配分 <span class="muted" style="font-size:11px">(%)</span></label>
    <div>
      <input type="number" name="budget_alloc_pct" value="${esc(budgetAllocPctValue)}" step="0.1" min="0.1" max="100" placeholder="空欄で risk-% sizing" style="padding:6px;width:160px">
      <span class="muted" style="font-size:12px;margin-left:6px">% of 口座(円)</span>
      <p class="muted" style="margin:4px 0 0;font-size:11px">指定すると <strong>1 注文 = 口座総額 (<code>total_capital_jpy</code>) × この%</strong> で sizing (risk-% を bypass)。USD 銘柄は USD/JPY レートで自動換算 (レート取得失敗時は発注見送り = fail-closed)。上限は <code>min(予算×%, 1注文上限)</code>。空欄なら従来の risk-% sizing。</p>
    </div>
    <label>保有上限 <span class="muted" style="font-size:11px">(time_stop_days)</span></label>
    <div>
      <input type="number" name="time_stop_days_override" value="${esc(timeStopDaysOverrideValue)}" step="1" min="1" max="365" placeholder="${esc(timeStopPlaceholder)}" style="padding:6px;width:160px">
      <span class="muted" style="font-size:12px;margin-left:6px">日 (business days)</span>
      <p class="muted" style="margin:4px 0 0;font-size:11px">空欄 → global の <code>pullback_default_time_stop_days</code> を使用。3x leveraged ETF (SOXL / 1570 等) は短い hold (5-7) が推奨 (#316)。1-365 の整数。</p>
    </div>
    <label>ATR stop 倍率 <span class="muted" style="font-size:11px">(k_atr)</span></label>
    <div>
      <input type="number" name="k_atr_override" value="${esc(kAtrOverrideValue)}" step="0.1" min="0.5" max="5.0" placeholder="${esc(kAtrPlaceholder)}" style="padding:6px;width:160px">
      <span class="muted" style="font-size:12px;margin-left:6px">× ATR20</span>
      <p class="muted" style="margin:4px 0 0;font-size:11px">空欄 → global の <code>pullback_default_k_atr</code> を使用。高ボラ銘柄では緩めに (2.5-3.5)、低ボラは引き締めに (1.5-2.0)。0.5-5.0 の数値 (#316)。</p>
    </div>
    <label>メモ <span class="muted" style="font-size:11px">(notes)</span></label>
    <textarea name="notes" maxlength="256" rows="3" placeholder="自由記述 (例: 一時停止理由 / 上限を絞ってる事情)" style="padding:6px;font-family:inherit">${esc(notesValue)}</textarea>
    <span></span>
    <div style="display:flex;gap:8px">
      <button type="submit" style="padding:6px 16px;background:#06c;color:#fff;border:none;border-radius:4px;cursor:pointer">保存</button>
      <a href="/dashboard/symbols" style="padding:6px 16px;text-decoration:none;border:1px solid #d0d0d5;border-radius:4px">キャンセル</a>
    </div>
  </form>
  <script>
    window.syncSymbolFormCurrencyUnits = function (cur) {
      var unit = document.getElementById('symbol-form-max-notional-unit');
      var key = document.getElementById('symbol-form-max-notional-global-key');
      if (unit) unit.textContent = cur;
      if (key) key.textContent = cur.toLowerCase();
    };
    window.syncSymbolFormCurrencyFromMarket = function (market) {
      var cur = market === 'JP' ? 'JPY' : 'USD';
      var sel = document.getElementById('symbol-form-currency');
      if (sel) sel.value = cur;
      window.syncSymbolFormCurrencyUnits(cur);
    };
    // 汎用 Yahoo lookup suggest コア。listId の <ul> に候補を描画し、click で pick(m)。
    window._symbolSuggestTimer = {};
    window._symbolSuggestSeq = {};
    window._renderSymbolSuggest = function (q, listId, pick) {
      var list = document.getElementById(listId);
      if (!list) return;
      var query = (q || '').trim();
      if (query.length < 2) { list.style.display = 'none'; return; }
      if (window._symbolSuggestTimer[listId]) clearTimeout(window._symbolSuggestTimer[listId]);
      window._symbolSuggestTimer[listId] = setTimeout(function () {
        var mySeq = (window._symbolSuggestSeq[listId] = (window._symbolSuggestSeq[listId] || 0) + 1);
        fetch('/admin/symbol-config/lookup?q=' + encodeURIComponent(query), { credentials: 'same-origin' })
          .then(function (res) { return res.ok ? res.json() : { matches: [] }; })
          .then(function (data) {
            if (mySeq !== window._symbolSuggestSeq[listId]) return; // 古い response は捨てる
            var matches = (data && data.matches) || [];
            list.innerHTML = '';
            if (matches.length === 0) {
              var hint = document.createElement('li');
              hint.style.cssText = 'padding:6px 10px;color:#86868b;font-size:11px;font-style:italic;cursor:default';
              hint.textContent = '"' + query + '" に一致する銘柄無し (Yahoo Finance)。手動入力で続行可。';
              list.appendChild(hint);
              list.style.display = 'block';
              return;
            }
            matches.forEach(function (m) {
              var li = document.createElement('li');
              li.style.cssText = 'padding:6px 10px;cursor:pointer;border-bottom:1px solid #eee';
              var sym = document.createElement('strong');
              sym.textContent = m.symbol;
              var nameSpan = document.createElement('span');
              nameSpan.style.cssText = 'color:#86868b;margin-left:8px;font-size:12px';
              nameSpan.textContent = (m.name || '?') + ' (' + m.market + '/' + m.currency + ')';
              li.appendChild(sym);
              li.appendChild(nameSpan);
              li.addEventListener('mousedown', function () { pick(m); });
              li.addEventListener('mouseover', function () { li.style.background = '#eef'; });
              li.addEventListener('mouseout', function () { li.style.background = '#fff'; });
              list.appendChild(li);
            });
            list.style.display = 'block';
          })
          .catch(function () { list.style.display = 'none'; });
      }, 250);
    };
    // 主銘柄欄: pick で銘柄 / 名前 / 市場 / 通貨を自動入力。
    window.hideSymbolSuggest = function () {
      var list = document.getElementById('symbol-form-symbol-suggest');
      if (list) list.style.display = 'none';
    };
    window.searchSymbolSuggest = function (q) {
      window._renderSymbolSuggest(q, 'symbol-form-symbol-suggest', window.pickSymbolSuggest);
    };
    window.pickSymbolSuggest = function (m) {
      var symInput = document.getElementById('symbol-form-symbol');
      var nameInput = document.getElementById('symbol-form-name');
      var marketSel = document.getElementById('symbol-form-market');
      var currencySel = document.getElementById('symbol-form-currency');
      if (symInput) symInput.value = m.symbol;
      if (m.name && nameInput) nameInput.value = m.name;
      if (m.market && marketSel) marketSel.value = m.market;
      if (m.currency && currencySel) currencySel.value = m.currency;
      if (m.currency) window.syncSymbolFormCurrencyUnits(m.currency);
      window.suggestLotSizeFromMatch(m);
      window.hideSymbolSuggest();
      if (symInput) symInput.focus();
    };
    // Yahoo quoteType + market から売買単位の推奨値を自動入力する。
    // ETF → 1 口、JP 個別株 (EQUITY) → 100 株、US 個別株 → 1 株。あくまで推奨で、
    // operator が手入力で上書き可能 (確定は手入力必須・fail-closed なので #symbol-lot-size)。
    window.suggestLotSizeFromMatch = function (m) {
      var lotInput = document.getElementById('symbol-form-lot-size');
      var hint = document.getElementById('symbol-form-lot-suggest');
      if (!lotInput) return;
      var qt = (m.quoteType || '').toUpperCase();
      var mkt = (m.market || 'US').toUpperCase();
      var suggested = qt === 'ETF' ? 1 : (mkt === 'JP' ? 100 : 1);
      lotInput.value = String(suggested);
      if (hint) {
        var kind = qt === 'ETF' ? 'ETF' : (mkt === 'JP' ? 'JP 個別株' : 'US 株');
        hint.textContent = '推奨: ' + suggested + ' (' + kind + ')。要確認';
      }
    };
    // インバース銘柄欄: 同じ Yahoo suggest だが pick は inverse 入力だけを埋める
    // (主銘柄の name/market/currency は上書きしない)。
    window.hideInverseSuggest = function () {
      var list = document.getElementById('symbol-form-inverse-suggest');
      if (list) list.style.display = 'none';
    };
    window.searchInverseSuggest = function (q) {
      window._renderSymbolSuggest(q, 'symbol-form-inverse-suggest', window.pickInverseSuggest);
    };
    window.pickInverseSuggest = function (m) {
      var inv = document.getElementById('symbol-form-inverse');
      if (inv) { inv.value = m.symbol; inv.focus(); }
      // counterpart の銘柄名 / 市場 / 通貨を hidden field に焼く (#315: 一覧で
      // インバース側の銘柄名を出すため。空 pick / 手動入力時は空のまま)。
      var nm = document.getElementById('symbol-form-inverse-name');
      var mk = document.getElementById('symbol-form-inverse-market');
      var cur = document.getElementById('symbol-form-inverse-currency');
      if (nm) nm.value = m.name || '';
      if (mk) mk.value = m.market || '';
      if (cur) cur.value = m.currency || '';
      window.hideInverseSuggest();
    };
    // 登録モード切替: 単体 / インバース対。inverse 欄の表示と required を制御。
    window.setSymbolRegMode = function (modeVal) {
      var label = document.getElementById('symbol-form-inverse-label');
      var rowEl = document.getElementById('symbol-form-inverse-row');
      var inv = document.getElementById('symbol-form-inverse');
      var show = modeVal === 'inverse';
      if (label) label.style.display = show ? '' : 'none';
      if (rowEl) rowEl.style.display = show ? '' : 'none';
      if (inv) {
        if (show) { inv.setAttribute('required', 'required'); }
        else { inv.removeAttribute('required'); inv.value = ''; window.hideInverseSuggest(); }
      }
    };
  </script>`
}

// #293 calendar events management UI helpers ===============================

/**
 * `<input value="...">` で再表示する form 入力。バリデーション失敗時は
 * 入力値を保ったまま再描画する。
 */
interface EventsEarningsFormEcho {
  symbol: string
  earningsDate: string
  notes: string
}

interface EventsMacroFormEcho {
  /** macro `event_type` (FOMC / CPI / NFP …)。 */
  eventType: string
  /** 自由 text の国コード (US / JP …)。schema 上は notes に集約する。 */
  country: string
  eventDate: string
  notes: string
}

interface EventsBodyArgs {
  earnings: EarningsCalendarRow[]
  macros: MacroEventCalendarRow[]
  from: string
  to: string
  universe: SymbolUniverse | null
  errors: { section: 'earnings' | 'macro'; message: string } | null
  formEcho: {
    earnings: EventsEarningsFormEcho | null
    macro: EventsMacroFormEcho | null
  } | null
  /** 非ブロッキング警告 (例: universe 外 symbol を seed 成功した時)。 */
  notice: { section: 'earnings' | 'macro'; message: string } | null
}

/**
 * dashboard で表示する範囲 = now-30d 〜 now+30d (= "実際に gate が見る窓")。
 * `evaluateEarningsGate` / `evaluateMacroEventGate` は近未来の数営業日しか
 * 見ないので、それを内包しつつ「今月 + 来月」程度を一覧する目安。
 */
function eventsDisplayRange(now: Date): { from: string; to: string } {
  const ms = now.getTime()
  const from = new Date(ms - 30 * 86_400_000).toISOString().slice(0, 10)
  const to = new Date(ms + 30 * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

/**
 * earnings_calendar を ([fromYmd, toYmd]) 範囲で読む。`fetchByRange` は
 * symbol 単位 read なので、ここでは全 symbol の range read を直接 SQL で発行
 * する (dashboard 一覧は universe 全体を横断するため)。
 */
async function loadEarningsInRange(
  db: D1Database,
  fromYmd: string,
  toYmd: string,
): Promise<EarningsCalendarRow[]> {
  return createDb(db)
    .select()
    .from(earningsCalendar)
    .where(
      and(
        gte(earningsCalendar.earningsDate, fromYmd),
        lte(earningsCalendar.earningsDate, toYmd),
      ),
    )
    .orderBy(asc(earningsCalendar.earningsDate), asc(earningsCalendar.symbol))
}

interface ValidationOkEarnings {
  ok: true
  symbol: string
  earningsDate: string
  notes: string | null
  /**
   * symbol が universe.allowedSymbols に無い場合に立つ非ブロッキング警告。
   * spec: "universe 外 symbol は保存を許す + UI で warning 表示" — save は通すが
   * dashboard 側で operator に対して typo の可能性を知らせる。universe が null
   * (load 失敗) の場合は判定スキップ (= warning なし)。
   */
  warning: string | null
}

interface ValidationFail {
  ok: false
  error: string
}

/**
 * earnings 1 行 form を validate する。
 *   - symbol: 1〜16 chars, upper-case 正規化。universe にあれば pass; 無くても
 *     pass (warn のみ)。「inactive 銘柄でも入れさせる」spec に合わせ active
 *     判定は無視 (= 入力 → DB は raw に通す)。
 *   - earnings_date: ISO YYYY-MM-DD, round-trip valid, now-90d 〜 now+365d。
 *   - notes (= form の `notes` field): 任意, 256 chars 上限。
 */
function validateEarningsForm(
  echo: EventsEarningsFormEcho,
  universe: SymbolUniverse | null,
): ValidationOkEarnings | ValidationFail {
  const sym = echo.symbol.trim().toUpperCase()
  if (sym.length === 0 || sym.length > 16) {
    return { ok: false, error: 'symbol は 1〜16 文字で入力してください' }
  }
  // universe 不在は warning にとどめ拒否しない (POC 姿勢、operator が unknown
  // 銘柄を seed したい場合もある、=> notes に書く運用)。
  const date = echo.earningsDate.trim()
  if (!isYmdRoundTrip(date)) {
    return { ok: false, error: 'event_date は YYYY-MM-DD 形式で実在する日付にしてください' }
  }
  if (!withinClampRange(date, new Date())) {
    return { ok: false, error: 'event_date は 過去 90 日 〜 未来 365 日 の範囲にしてください' }
  }
  const notesRaw = echo.notes.trim()
  if (notesRaw.length > 256) {
    return { ok: false, error: 'notes (source) は 256 文字以内にしてください' }
  }
  // universe が読めた場合のみ allowedSymbols 照合 (case-insensitive)。null の時は
  // load 失敗なので照合をスキップ — false-positive 警告を避ける。
  let warning: string | null = null
  if (universe) {
    const inUniverse = universe.allowedSymbols.some((s) => s.toUpperCase() === sym)
    if (!inUniverse) {
      warning = `symbol "${sym}" は symbol_config (universe) に存在しません。typo でなければ symbol 管理から追加してください。`
    }
  }
  return {
    ok: true,
    symbol: sym,
    earningsDate: date,
    notes: notesRaw.length === 0 ? null : notesRaw,
    warning,
  }
}

interface ValidationOkMacro {
  ok: true
  eventType: string
  eventDate: string
  notes: string | null
}

/**
 * macro 1 行 form を validate する。
 *
 * macro schema は `event_kind` / `country` を別 column で持たないため,
 * country は notes に prefix で混ぜる (`"US — Federal Reserve press release"`)。
 * spec 上 "country: 自由 text、escapeHtml on render" なので分離保持は必須ではない。
 */
function validateMacroForm(echo: EventsMacroFormEcho): ValidationOkMacro | ValidationFail {
  const kindRaw = echo.eventType.trim()
  if (kindRaw.length === 0 || kindRaw.length > 32) {
    return { ok: false, error: 'event_kind は 1〜32 文字で入力してください' }
  }
  // schema 制約 `[A-Z0-9_]{1,32}` に合うよう upper-case 化し空白を `_` に
  // 置換 (`'NFP REV'` → `'NFP_REV'`)。それでも regex に外れる場合は reject。
  const kind = kindRaw.toUpperCase().replace(/\s+/g, '_')
  if (!/^[A-Z0-9_]{1,32}$/.test(kind)) {
    return {
      ok: false,
      error: 'event_kind は半角英数 + アンダースコアのみ使えます (例: FOMC / CPI / NFP)',
    }
  }
  const country = echo.country.trim()
  if (country.length > 16) {
    return { ok: false, error: 'country は 16 文字以内にしてください' }
  }
  const date = echo.eventDate.trim()
  if (!isYmdRoundTrip(date)) {
    return { ok: false, error: 'event_date は YYYY-MM-DD 形式で実在する日付にしてください' }
  }
  if (!withinClampRange(date, new Date())) {
    return { ok: false, error: 'event_date は 過去 90 日 〜 未来 365 日 の範囲にしてください' }
  }
  const notesPlain = echo.notes.trim()
  // notes に "country — notes" を畳む。country / notes ともに空なら null。
  const combined =
    country.length > 0 && notesPlain.length > 0
      ? `${country} — ${notesPlain}`
      : country.length > 0
        ? country
        : notesPlain
  if (combined.length > 256) {
    return { ok: false, error: 'country + notes (source) の合計は 256 文字以内にしてください' }
  }
  return {
    ok: true,
    eventType: kind,
    eventDate: date,
    notes: combined.length === 0 ? null : combined,
  }
}

/** `YYYY-MM-DD` の文法 + 実在日付チェック (admin route の isYmd と同じ)。 */
function isYmdRoundTrip(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === value
}

/**
 * 過去 90 日 〜 未来 365 日 (両端含む) に入っているか。date-only 比較。
 *
 * 入力は `YYYY-MM-DD` を UTC 0:00 として解釈。`now` も同じ UTC YMD に丸めた
 * 上で ±90d / ±365d する。`+ 86_400_000` の slack を付けると 91d / 366d も
 * 通ってしまうので、UTC YMD epoch ms で純粋に inclusive 比較する。
 */
function withinClampRange(ymd: string, now: Date): boolean {
  const t = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(t)) return false
  const nowYmd = now.toISOString().slice(0, 10)
  const nowDayMs = Date.parse(`${nowYmd}T00:00:00.000Z`)
  const earliest = nowDayMs - 90 * 86_400_000
  const latest = nowDayMs + 365 * 86_400_000
  return t >= earliest && t <= latest
}

/**
 * バリデーション失敗時 / delete failure 時の再描画 helper。一覧を再 load して
 * エラーメッセージ + 入力 echo つきの events ページを返す。HTTP status は 400
 * (operator 入力起因 — 5xx ではない) を返して PRG 経由ではないことを明示。
 */
async function renderEventsWithError(
  c: Context<DashboardBindings>,
  args: {
    section: 'earnings' | 'macro'
    message: string
    earningsEcho: EventsEarningsFormEcho | null
    macroEcho: EventsMacroFormEcho | null
  },
): Promise<Response> {
  if (!c.env.DB) {
    return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
  }
  const universe = await loadSymbolUniverse(c.env).catch(() => null)
  const { from, to } = eventsDisplayRange(new Date())
  const macroRepo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
  const [earnings, macros] = await Promise.all([
    loadEarningsInRange(c.env.DB, from, to).catch(() => [] as EarningsCalendarRow[]),
    macroRepo.fetchAll({ fromYmd: from, toYmd: to }).catch(() => [] as MacroEventCalendarRow[]),
  ])
  return c.html(
    renderLayout(
      c,
      'イベント',
      eventsBody({
        earnings,
        macros,
        from,
        to,
        universe,
        errors: { section: args.section, message: args.message },
        formEcho: { earnings: args.earningsEcho, macro: args.macroEcho },
        notice: null,
      }),
    ),
    400,
  )
}

/**
 * 保存は成功したが non-blocking 警告 (universe 外 symbol など) を operator に
 * 知らせる必要がある時の再描画 helper。HTTP status は 200 (= 保存済み)。
 */
async function renderEventsWithNotice(
  c: Context<DashboardBindings>,
  args: {
    section: 'earnings' | 'macro'
    message: string
  },
): Promise<Response> {
  if (!c.env.DB) {
    return c.html(renderLayout(c, 'イベント', unavailable('DB not bound')))
  }
  const universe = await loadSymbolUniverse(c.env).catch(() => null)
  const { from, to } = eventsDisplayRange(new Date())
  const macroRepo = createMacroEventCalendarRepo(createMacroEventCalendarDb(c.env.DB))
  const [earnings, macros] = await Promise.all([
    loadEarningsInRange(c.env.DB, from, to).catch(() => [] as EarningsCalendarRow[]),
    macroRepo.fetchAll({ fromYmd: from, toYmd: to }).catch(() => [] as MacroEventCalendarRow[]),
  ])
  return c.html(
    renderLayout(
      c,
      'イベント',
      eventsBody({
        earnings,
        macros,
        from,
        to,
        universe,
        errors: null,
        formEcho: null,
        notice: { section: args.section, message: args.message },
      }),
    ),
  )
}

/**
 * `/dashboard/events` の HTML 本文。earnings (上) + macro (下) の 2 セクション。
 * 各セクションは「+ 追加」`<details>` 内に form, 一覧テーブルに 削除 form。
 * 行が無いセクションは空配列メッセージで表示する (= "未登録" を明示)。
 */
function eventsBody(args: EventsBodyArgs): string {
  const { earnings, macros, from, to, universe, errors, formEcho, notice } = args
  const earningsErr =
    errors && errors.section === 'earnings'
      ? `<p class="err"><strong>エラー:</strong> ${esc(errors.message)}</p>`
      : ''
  const macroErr =
    errors && errors.section === 'macro'
      ? `<p class="err"><strong>エラー:</strong> ${esc(errors.message)}</p>`
      : ''
  const earningsNotice =
    notice && notice.section === 'earnings'
      ? `<p class="warn"><strong>注意:</strong> ${esc(notice.message)}</p>`
      : ''
  const macroNotice =
    notice && notice.section === 'macro'
      ? `<p class="warn"><strong>注意:</strong> ${esc(notice.message)}</p>`
      : ''
  // form が前回 submit で開いていた場合は再描画でも開いた状態を維持したい (operator
  // が値を確認しながら修正できる)。エラー有りなら details[open]、無しなら閉じる。
  const earningsFormOpen = errors?.section === 'earnings' ? ' open' : ''
  const macroFormOpen = errors?.section === 'macro' ? ' open' : ''
  const eEcho = formEcho?.earnings ?? { symbol: '', earningsDate: '', notes: '' }
  const mEcho =
    formEcho?.macro ?? { eventType: '', country: '', eventDate: '', notes: '' }

  const earningsTable =
    earnings.length === 0
      ? '<p class="muted">この範囲には登録された決算がありません。</p>'
      : `<table>
    <thead><tr>
      <th>銘柄<br><span class="muted" style="font-size:10px">symbol</span></th>
      <th>決算日<br><span class="muted" style="font-size:10px">event_date</span></th>
      <th>備考<br><span class="muted" style="font-size:10px">notes</span></th>
      <th>操作</th>
    </tr></thead>
    <tbody>${earnings
      .map((r) => {
        const inactive = isSymbolInactive(r.symbol, universe)
        const sym = `<span${inactive ? ' class="symbol-disabled"' : ''}>${esc(displaySymbol(r.symbol, universe))}</span>${
          inactive
            ? ` <span class="muted" style="font-size:11px">(inactive — ${esc(inactiveTooltip(r.symbol, universe))})</span>`
            : ''
        }`
        return `<tr>
          <td>${sym}</td>
          <td>${esc(r.earningsDate)}</td>
          <td>${esc(r.notes ?? '-')}</td>
          <td><form method="post" action="/dashboard/events/earnings/${r.id}/delete" onsubmit="return confirm('${esc(r.symbol)} ${esc(r.earningsDate)} を削除します。よろしいですか？');" style="margin:0"><button type="submit" style="padding:3px 8px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">削除</button></form></td>
        </tr>`
      })
      .join('')}</tbody>
  </table>`

  const macroTable =
    macros.length === 0
      ? '<p class="muted">この範囲には登録されたマクロイベントがありません。</p>'
      : `<table>
    <thead><tr>
      <th>イベント種別<br><span class="muted" style="font-size:10px">event_type</span></th>
      <th>備考<br><span class="muted" style="font-size:10px">国 / notes</span></th>
      <th>発生日<br><span class="muted" style="font-size:10px">event_date</span></th>
      <th>操作</th>
    </tr></thead>
    <tbody>${macros
      .map((r) => {
        return `<tr>
          <td><code>${esc(r.eventType)}</code></td>
          <td>${esc(r.notes ?? '-')}</td>
          <td>${esc(r.eventDate)}</td>
          <td><form method="post" action="/dashboard/events/macro/${r.id}/delete" onsubmit="return confirm('${esc(r.eventType)} ${esc(r.eventDate)} を削除します。よろしいですか？');" style="margin:0"><button type="submit" style="padding:3px 8px;font-size:12px;background:#c22;color:#fff;border:none;border-radius:4px;cursor:pointer">削除</button></form></td>
        </tr>`
      })
      .join('')}</tbody>
  </table>`

  return `<p class="muted">期間: ${esc(from)} 〜 ${esc(to)} (now-30d 〜 now+30d)。<code>earnings_calendar</code> / <code>macro_event_calendar</code> は risk gate の avoid ソースです。
  add は <code>now-90d 〜 now+365d</code> の範囲に clamp します。delete は audit に記録されます。</p>

<h2 style="font-size:15px;margin:20px 0 6px 0">決算 (earnings)</h2>
${earningsErr}
${earningsNotice}
<details${earningsFormOpen} style="margin-bottom:12px">
  <summary style="cursor:pointer">+ 追加</summary>
  <form method="post" action="/dashboard/events/earnings/seed" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <label>銘柄<br><input name="symbol" value="${esc(eEcho.symbol)}" placeholder="AAPL / 7203" required maxlength="16" style="padding:4px 8px;width:140px"></label>
    <label>決算日<br><input name="earnings_date" type="date" value="${esc(eEcho.earningsDate)}" required style="padding:4px 8px"></label>
    <label>備考 (任意)<br><input name="notes" value="${esc(eEcho.notes)}" placeholder="Q2 2026 BMO" maxlength="256" style="padding:4px 8px;min-width:240px"></label>
    <button type="submit" style="padding:6px 14px;background:#057a55;color:#fff;border:none;border-radius:4px;cursor:pointer">追加</button>
  </form>
</details>
${earningsTable}

<h2 style="font-size:15px;margin:24px 0 6px 0">マクロイベント (macro)</h2>
${macroErr}
${macroNotice}
<details${macroFormOpen} style="margin-bottom:12px">
  <summary style="cursor:pointer">+ 追加</summary>
  <form method="post" action="/dashboard/events/macro/seed" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
    <label>イベント種別<br><input name="event_type" value="${esc(mEcho.eventType)}" placeholder="FOMC / CPI / NFP" required maxlength="32" style="padding:4px 8px;width:160px"></label>
    <label>国 (任意)<br><input name="country" value="${esc(mEcho.country)}" placeholder="US / JP" maxlength="16" style="padding:4px 8px;width:100px"></label>
    <label>発生日<br><input name="event_date" type="date" value="${esc(mEcho.eventDate)}" required style="padding:4px 8px"></label>
    <label>備考 (任意)<br><input name="notes" value="${esc(mEcho.notes)}" placeholder="June FOMC" maxlength="256" style="padding:4px 8px;min-width:240px"></label>
    <button type="submit" style="padding:6px 14px;background:#057a55;color:#fff;border:none;border-radius:4px;cursor:pointer">追加</button>
  </form>
</details>
${macroTable}`
}

/**
 * dashboard 側 form handler 用の audit log writer (#293)。admin.ts の
 * writeAuditLog と同形だが route layer が違うので local copy。actor は Access
 * middleware が `c.set('actor', ...)` 済み (ない場合は extractActor が throw
 * するので try/catch で潰す — admin 同様 audit 欠落で 500 を返したくない)。
 */
async function writeEventsAuditLog(
  c: Context<DashboardBindings>,
  endpoint: string,
  targetKey: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  if (!c.env.DB) return
  try {
    const actor = extractActor(c.get('actor'))
    await recordChange(c.env.DB, {
      actor,
      endpoint,
      targetKey,
      before,
      after,
      requestId: c.get('requestId') ?? null,
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'config_audit_log_write_failed',
        endpoint,
        targetKey,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
