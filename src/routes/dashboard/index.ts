import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../../app'
import type { Env } from '../../config/env'
import { rateLimit } from '../../middleware/rateLimit'

import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadOverviewPanelsCsv, setOverviewPanels } from '../../infrastructure/db/globalConfigRepo'
import { resolveTradingEnabled } from '../../trading/runtime/killSwitch'
import { loadSymbolUniverse, type SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency, SymbolRole } from '../../infrastructure/db/symbolConfigRepo'
import { loadInversePairs, loadPairRegimeConfigs, parseCashFallbacksJson, SYMBOL_ROLES } from '../../infrastructure/db/symbolConfigRepo'
import { escapeHtml, formatSymbolDisplay } from '../../shared/format'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import {
  getTradableStatusForSymbol,
  loadTradableAllowlist,
  type TradableAllowlist,
  type TradableStatus,
} from '../../infrastructure/db/tradableInstrumentsRepo'
import {
  MAX_TIME_STOP_DAYS,
  strategyDecisionLog,
  symbolConfig,
  tradeJournal,
  type SymbolConfigRow,
} from '../../infrastructure/db/schema'
import {
  loadRecentAudit,
  type ConfigAuditRow,
  type LoadAuditOptions,
} from '../../infrastructure/db/configAuditLog'
import {
  loadRecentAlerts,
  type AlertRow,
  type LoadAlertOptions,
} from '../../infrastructure/notification/notificationEmitLog'
import type { NotificationSeverity, NotificationEvent } from '../../infrastructure/notification/Notifier'
import { loadVixRegimeSnapshot } from '../../infrastructure/notification/vixRegimeChange'
import {
  loadPortfolioEquitySnapshots,
  type LoadPortfolioEquitySnapshotOptions,
} from '../../infrastructure/db/portfolioEquitySnapshotRepo'
import type { PortfolioEquitySnapshotRow, TradeJournalRow } from '../../infrastructure/db/schema'
import type { VixRegime } from '../../trading/risk/vixRegimeFilter'
import {
  buildBuyabilityView,
  type BuyabilityView,
  type EntryGateStatus,
  type EvalIndicatorPoint,
} from '../../trading/strategy/entryDistance'
import {
  deriveEntryStatus,
  deriveEntryStatusFromIndicators,
  type EntryStatus,
  type EntryStatusResult,
} from '../../trading/strategy/entryStatus'
import { buildSymbolRules } from '../../trading/strategy/symbolRuleResolution'
import {
  evaluatePairRegime,
  PAIR_REGIME_ZONE_LABELS,
  type PairRegimeDecision,
  type PairRegimeEntry,
} from '../../trading/strategy/pairRegime'
import {
  computeConditionalAllocation,
  type SymbolAllocation,
} from '../../trading/strategy/conditionalAllocation'
import type {
  PullbackIndicators,
  SymbolRule,
} from '../../trading/strategy/strategies/PullbackUptrendStrategy'
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or, type SQL } from 'drizzle-orm'
import { PortfolioStateClient } from '../../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../../trading/state/SymbolStateClient'
import { loadUsdJpyRate } from '../../infrastructure/quotes/fxRate'
import type { SymbolState } from '../../trading/state/types'
import { YahooBarClient } from '../../infrastructure/quotes/YahooBarClient'
// #293 calendar events management UI (earnings + macro)。dashboard 側に form
// 受け handler を置くのは admin/seed が JSON 専用で `application/x-www-form-urlencoded`
// を受けない (= HTML form から直接 POST できない) ため。バリデーション失敗時に
// 入力値を保持したまま再描画する必要があり、PRG redirect だと echo が崩れる。
// repo 呼び出し + rate-limit + writeAuditLog は admin route と同じ部品を再利用。
import {
  createEarningsCalendarDb,
  createEarningsCalendarRepo,
  type EarningsCalendarSeedInput,
} from '../../infrastructure/calendar/earningsCalendarRepo'
import {
  createMacroEventCalendarDb,
  createMacroEventCalendarRepo,
  type MacroEventCalendarSeedInput,
} from '../../infrastructure/calendar/macroEventCalendarRepo'
import { earningsCalendar, macroEventCalendar } from '../../infrastructure/db/schema'
import type { EarningsCalendarRow, MacroEventCalendarRow } from '../../infrastructure/db/schema'
import { extractActor, recordChange } from '../../infrastructure/db/configAuditLog'
// #21 Phase B follow-up: Webull token 管理 UI (seed / status / refresh)。
// admin/webull-token は JSON API、こちらは HTML form + redirect で operator が
// browser から完結できるようにする (DevTools fetch を強要しない)。
import { refreshWebullToken } from '../../infrastructure/webull/refreshWebullToken'
import { WebullAuth } from '../../infrastructure/webull/WebullAuth'
import { WebullTokenClient } from '../../infrastructure/webull/WebullTokenClient'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { clampLimit, currencyOfSymbol, displaySymbol, esc, fmtPct, fmtPctSigned, fmtPriceCcy, inactiveTooltip, isSymbolInactive, jsonPretty, messageOf, parseCursor, safeJsonScript, unavailable } from './shared'
import { type DashboardBindings, layout, loadKillSwitchState, renderLayout } from './layout'
import { ALL_OVERVIEW_PANELS, type OverviewData, buyingPowerBadge, loadRecentFills, overviewBody, parseOverviewPanels } from './overview'
import { loadLatestStrategyPrices, positionsBody } from './positions'
import { parseEquityRange, portfolioBody, safeLoadPortfolioSnapshots } from './portfolio'
import { tradesBody } from './trades'
import { configBody } from './config'
import { cronBody, cronDecisionJson, loadDecisionRows, renderDecisionLadder, renderDecisionTable } from './cron'
import { alertsBody, clampAlertLimit, parseAlertsQuery, parseEventTypeFilter, parseSeverityFilter } from './alerts'
import { auditBody, clampAuditLimit, parseAuditDateFilter, trimQuery } from './audit'
import { type ChartsBodyArgs, type ChartsBodyGrid, type ChartsBodySymbol, ECHARTS_CDN, type StrategyParamsSnapshot, type SymbolPolicySummary, computeZoomRange, parseChartsTab, parseIsoTimestamp, renderChartsSubnav, renderZoomPresetButtons } from './charts/shared'
import { MAX_CHART_DECISIONS, type SymbolChartData, type SymbolChartPoint, type SymbolChartRules, densifyHorizontalLine, densifyTrendLine, loadAllSymbolCharts, loadSymbolChart, pickDefaultSymbol } from './charts/loaders'
import { loadEquityCurve, renderOverviewTab } from './charts/equity'
import { computePnlHistogram, computeTradeStats, loadDecisionBreakdown, loadTradePnls, renderQualityTab } from './charts/quality'
export { safeJsonScript } from './shared'
export { ALL_OVERVIEW_PANELS, OVERVIEW_PANEL_LABELS, parseOverviewPanels } from './overview'
export type { OverviewPanel } from './overview'
export { formatQuoteAsOf, pickFreshQuote } from './positions'
export { parseEquityRange, renderLastRolledCell, renderVixRegimeCell } from './portfolio'
export type { EquityRange } from './portfolio'
export { localizeReason, renderChartDecisionTrace } from './cron'
export type { DecisionRow } from './cron'
export { renderAlertFilterPills } from './alerts'
export { DEFAULT_ZOOM_WINDOW_MS, computeZoomRange, parseChartsTab, parseIsoTimestamp, renderZoomPresetButtons } from './charts/shared'
export type { ChartsBodySymbol, ChartsTab, StrategyParamsSnapshot, SymbolPolicySummary } from './charts/shared'
export { aggregateDailyCloses, anchorJstMidnight, computeChartWindowDays, computeLinearRegressionLine, computeRollingSma, densifyHorizontalLine, densifyTrendLine, deriveOpenPosition, extractSma50, fetchYahooBarsForChart, loadAllSymbolCharts, loadSymbolChart, mergeYahooAndCronPoints, pickDefaultSymbol, resolveFillSide, selectLatestCronSnapshot } from './charts/loaders'
export type { OhlcBar, PivotPoint, SymbolChartData, SymbolChartDecision, SymbolChartMarker, SymbolChartPoint, SymbolChartPosition, SymbolChartRules, TrendLineSegment } from './charts/loaders'
export { computeEquitySeries, loadEquityCurve } from './charts/equity'
export { aggregateDecisionRows, computePnlHistogram, computeTradeStats, loadDecisionBreakdown, loadTradePnls } from './charts/quality'
export type { DecisionBreakdownPoint, PnlHistogramBin, TradeStats } from './charts/quality'

/**
 * Read-only operator dashboard (#121). Server-rendered HTML via Hono — no
 * client JS, no build step. Protected by the same basic-auth middleware as
 * /admin. Every page renders defensively: if a binding (D1 / DO) is missing
 * we surface "unavailable" rather than 500, so a partially-configured env
 * still yields a usable landing.
 */

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
    const before = parseCursor(c.req.query('before'))
    // view filter: 全イベント (default) / 約定・手仕舞いのみ / エラーのみ。
    // ジャーナルは 1 注文で複数 lifecycle 行を持つため、operator の主目的
    // (「何が約定した?」「何が失敗した?」) を 1 クリックで絞れるようにする。
    const view = ((v) => (v === 'fills' || v === 'errors' ? v : 'all'))(c.req.query('view'))
    // 銘柄 / 注文 (clientOrderId) 絞り込み (#nav-links)。clientOrderId は
    // 1 注文の lifecycle 行 (pre_submit / post_submit / エラー) を縦に並べる
    // 「注文詳細ビュー」として機能する。cron の判定行からここへ飛ぶ。
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    const clientOrderIdFilter = c.req.query('clientOrderId')?.trim() || undefined
    const db = createDb(c.env.DB)
    const baseQuery = db.select().from(tradeJournal)
    const conditions: SQL[] = []
    if (view === 'fills') {
      conditions.push(inArray(tradeJournal.tradeEventType, ['fill', 'exit']))
    } else if (view === 'errors') {
      conditions.push(or(isNotNull(tradeJournal.errorMessage), isNotNull(tradeJournal.errorClass))!)
    }
    if (symbolFilter) {
      conditions.push(eq(tradeJournal.symbol, symbolFilter))
    }
    if (clientOrderIdFilter) {
      conditions.push(eq(tradeJournal.clientOrderId, clientOrderIdFilter))
    }
    if (before !== undefined) {
      conditions.push(lt(tradeJournal.id, before))
    }
    const filtered = conditions.length > 0
      ? baseQuery.where(conditions.length === 1 ? conditions[0] : and(...conditions))
      : baseQuery
    // universe を並行 load して銘柄表示を「番号-会社名」(JP) に整形。
    // load 失敗時は `null` を tradesBody に渡し、symbol そのまま表示で fallback。
    const [rows, universe] = await Promise.all([
      filtered.orderBy(desc(tradeJournal.id)).limit(limit + 1),
      loadSymbolUniverse(c.env).catch(() => null),
    ])
    const hasMore = rows.length > limit
    if (hasMore) rows.pop()
    return c.html(
      renderLayout(
        c,
        '約定履歴',
        tradesBody(rows, limit, universe, view, before, hasMore, {
          symbol: symbolFilter,
          clientOrderId: clientOrderIdFilter,
        }),
      ),
    )
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
      return c.html(
        renderLayout(
          c,
          'チャート',
          unavailable('DB not bound'),
          renderChartsSubnav(parseChartsTab(c.req.query('tab'))),
        ),
      )
    }
    try {
      const tab = parseChartsTab(c.req.query('tab'))
      // 各 tab で必要な D1 query だけ走らせる軽量化:
      // - overview: equity (drawdown は equity から派生)
      // - quality:  pnls (= stats / histogram) + decisions
      // - symbol:   universe + symbolChart
      if (tab === 'overview') {
        const equity = await loadEquityCurve(c.env.DB)
        return c.html(
          renderLayout(c, 'チャート', chartsBody({ tab, equity }), renderChartsSubnav(tab)),
        )
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
            renderChartsSubnav(tab),
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
        // 段階判定 (#452 PR 2): 各銘柄の最新 eval indicators を cron と同じ
        // effective rule (global → role preset → override) で 4 段階判定し、
        // panel badge + 表示優先度ソート (ENTRY > HALF > WATCH > NG >
        // cash_parking、inactive / データ無しは末尾) に使う。
        const gridDefaultRule: SymbolRule = {
          stopPct: global.pullbackDefaultStopPct,
          takeProfitPct: global.pullbackDefaultTakeProfitPct,
          timeStopDays: global.pullbackDefaultTimeStopDays,
          pullbackMax: global.pullbackDefaultPullbackMax,
          pullbackMin: global.pullbackDefaultPullbackMin,
          minReturn50d: global.pullbackDefaultMinReturn50d,
          requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
          kAtr: global.pullbackDefaultKAtr,
          maxSma50DeviationPct: global.pullbackDefaultMaxSma50DeviationPct,
          maxAtrRatio: global.pullbackDefaultMaxAtrRatio,
        }
        const gridRules = buildSymbolRules(gridDefaultRule, universe)
        const entryStatuses: Record<string, EntryStatus> = {}
        for (const entry of charts) {
          const lastEval = entry.chart?.evalIndicators?.[entry.chart.evalIndicators.length - 1]
          if (!lastEval) continue
          entryStatuses[entry.symbol] = deriveEntryStatusFromIndicators(
            lastEval.indicators,
            gridRules[entry.symbol] ?? gridDefaultRule,
          ).status
        }
        // 条件連動配分 (#452 Layer 3): target/active を並記する (「設定上 5% だが
        // 現在は SGOV に退避中」の可視化)。cron と同じ pure 関数で計算する。
        const heldSymbols = new Set(
          charts.filter((entry) => entry.chart?.position != null).map((entry) => entry.symbol),
        )
        const allocationView = computeConditionalAllocation({
          targetWeights: universe.symbolBudgetAllocPct,
          policy: {
            entryRequired: new Set(Object.keys(universe.symbolEntryRequired)),
            alwaysActive: new Set(Object.keys(universe.symbolAlwaysActive)),
            cashFallback: universe.symbolCashFallback,
          },
          entryStatuses,
          heldSymbols,
          symbolCurrency: universe.symbolCurrency,
    inversePairs: universe.inversePairs,
        })
        const sortedCharts = sortGridChartsByEntryPriority(charts, entryStatuses, universe)
        // grid の zoom 基準: 全 panel 共通の dataZoom 同期があるため、最初に
        // load 成功した chart の lastTimestamp を基準に直近 7 日 (default) を
        // 採用する。URL ?from / ?to があればそれを優先 (既存と同挙動)。
        const referenceChart = sortedCharts.find((c) => c.chart !== null)?.chart ?? null
        const zoom = computeZoomRange(zoomFrom, zoomTo, referenceChart)
        return c.html(
          renderLayout(
            c,
            'チャート',
            chartsBody({
              tab,
              charts: sortedCharts,
              zoom,
              universe,
              entryStatuses,
              allocations: allocationView.bySymbol,
            }),
            renderChartsSubnav(tab),
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
      // global_config の pullback default (パネルの「銘柄別」タグの比較基準)。
      const globalParams: StrategyParamsSnapshot = {
        stopPct: global.pullbackDefaultStopPct,
        takeProfitPct: global.pullbackDefaultTakeProfitPct,
        timeStopDays: global.pullbackDefaultTimeStopDays,
        pullbackMax: global.pullbackDefaultPullbackMax,
        pullbackMin: global.pullbackDefaultPullbackMin,
        minReturn50d: global.pullbackDefaultMinReturn50d,
        requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
        kAtr: global.pullbackDefaultKAtr,
        maxSma50DeviationPct: global.pullbackDefaultMaxSma50DeviationPct,
        maxAtrRatio: global.pullbackDefaultMaxAtrRatio,
      }
      // cron と同じ effective rule — global default → role preset → per-symbol
      // override (#452)。drift するとダッシュボードの入場ライン / stop・TP
      // preview / パラメータ表が cron 判定とずれるので必ず buildSymbolRules を
      // 共用する。以前はパラメータ表とチャート overlay が global 値のままで、
      // 銘柄管理の override が反映されない見た目バグがあった (operator 指摘)。
      const defaultEntryRule: SymbolRule = { ...globalParams }
      const effectiveRules = buildSymbolRules(defaultEntryRule, universe)
      const entryRule: SymbolRule =
        (focusSymbol ? effectiveRules[focusSymbol] : undefined) ?? defaultEntryRule
      // パネル / チャート overlay は focus symbol の適用値で描く。
      const strategyParams: StrategyParamsSnapshot = { ...entryRule }
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
      const buyability = symbolChart?.evalIndicators?.length
        ? buildBuyabilityView(symbolChart.evalIndicators, entryRule)
        : null
      // 段階判定 (#452 PR 2): 7 gates から ENTRY/HALF/WATCH/NG を導出して表示。
      const entryStatus = buyability?.current ? deriveEntryStatus(buyability.current) : null
      // ペアレジーム (#472): focus symbol が regime 有効ペアの一員なら、cron と
      // 同じ pure 関数で zone を評価して表示する (mode=off では出さない)。
      let pairRegimeView: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null = null
      if (focusSymbol && global.pairRegimeMode !== 'off') {
        const pair = universe.pairRegimes.find(
          (pr) => pr.bullSymbol === focusSymbol || pr.bearSymbol === focusSymbol,
        )
        if (pair) {
          const side = pair.bullSymbol === focusSymbol ? ('bull' as const) : ('bear' as const)
          let decision: PairRegimeDecision
          if (pair.invalidConfig !== null) {
            decision = { zone: 'unknown', score: null, proxySymbol: pair.proxySymbol, asOfDate: null, reason: `misconfig: ${pair.invalidConfig}` }
          } else {
            decision = await new YahooBarClient()
              .getDailyBars(pair.proxySymbol, 80)
              .then((bars) =>
                evaluatePairRegime(bars, {
                  proxySymbol: pair.proxySymbol,
                  thresholds: {
                    bullEnter: global.pairRegimeThetaBullEnter,
                    bullExit: global.pairRegimeThetaBullExit,
                    bearEnter: global.pairRegimeThetaBearEnter,
                    bearExit: global.pairRegimeThetaBearExit,
                  },
                  now: new Date(),
                }),
              )
              .catch((err) => ({
                zone: 'unknown' as const,
                score: null,
                proxySymbol: pair.proxySymbol,
                asOfDate: null,
                reason: `proxy bars fetch failed: ${messageOf(err)}`,
              }))
          }
          pairRegimeView = { decision, side, mode: global.pairRegimeMode }
        }
      }
      // 判定履歴 (#decisions-chart-unify): 戦略判定ページと同じ loader を共用。
      // 失敗 (migration 未適用等) はチャート本体を巻き込まず空表示に落とす。
      const decisionRows =
        focusSymbol && c.env.DB
          ? await loadDecisionRows(createDb(c.env.DB), { symbol: focusSymbol, limit: 30 }).catch(
              () => [],
            )
          : []
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
            strategyParamsGlobal: globalParams,
            zoom,
            universe,
            buyability,
            entryStatus,
            decisionRows,
            pairRegime: pairRegimeView,
            symbolPolicy: focusSymbol
              ? {
                  role: universe.symbolRole[focusSymbol] ?? null,
                  targetWeight: universe.symbolBudgetAllocPct[focusSymbol] ?? null,
                  entryRequired: universe.symbolEntryRequired[focusSymbol] === true,
                  alwaysActive: universe.symbolAlwaysActive[focusSymbol] === true,
                  cashFallbackSymbols: universe.symbolCashFallback[focusSymbol] ?? null,
                }
              : null,
          }),
          renderChartsSubnav(tab, focusSymbol ?? undefined),
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
          traceJson: strategyDecisionLog.traceJson,
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
    const before = parseCursor(c.req.query('before'))
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    // trades の「判定→」から飛んでくる注文単位の絞り込み (#nav-links)。
    const clientOrderIdFilter = c.req.query('clientOrderId')?.trim() || undefined
    const db = createDb(c.env.DB)
    try {
      const [rows, universe] = await Promise.all([
        loadDecisionRows(db, {
          symbol: symbolFilter,
          clientOrderId: clientOrderIdFilter,
          limit: limit + 1,
          before,
        }),
        loadSymbolUniverse(c.env).catch(() => null),
      ])
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return c.html(
        renderLayout(
          c,
          '戦略判定',
          cronBody(rows, limit, symbolFilter, universe, before, hasMore, clientOrderIdFilter),
        ),
      )
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
    const before = parseCursor(c.req.query('before'))
    const severityFilter = parseSeverityFilter(c.req.query('severity'))
    const eventTypeFilter = parseEventTypeFilter(c.req.query('eventType'))
    const currentQuery = parseAlertsQuery(c.req.url)
    const options: LoadAlertOptions = { limit: limit + 1, before }
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
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
      return c.html(
        renderLayout(
          c,
          'アラート',
          alertsBody({ rows, limit, severityFilter, eventTypeFilter, currentQuery, universe, before, hasMore }),
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
    const before = parseCursor(c.req.query('before'))
    const actorFilter = trimQuery(c.req.query('actor'))
    const endpointFilter = trimQuery(c.req.query('endpoint'))
    const fromFilter = parseAuditDateFilter(c.req.query('from'), false)
    const toFilter = parseAuditDateFilter(c.req.query('to'), true)
    const options: LoadAuditOptions = { limit: limit + 1, before }
    if (actorFilter) options.actor = actorFilter
    if (endpointFilter) options.endpoint = endpointFilter
    if (fromFilter) options.fromIso = fromFilter
    if (toFilter) options.toIso = toFilter
    try {
      const rows = await loadRecentAudit(c.env.DB, options)
      const hasMore = rows.length > limit
      if (hasMore) rows.pop()
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
            before,
            hasMore,
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
      const [rows, inversePairs, pairRegimes, tradable] = await Promise.all([
        loadAllSymbolConfigRows(c.env.DB),
        loadInversePairs(createDb(c.env.DB)).catch(() => ({}) as Record<string, string>),
        // 関係マップ用 (#symbol-relation-map)。読めなくても一覧は出す。
        loadPairRegimeConfigs(createDb(c.env.DB)).catch(() => []),
        // #460: OpenAPI 取扱可能銘柄 allowlist。読めなくても一覧は出す (空 map = 全 unknown)。
        loadTradableAllowlist(createDb(c.env.DB)).catch(
          () => new Map() as Awaited<ReturnType<typeof loadTradableAllowlist>>,
        ),
      ])
      // 関係マップの縦軸 = 投入金額 (DO position の qty × avgPrice、ground truth)。
      // 取得失敗・position 無しは 0 (最下段)。fx は表示位置の換算のみに使う。
      const mapAmounts: Record<string, { native: string; jpy: number }> = {}
      if (c.env.SYMBOL_STATE) {
        const stateClient = new SymbolStateClient(c.env.SYMBOL_STATE)
        const usdJpy = await loadUsdJpyRate().catch(() => null)
        await Promise.all(
          rows.map(async (r) => {
            const sym = r.symbol.toUpperCase()
            const state = await stateClient.getState(sym).catch(() => null)
            const pos = state?.position
            if (!pos || pos.qty <= 0) return
            const cost = pos.qty * pos.avgPrice
            if (r.currency === 'USD') {
              // fx 不達時は概算 150 で位置決めだけ行う (表示専用、tooltip は native 額)。
              mapAmounts[sym] = {
                native: `$${cost.toFixed(0)}`,
                jpy: cost * (usdJpy ?? 150),
              }
            } else {
              mapAmounts[sym] = { native: `¥${Math.round(cost).toLocaleString('en-US')}`, jpy: cost }
            }
          }),
        )
      }
      const errorCode = c.req.query('error') ?? null
      const errorSymbol = c.req.query('symbol') ?? null
      const filter: SymbolsListFilter = {
        status: ((c.req.query('status') ?? 'all') as 'all' | 'active' | 'inactive'),
        market: ((c.req.query('market') ?? 'all') as 'all' | 'US' | 'JP'),
        q: c.req.query('q') ?? '',
      }
      return c.html(
        renderLayout(
          c,
          '銘柄管理',
          symbolsListBody({
            rows,
            inversePairs,
            pairRegimes,
            mapAmounts,
            tradable,
            errorCode,
            errorSymbol,
            filter,
            tab: c.req.query('tab') === 'workflow' ? 'workflow' : 'list',
          }),
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, '銘柄管理', unavailable(messageOf(err))))
    }
  })
  /**
   * 配分マップの編集キャンバス (#symbol-relation-map)。Drawflow で銘柄カードを
   * 並べ、線を引く = 退避先を設定 (entry_required も ON)、線を消す = 解除、
   * カード内の % input = 予算配分の更新。変更は都度 confirm → admin API →
   * reload (canvas 状態と DB の drift を作らない最小実装)。
   */
  .get('/symbols/map', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '配分マップ編集', unavailable('DB not bound')))
    }
    try {
      const rows = await loadAllSymbolConfigRows(c.env.DB)
      const inversePairs = await loadInversePairs(createDb(c.env.DB)).catch(
        () => ({}) as Record<string, string>,
      )
      const pairRegimes = await loadPairRegimeConfigs(createDb(c.env.DB)).catch(() => [])
      // #460: OpenAPI 取扱 allowlist (キャンバスの取扱バッジ用)。
      const tradable = await loadTradableAllowlist(createDb(c.env.DB)).catch(
        () => new Map() as Awaited<ReturnType<typeof loadTradableAllowlist>>,
      )
      const mapAmounts: Record<string, { native: string; jpy: number }> = {}
      if (c.env.SYMBOL_STATE) {
        const stateClient = new SymbolStateClient(c.env.SYMBOL_STATE)
        await Promise.all(
          rows.map(async (r) => {
            const sym = r.symbol.toUpperCase()
            const state = await stateClient.getState(sym).catch(() => null)
            const pos = state?.position
            if (!pos || pos.qty <= 0) return
            const cost = pos.qty * pos.avgPrice
            mapAmounts[sym] = {
              native: r.currency === 'USD' ? `$${cost.toFixed(0)}` : `¥${Math.round(cost).toLocaleString('en-US')}`,
              jpy: cost,
            }
          }),
        )
      }
      return c.html(renderLayout(c, '配分マップ編集', symbolMapEditorBody(rows, inversePairs, mapAmounts, { pairRegimes, tradable })))
    } catch (err) {
      return c.html(renderLayout(c, '配分マップ編集', unavailable(messageOf(err))))
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
      // #460: OpenAPI 取扱 allowlist status (edit は symbol 確定なので server 描画)。
      const tradableStatus = await getTradableStatusForSymbol(createDb(c.env.DB), symbol).catch(
        () => 'unknown' as const,
      )
      return c.html(
        renderLayout(
          c,
          '銘柄管理 - 編集',
          symbolFormBody({ mode: 'edit', row, error: null, globalDefaults, currentInverse, tradableStatus }),
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, '銘柄管理 - 編集', unavailable(messageOf(err))))
    }
  })
  /**
   * 銘柄単位ビューの canonical 短縮 URL (#nav-links)。実体はチャート銘柄タブ
   * (判定 pin / ラダー / fill / 設定リンクを持つ) なので redirect で寄せる。
   * `/symbols/new` / `/symbols/map` / `/symbols/:symbol/edit` より後に定義する
   * こと (Hono は定義順マッチ)。
   */
  .get('/symbols/:symbol', (c) => {
    const symbol = (c.req.param('symbol') ?? '').trim().toUpperCase()
    if (symbol.length === 0) return c.redirect('/dashboard/symbols')
    return c.redirect(`/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(symbol)}`)
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
    const style = inactive ? 'color:#999;background:#f3f3f3' : ''
    const inactiveBadge = inactive
      ? ' <span style="font-size:10px;color:#999">(INACTIVE)</span>'
      : ''
    return `<button type="button" class="bp-chip probe-pickbtn" data-symbol="${esc(sym)}" data-category="${cat}"${style ? ` style="${style}"` : ''} title="${esc(cat)}">${esc(display)}${inactiveBadge}</button>`
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
  // #461 で刷新: raw JSON の縦積み → カード型のサマリ UI。
  //   - 上段: 銘柄選択 (登録銘柄 / 保有 / control) + status + 再 probe
  //   - 判定カード: Webull 取扱 (instrument 照会) / Webull quote / Yahoo quote / 買付余力
  //   - 下段 <details>: drift 比較・raw レスポンス・meta (情報は落とさず格納)
  // データ取得は従来どおり同一 origin の `/admin/broker/probe` を client fetch
  // (Cloudflare Access cookie 流用、payload は no-store)。
  // 自動 probe は URL に symbol+category がある時だけ (PR #250 の方針を維持)。
  const universeLinks = renderUniverseLinks(args.universe)
  // AAPL control chip は universe に AAPL が居る環境では重複するので出さない。
  const hasAapl = [
    ...(args.universe?.allowedSymbols ?? []),
    ...(args.universe?.inactiveSymbols ?? []),
  ].some((sym) => sym.toUpperCase() === 'AAPL')
  const controlChip = hasAapl
    ? ''
    : `<div style="margin-bottom:10px"><button type="button" class="bp-chip probe-pickbtn" data-symbol="AAPL" data-category="US_STOCK">AAPL <span class="muted" style="font-size:10px">control</span></button></div>`
  return `<style>
  .bp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:12px 0}
  .bp-card{background:#fff;border:1px solid #e3e3e8;border-radius:10px;padding:14px 16px}
  .bp-card h3{font-size:13px;margin:0 0 8px;display:flex;align-items:center;gap:8px;justify-content:space-between}
  .bp-card .bp-body{font-size:13px;line-height:1.6}
  .bp-pill{display:inline-block;padding:1px 10px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap}
  .bp-pill-ok{background:#e6f6ec;color:#057a55}
  .bp-pill-ng{background:#fdecec;color:#c22}
  .bp-pill-unknown{background:#eef2f8;color:#46608a}
  .bp-pill-wait{background:#f3f3f5;color:#86868b}
  .bp-chip{padding:4px 12px;font-size:12px;border:1px solid #d8d8de;border-radius:14px;cursor:pointer;background:#fff;margin:0 4px 6px 0}
  .bp-chip:hover{background:#eef4ff;border-color:#06c}
  .bp-chip-selected{background:#06c !important;border-color:#06c !important;color:#fff !important}
  .bp-chip-selected .muted{color:#cfe0ff !important}
  .bp-raw{background:#f6f6f8;border:1px solid #e3e3e8;border-radius:6px;padding:8px;font-size:11px;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-all;margin-top:8px}
  .bp-num{font-variant-numeric:tabular-nums}
  </style>

  <div class="bp-card" style="margin-top:8px">
    <h3>銘柄を選んで診断 <span class="muted" id="probe-status" style="font-weight:normal;font-size:12px">待機中</span>
      <button type="button" id="probe-copy-ai" hidden style="float:right;padding:4px 12px;background:#fff;color:#333;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:12px;font-weight:normal" title="probe 結果全文 (全 raw セクション + meta) をコピー">📋 AI 用コピー</button></h3>
    <div class="bp-body">
      <div style="margin-bottom:6px">${universeLinks}</div>
      ${controlChip}
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px;background:#f6f8fc;border-radius:8px">
        <span style="font-size:13px">選択中: <strong id="probe-current">未選択</strong></span>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="probe-preview-check" checked> 発注前検証も実行 <span class="muted" style="font-size:11px">(発注なし)</span>
        </label>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer" title="SDK の per-symbol 取引照会 (/trade/instrument・/trade/security) が tradePolicy を返すか検証。発注なし read-only (#460)">
          <input type="checkbox" id="probe-tradecheck"> 取扱判定 (trade/instrument) <span class="muted" style="font-size:11px">#460</span>
        </label>
        <button type="button" id="probe-submit" style="padding:7px 22px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">診断を実行</button>
      </div>
    </div>
  </div>

  <div class="bp-grid">
    <div class="bp-card">
      <h3>Webull 取扱 <span id="bp-instrument-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div class="bp-body" id="bp-instrument-body" class="muted">—</div>
    </div>
    <div class="bp-card">
      <h3>Yahoo quote <span id="bp-yahoo-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div class="bp-body" id="bp-yahoo-body" class="muted">—</div>
      <details><summary class="muted" style="font-size:11px;cursor:pointer">raw</summary><pre id="probe-quote-yahoo" class="bp-raw">(未実行)</pre></details>
    </div>
    <div class="bp-card">
      <h3>買付余力 <span id="bp-bp-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div class="bp-body" id="probe-buying-power" class="muted">—</div>
    </div>
  </div>

  <div class="bp-card">
    <h3>保有銘柄 <span class="muted" style="font-size:11px;font-weight:normal">(click で probe)</span></h3>
    <div class="bp-body" id="probe-positions-list" class="muted">未実行</div>
  </div>

  <details style="margin-top:12px">
    <summary class="muted" style="font-size:12px;cursor:pointer">詳細 (drift 比較 / raw レスポンス / meta)</summary>
    <div class="bp-card" style="margin-top:8px">
      <h3>drift 比較 (旧 path vs 新 path) <span class="muted" style="font-size:11px;font-weight:normal">#251</span></h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid #e3e3e8">
          <th style="text-align:left;padding:4px 8px">endpoint</th>
          <th style="text-align:left;padding:4px 8px">old</th>
          <th style="text-align:left;padding:4px 8px">new</th>
        </tr></thead>
        <tbody id="probe-drift-table">
          <tr><td colspan="3" class="muted" style="padding:8px;text-align:center">(未実行)</td></tr>
        </tbody>
      </table>
      <h3 style="margin-top:14px">Webull quote <span class="muted" style="font-size:11px;font-weight:normal">(data-api — 無応答が既知のため詳細に格下げ #461。稼働開始は疎通監視 #21 が通知)</span> <span id="bp-quote-pill" class="bp-pill bp-pill-wait">未実行</span></h3>
      <div id="bp-quote-body" style="font-size:12px;margin:4px 0">—</div>
      <pre id="probe-quote" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">instrument 照会 raw (quotes host / trade host)</h3>
      <pre id="bp-instrument-raw" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">positions / orderHistory raw (旧/新)</h3>
      <pre id="probe-positions-raw" class="bp-raw">(未実行)</pre>
      <pre id="probe-positions-new-raw" class="bp-raw">(未実行)</pre>
      <pre id="probe-order-old-raw" class="bp-raw">(未実行)</pre>
      <pre id="probe-order-new-raw" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">取扱判定 probe <span class="muted" style="font-size:11px;font-weight:normal">(trade/instrument・trade/security tradePolicy — #460、チェック時のみ)</span></h3>
      <pre id="probe-tradecheck-raw" class="bp-raw">(未実行)</pre>
      <h3 style="margin-top:14px">meta</h3>
      <pre id="probe-meta" class="bp-raw">(未実行)</pre>
    </div>
  </details>

<script>
(function () {
  var statusEl = document.getElementById('probe-status');
  var positionsListEl = document.getElementById('probe-positions-list');
  var quoteEl = document.getElementById('probe-quote');
  var metaEl = document.getElementById('probe-meta');
  var rawEl = document.getElementById('probe-positions-raw');
  var currentEl = document.getElementById('probe-current');

  var US_ETF_KNOWN = { SOXL: 1, SOXS: 1, SPY: 1, QQQ: 1 };
  var JP_ETF_KNOWN = { '1570': 1 };
  function inferCategory(symbol) {
    if (/^\\d{4}$/.test(symbol)) {
      return JP_ETF_KNOWN[symbol] ? 'JP_ETF' : 'JP_STOCK';
    }
    return US_ETF_KNOWN[symbol.toUpperCase()] ? 'US_ETF' : 'US_STOCK';
  }

  function setPill(id, kind, text) {
    var el = document.getElementById(id);
    if (!el) return;
    el.className = 'bp-pill bp-pill-' + kind;
    el.textContent = text;
  }

  // XSS 防御 (CodeRabbit #462): innerHTML へ流す動的値 (URL 由来 symbol /
  // broker 応答のフィールド / error 文字列) は必ずこれを通す。
  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // probe 開始時 / fetch 失敗時に全表示領域をニュートラルへ戻す (stale 防止、
  // CodeRabbit #462: pill だけ戻すと失敗時に前回銘柄の結果が残る)。
  function resetProbeView(label) {
    setPill('bp-instrument-pill', 'wait', label);
    setPill('bp-quote-pill', 'wait', label);
    setPill('bp-yahoo-pill', 'wait', label);
    setPill('bp-bp-pill', 'wait', label);
    var ids = ['bp-instrument-body', 'bp-quote-body', 'bp-yahoo-body', 'probe-buying-power', 'probe-positions-list'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.innerHTML = '<span class="muted">...</span>';
    }
    var pres = ['probe-quote', 'probe-quote-yahoo', 'bp-instrument-raw', 'probe-positions-raw', 'probe-positions-new-raw', 'probe-order-old-raw', 'probe-order-new-raw', 'probe-tradecheck-raw', 'probe-meta'];
    for (var j = 0; j < pres.length; j++) {
      var pre = document.getElementById(pres[j]);
      if (pre) pre.textContent = '...';
    }
    var drift = document.getElementById('probe-drift-table');
    if (drift) drift.innerHTML = '<tr><td colspan="3" class="muted" style="padding:8px;text-align:center">...</td></tr>';
    lastProbeResult = null;
    if (copyAiBtn) copyAiBtn.hidden = true;
  }

  // probe 結果の AI 用コピー (#alerts-trades-ui と同運用): UI で省略・整形した
  // 情報ではなく admin endpoint のレスポンス全体 (全 raw セクション + meta) を
  // 文脈ヘッダ付きで積む。スクリーンショット往復だとセクションが切れて
  // どの probe の結果か特定できない問題への対策。
  var lastProbeResult = null;
  var copyAiBtn = document.getElementById('probe-copy-ai');
  if (copyAiBtn) copyAiBtn.addEventListener('click', function () {
    if (!lastProbeResult) return;
    var text = '# webull-trading broker-probe / ' + lastProbeResult.symbol +
      ' (' + lastProbeResult.category + ') / generated ' +
      (lastProbeResult.body && lastProbeResult.body.timestamp ? lastProbeResult.body.timestamp : 'n/a') +
      ' / admin status ' + lastProbeResult.status + '\\n' +
      JSON.stringify(lastProbeResult.body, null, 1);
    function done(ok) {
      copyAiBtn.textContent = ok ? '✅' : '✗';
      setTimeout(function () { copyAiBtn.textContent = '📋 AI 用コピー'; }, 1500);
    }
    function fallbackExecCommand() {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      document.body.removeChild(ta);
      done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallbackExecCommand);
    } else {
      fallbackExecCommand();
    }
  });

  // fetch abort (10s timeout) は raw の英語のまま出すと分かりにくいので日本語化。
  // data-api.webull.co.jp (JP market-data host) の無応答は既知 (#21、Yahoo 移行済み)。
  function humanizeError(section) {
    if (!section) return 'no data';
    if (section.error && /aborted/i.test(section.error)) return '応答なし (10秒 timeout)';
    if (section.error) return section.error;
    if (section.status != null) return 'status=' + section.status;
    return section.phase;
  }

  function parseBody(section) {
    if (!section || typeof section.bodyTruncated !== 'string' || section.bodyTruncated.length === 0) return null;
    try { return JSON.parse(section.bodyTruncated); } catch (_) { return null; }
  }

  function prettify(section) {
    if (!section) return '(no data)';
    var raw = section.bodyTruncated;
    var parsed = parseBody(section);
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

  // #461: instrument 照会の判定カード。quotes / trade 両 host 候補のうち最初に
  // 200 + JSON parse 可能なものを採用する (#415 の balance 候補方式と同じ)。
  function renderInstrumentCard(body, symbol) {
    var bodyEl = document.getElementById('bp-instrument-body');
    var rawTarget = document.getElementById('bp-instrument-raw');
    // JP の正しい path は /openapi/instrument/stock/list (JP docs Trading API >
    // Get Stock Instrument、#461)。host 未確定のため trade / quotes 両方、かつ
    // category 推定の取り違え対策 (CodeRabbit #462) で ETF/STOCK 両 category を
    // 並べる。末尾 2 つは汎用 SDK path の drift 検証用 (#251 方式)。
    var candidates = [
      { label: 'stock/list (trade host, v2)', section: body.instrumentStockTradeV2 },
      { label: 'stock/list (trade host)', section: body.instrumentStockTrade },
      { label: 'stock/list (trade host, alt category)', section: body.instrumentStockTradeAlt },
      { label: 'stock/list (quotes host)', section: body.instrumentStockQuotes },
      { label: 'stock/list (quotes host, alt category)', section: body.instrumentStockQuotesAlt },
      { label: 'instrument/list (quotes host, 汎用 path)', section: body.instrumentQuotesHost },
      { label: 'instrument/list (trade host, 汎用 path)', section: body.instrumentTradeHost },
    ];
    var rawList = candidates;
    if (Array.isArray(body.previewVariants)) {
      rawList = body.previewVariants.map(function (v) {
        return { label: 'preview (' + v.label + ')', section: v.result };
      }).concat(candidates);
    }
    if (rawTarget) {
      rawTarget.textContent = rawList.map(function (cnd) {
        return '--- ' + cnd.label + ' ---\\n' + prettify(cnd.section);
      }).join('\\n\\n');
    }
    if (!bodyEl) return;

    // instrument 照会 (#475): 候補の先頭 (trade host, v2 = 実測で稼働) を優先して
    // symbol 一致行を探し、status (OC/CO/NT) とフラグを全分岐で添える。
    var instMatch = null;
    for (var ci = 0; ci < candidates.length && !instMatch; ci++) {
      var csec = candidates[ci].section;
      if (!csec || csec.phase !== 'response' || csec.status !== 200) continue;
      var cparsed = parseBody(csec);
      var citems = Array.isArray(cparsed) ? cparsed : (cparsed && Array.isArray(cparsed.data) ? cparsed.data : []);
      for (var cj = 0; cj < citems.length; cj++) {
        if (citems[cj] && typeof citems[cj].symbol === 'string' && citems[cj].symbol.toUpperCase() === symbol.toUpperCase()) {
          instMatch = citems[cj];
          break;
        }
      }
    }
    // 公式 MCP の enum: OC=Tradable / CO=Liquidate only / NT=Non-Tradable
    var STATUS_JA = { OC: '取引可', CO: '清算のみ', NT: '取引不可' };
    function instSummaryHtml(it) {
      if (!it) return '';
      var chips = [];
      if (it.status) chips.push('status: ' + escHtml(it.status) + (STATUS_JA[it.status] ? ' (' + STATUS_JA[it.status] + ')' : ''));
      if (it.overnight_trading_supported === true) chips.push('24h取引対応');
      if (it.shortable === true) chips.push('空売り可');
      var lev = Number(it.etf_leveraged_factor);
      if (Number.isFinite(lev) && lev !== 0) chips.push('レバレッジ ' + (lev > 0 ? '+' : '') + lev + 'x' + (it.inverse_etf === true ? ' / インバース' : ''));
      if (it.exchange_code) chips.push('exchange: ' + escHtml(it.exchange_code));
      return '<div class="muted" style="font-size:12px;margin-top:3px">' + chips.join(' ・ ') + '</div>';
    }

    // instrument status が CO/NT なら preview の結果に関わらず NG (#475 server 側
    // checkTradability と同じ判定)。
    if (instMatch && (instMatch.status === 'CO' || instMatch.status === 'NT')) {
      setPill('bp-instrument-pill', 'ng', STATUS_JA[instMatch.status]);
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> の instrument status は <code>' + escHtml(instMatch.status) + '</code> (' + STATUS_JA[instMatch.status] + ') — 新規エントリー不可。' + instSummaryHtml(instMatch);
      return;
    }

    // 発注前検証 (Preview Order) の結果が最優先 — 発注パイプラインそのものの
    // 検証なので instrument 照会より確度が高い (#461)。body shape を複数試して
    // どれか 1 つでも通れば取引可能、どれかが TICKER_IS_DENY なら取扱なし確定。
    if (Array.isArray(body.previewVariants) && body.previewVariants.length > 0) {
      var okVariant = null;
      var denyVariant = null;
      for (var pvi = 0; pvi < body.previewVariants.length; pvi++) {
        var v = body.previewVariants[pvi];
        if (v.result && v.result.phase === 'response' && v.result.status === 200) { okVariant = v; break; }
        if (v.result && v.result.phase === 'response' && typeof v.result.bodyTruncated === 'string' &&
            v.result.bodyTruncated.indexOf('TICKER_IS_DENY') !== -1) { denyVariant = v; }
      }
      // 全 variant が「銘柄不正」PARAM_ERR → マスタに不存在 (ZZZZ 実測パターン)。
      var respondingAll = body.previewVariants.filter(function (v) { return v.result && v.result.status !== null; });
      var allInvalidSymbol = respondingAll.length > 0 && respondingAll.every(function (v) {
        var b = parseBody(v.result);
        return b && typeof b.error_code === 'string' && b.error_code.indexOf('PARAM_ERR') !== -1 &&
          typeof b.message === 'string' && /invalid[^"]*symbol/i.test(b.message);
      });
      if (allInvalidSymbol) {
        setPill('bp-instrument-pill', 'ng', '銘柄不正');
        bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は Webull の銘柄マスタに存在しません (symbol / market の組合せ不正)。';
        return;
      }
      if (okVariant) {
        // preview 200 = 見積もり成功。発注 allowlist は検証されない (USMV は
        // status=OC のまま本番 place が deny された前例) ため「取引可能」とは
        // 表示しない。
        setPill('bp-instrument-pill', 'unknown', instMatch && instMatch.status === 'OC' ? 'OC + 見積もり可' : '見積もり可');
        var okParsed = parseBody(okVariant.result);
        var cost = okParsed && (okParsed.estimated_cost || (okParsed.data && okParsed.data.estimated_cost));
        bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は銘柄として存在し見積もり可' + (cost ? ' (estimated_cost: ' + escHtml(cost) + ')' : '') + '。' +
          '<span class="muted">JP の取扱 deny は発注時のみ検出 — 最終確認は Webull アプリで。</span>' +
          instSummaryHtml(instMatch);
        return;
      }
      if (denyVariant) {
        setPill('bp-instrument-pill', 'ng', '取扱なし (確定)');
        bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> — 発注前検証が <code>TICKER_IS_DENY</code> を返しました。' +
          '<span style="color:#c22">Webull JP の OpenAPI では発注できない銘柄です (確定)。</span>' +
          instSummaryHtml(instMatch);
        return;
      }
      setPill('bp-instrument-pill', 'unknown', '検証エラー');
      var lines = body.previewVariants.map(function (v) {
        var b = parseBody(v.result);
        var detail = b && b.error_code ? b.error_code + (b.message ? ' — ' + b.message : '') : humanizeError(v.result);
        return '<li><code>' + escHtml(v.label) + '</code>: ' + escHtml(detail) + '</li>';
      }).join('');
      bodyEl.innerHTML = '発注前検証がどの body shape でも通りませんでした:' +
        '<ul style="margin:4px 0 0 16px;padding:0;font-size:12px">' + lines + '</ul>' +
        '<span class="muted" style="font-size:11px">エラー内容から shape を調整します — raw を共有してください。</span>';
      return;
    }
    var responded = [];
    for (var i = 0; i < candidates.length; i++) {
      var sct = candidates[i].section;
      if (sct && sct.phase === 'response' && sct.status === 200) {
        var parsed = parseBody(sct);
        if (parsed != null) responded.push({ label: candidates[i].label, data: parsed });
      }
    }
    if (responded.length === 0) {
      var statuses = [candidates[0], candidates[2]].map(function (cnd) {
        return escHtml(cnd.label) + ': ' + escHtml(humanizeError(cnd.section));
      }).join(' ／ ');
      setPill('bp-instrument-pill', 'unknown', '判定不可');
      bodyEl.innerHTML = 'instrument/stock/list が 200 を返しませんでした (' + statuses + ')。' +
        '<span class="muted">判定不可のときの発注可否は実発注の結果 (#460 の自動停止ガード) で確定します。</span>';
      return;
    }
    // どれか 1 候補にでも symbol が出てくれば「銘柄情報あり」(category 非依存)。
    var match = null;
    var matchLabel = '';
    for (var k = 0; k < responded.length; k++) {
      var items = Array.isArray(responded[k].data)
        ? responded[k].data
        : (Array.isArray(responded[k].data.data) ? responded[k].data.data : []);
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it && typeof it.symbol === 'string' && it.symbol.toUpperCase() === symbol.toUpperCase()) {
          match = it;
          matchLabel = responded[k].label;
          break;
        }
      }
      if (match) break;
    }
    if (match) {
      setPill('bp-instrument-pill', 'ok', '銘柄情報あり');
      var fields = [];
      if (match.instrument_id) fields.push('instrument_id: <code>' + escHtml(match.instrument_id) + '</code>');
      if (match.instrument_type) fields.push('type: <code>' + escHtml(match.instrument_type) + '</code>');
      if (match.exchange_code) fields.push('exchange: <code>' + escHtml(match.exchange_code) + '</code>');
      if (match.currency) fields.push('currency: <code>' + escHtml(match.currency) + '</code>');
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は Webull に銘柄として登録されています (via ' + escHtml(matchLabel) + ')。<br>' +
        '<span class="muted" style="font-size:12px">' + (fields.join(' ・ ') || '(詳細フィールドなし)') + '</span>' +
        instSummaryHtml(match);
    } else {
      setPill('bp-instrument-pill', 'ng', '銘柄情報なし');
      bodyEl.innerHTML = '<strong>' + escHtml(symbol.toUpperCase()) + '</strong> は instrument 照会 (ETF/STOCK 両 category) に出てきません。' +
        '<span style="color:#c22">Webull JP の取扱対象外の可能性が高く、発注しても TICKER_IS_DENY で拒否される見込みです。</span>';
    }
  }

  // 価格抽出: parse → (Yahoo chart は meta へ) → 失敗時は truncate 済み body から
  // regex fallback。quote カードと preview の limit cap の両方で使う。
  function extractPrice(section, priceKeys) {
    if (!section) return null;
    var parsed = parseBody(section);
    var item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (item && item.chart && Array.isArray(item.chart.result) && item.chart.result[0] && item.chart.result[0].meta) {
      item = item.chart.result[0].meta;
    }
    for (var i = 0; item && i < priceKeys.length; i++) {
      var v = item[priceKeys[i]];
      if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    if (typeof section.bodyTruncated === 'string') {
      for (var r = 0; r < priceKeys.length; r++) {
        var m = section.bodyTruncated.match(new RegExp('"' + priceKeys[r] + '"\\s*:\\s*(-?[0-9.]+)'));
        if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
      }
    }
    return null;
  }

  // 直近 probe の Yahoo 価格 (preview の limit cap 用)。銘柄が変わったら使わない
  // — 前銘柄の価格で preview すると価格系エラーが deny 判定を潰す (CodeRabbit #466)。
  var lastYahoo = { symbol: null, price: null };

  // quote カード: status pill + 価格らしきフィールドの要約。shape が読めなくても
  // pill と raw は必ず更新する (stale 表示を残さない、CodeRabbit #262 の方針)。
  function renderQuoteCard(pillId, bodyId, section, priceKeys) {
    var ok = section && section.phase === 'response' && section.status === 200;
    setPill(pillId, ok ? 'ok' : (section ? 'ng' : 'unknown'), ok ? '200 OK' : (section ? (section.status != null ? 'status ' + section.status : 'timeout') : 'no data'));
    var bodyEl = document.getElementById(bodyId);
    if (!bodyEl) return;
    if (!ok) {
      bodyEl.innerHTML = '<span class="muted">' + escHtml(humanizeError(section)) + '</span>';
      return;
    }
    var price = extractPrice(section, priceKeys);
    var ms = Number(section.msTaken) || 0;
    bodyEl.innerHTML = price != null
      ? '<span style="font-size:18px;font-weight:700" class="bp-num">' + escHtml(formatNumber(price)) + '</span> <span class="muted" style="font-size:11px">(' + ms + 'ms)</span>'
      : '<span class="muted">200 OK (' + ms + 'ms) — 価格フィールドは raw を確認</span>';
  }

  function renderPositionsList(section) {
    if (!section || section.phase !== 'response' || !section.ok) {
      positionsListEl.innerHTML = '<span class="muted" style="font-size:12px">positions: ' +
        escHtml(humanizeError(section)) + '</span>';
      rawEl.textContent = section ? prettify(section) : '(no data)';
      return;
    }
    rawEl.textContent = prettify(section);
    var items = parseBody(section);
    if (!Array.isArray(items) || items.length === 0) {
      positionsListEl.innerHTML = '<span class="muted" style="font-size:12px">保有銘柄なし</span>';
      return;
    }
    var html = items.map(function (item) {
      // broker 応答由来の値は attribute / innerHTML どちらも必ず escape (#462)。
      var sym = escHtml(item.symbol || '');
      var name = escHtml(item.symbol_name || '');
      var qty = escHtml(formatNumber(item.quantity));
      var cur = escHtml(item.currency || '');
      var mv = escHtml(formatNumber(item.market_value));
      var cost = escHtml(formatNumber(item.cost_price));
      var cat = escHtml(inferCategory(item.symbol || ''));
      return '<button type="button" class="bp-chip probe-pickbtn" data-symbol="' + sym + '" data-category="' + cat +
        '" style="display:block;width:100%;text-align:left;margin:0 0 4px">' +
        '<strong>' + sym + '</strong> ' + (name ? '— ' + name + ' ' : '') +
        '<span class="muted">qty=' + qty + ' cost=' + cost + ' mv=' + cur + ' ' + mv + ' (' + cat + ')</span>' +
        '</button>';
    }).join('');
    positionsListEl.innerHTML = html;
    positionsListEl.querySelectorAll('.probe-pickbtn').forEach(function (btn) {
      btn.addEventListener('click', onPickClick);
    });
  }

  function renderBuyingPower(body) {
    var el = document.getElementById('probe-buying-power');
    if (!el) return;
    var candidates = [
      { label: '/openapi/account/balance (v1)', section: body.balanceAccountV1 },
      { label: '/openapi/assets/balance (v2)', section: body.balanceAssetsV2 },
    ];
    var hit = null;
    for (var i = 0; i < candidates.length; i++) {
      var sct = candidates[i].section;
      if (sct && sct.phase === 'response' && sct.status === 200) {
        var parsed = parseBody(sct);
        if (parsed) { hit = { label: candidates[i].label, body: parsed }; break; }
      }
    }
    if (!hit) {
      setPill('bp-bp-pill', 'ng', 'unavailable');
      el.innerHTML = '<span class="muted">balance endpoint がどれも 200 を返しませんでした。</span>';
      return;
    }
    setPill('bp-bp-pill', 'ok', '取得 OK');
    var b = hit.body;
    var assets = Array.isArray(b.account_currency_assets) ? b.account_currency_assets : [];
    var rows = assets.map(function (a) {
      return '<tr><td style="padding:2px 10px 2px 0"><code>' + escHtml(a.currency || '?') + '</code></td>' +
        '<td style="padding:2px 10px;text-align:right" class="bp-num">' + escHtml(formatNumber(a.buying_power)) + '</td>' +
        '<td style="padding:2px 10px;text-align:right" class="muted bp-num">cash ' + escHtml(formatNumber(a.cash_balance)) + '</td></tr>';
    }).join('');
    el.innerHTML =
      '<table style="font-size:12px;border-collapse:collapse"><tbody>' +
      (rows || '<tr><td class="muted">(通貨別資産なし)</td></tr>') + '</tbody></table>' +
      '<div class="muted" style="font-size:11px;margin-top:4px">via ' + escHtml(hit.label) + ' / 基準通貨 ' + escHtml(b.total_asset_currency || '?') + '</div>';
  }

  function renderDriftTable(body) {
    var tableBody = document.getElementById('probe-drift-table');
    if (!tableBody) return;
    function cell(section) {
      if (!section) return '<td class="muted" style="padding:4px 8px">(no data)</td>';
      var status = section.status == null ? section.phase : 'status=' + section.status;
      var ok = section.ok ? '✅' : (section.ok === false ? '❌' : '');
      var ms = section.msTaken == null ? '' : ' (' + (Number(section.msTaken) || 0) + 'ms)';
      var color = section.ok ? '#0a8a0a' : (section.ok === false ? '#c22' : '#666');
      return '<td style="padding:4px 8px;color:' + color + '">' + ok + ' ' + escHtml(status) + ms + '</td>';
    }
    function row(label, oldSection, newSection) {
      return '<tr><td style="padding:4px 8px"><code>' + label + '</code></td>' +
        cell(oldSection) + cell(newSection) + '</tr>';
    }
    tableBody.innerHTML =
      row('positions', body.positions, body.positionsNew) +
      row('order history', body.orderHistoryOld, body.orderHistoryNew) +
      row('account balance', body.balanceAccountV1, body.balanceAssetsV2) +
      row('instrument (quotes/trade host)', body.instrumentQuotesHost, body.instrumentTradeHost);
  }

  function probe(symbol, category, opts) {
    opts = opts || {};
    statusEl.textContent = (opts.preview ? '診断 + 発注前検証 実行中: ' : '診断 実行中: ') + symbol + ' (' + category + ')';
    currentEl.textContent = '— ' + symbol + ' / ' + category;
    resetProbeView('実行中');
    var url = '/admin/broker/probe?symbol=' + encodeURIComponent(symbol) +
      '&category=' + encodeURIComponent(category);
    if (opts.preview) {
      url += '&preview=1';
      if (Number.isFinite(opts.price) && opts.price > 0) url += '&price=' + encodeURIComponent(opts.price);
    }
    if (opts.tradecheck) url += '&tradecheck=1';
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
        quoteEl.textContent = '--- snapshot (trade host, v2) ---\\n' + prettify(body.snapshotTradeV2) + '\\n\\n--- snapshot (quotes host) ---\\n' + (body.quote ? prettify(body.quote) : '(no data)');
        // trade host + v2 の snapshot (JP docs の production host) が 200 なら優先表示。
        var webullQuote = (body.snapshotTradeV2 && body.snapshotTradeV2.status === 200) ? body.snapshotTradeV2 : (body.quote || null);
        renderQuoteCard('bp-quote-pill', 'bp-quote-body', webullQuote, ['last_price', 'price', 'close', 'last']);
        var quoteYahooEl = document.getElementById('probe-quote-yahoo');
        if (quoteYahooEl) quoteYahooEl.textContent = body.quoteYahoo ? prettify(body.quoteYahoo) : '(no data)';
        renderQuoteCard('bp-yahoo-pill', 'bp-yahoo-body', body.quoteYahoo || null, ['regularMarketPrice', 'price', 'close']);
        lastYahoo = { symbol: symbol, price: extractPrice(body.quoteYahoo || null, ['regularMarketPrice', 'price', 'close']) };
        renderInstrumentCard(body, symbol);
        renderPositionsList(body.positions || null);
        var positionsNewRaw = document.getElementById('probe-positions-new-raw');
        var orderOldRaw = document.getElementById('probe-order-old-raw');
        var orderNewRaw = document.getElementById('probe-order-new-raw');
        if (positionsNewRaw) positionsNewRaw.textContent = prettify(body.positionsNew);
        if (orderOldRaw) orderOldRaw.textContent = prettify(body.orderHistoryOld);
        if (orderNewRaw) orderNewRaw.textContent = prettify(body.orderHistoryNew);
        renderBuyingPower(body);
        renderDriftTable(body);
        var tcEl = document.getElementById('probe-tradecheck-raw');
        if (tcEl) {
          if (body.tradeInstrumentProbe) {
            var tc = body.tradeInstrumentProbe;
            var tcLines = ['instrument_id=' + (tc.instrumentId || '(取得失敗)'), ''];
            (tc.variants || []).forEach(function (vv) {
              var r = vv.result || {};
              tcLines.push('● ' + vv.label + ' -> status=' + r.status + ' ok=' + r.ok);
              if (r.bodyTruncated) tcLines.push('  ' + String(r.bodyTruncated).slice(0, 600));
              if (r.error) tcLines.push('  error=' + r.error);
            });
            tcEl.textContent = tcLines.join('\\n');
          } else {
            tcEl.textContent = '(未実行 — 「取扱判定」チェックで実行)';
          }
        }
        metaEl.textContent = JSON.stringify({
          timestamp: body.timestamp,
          sandbox: body.sandbox,
          input: body.input,
          accessToken: body.accessToken,
          appKey: body.appKey,
          readiness: body.readiness,
          adminStatus: res.status,
        }, null, 2);
        lastProbeResult = { symbol: symbol, category: category, status: res.status, body: body };
        if (copyAiBtn) copyAiBtn.hidden = false;
      })
      .catch(function (e) {
        statusEl.textContent = 'fetch error: ' + (e && e.message ? e.message : String(e));
        // 失敗時も前回 probe の結果を残さない (stale 防止 #462)。
        resetProbeView('失敗');
      })
  }

  // 選択 → 実行の 2 段階フロー (操作要望): chip クリックは**選択のみ** (通信
  // しない)。「診断を実行」で初めて probe + (checkbox ON なら) 発注前検証を走らせる。
  var selected = { symbol: null, category: null };

  function setSelection(sym, cat) {
    selected.symbol = sym;
    selected.category = cat;
    if (currentEl) currentEl.textContent = sym + ' (' + cat + ')';
    document.querySelectorAll('.probe-pickbtn').forEach(function (b) {
      b.classList.toggle('bp-chip-selected', b.getAttribute('data-symbol') === sym);
    });
    try {
      var u = new URL(window.location.href);
      u.searchParams.set('symbol', sym);
      u.searchParams.set('category', cat);
      window.history.replaceState({}, '', u.toString());
    } catch (_) {}
  }

  function onPickClick(ev) {
    var btn = ev.currentTarget;
    var sym = btn.getAttribute('data-symbol');
    var cat = btn.getAttribute('data-category');
    if (sym && cat) setSelection(sym, cat);
  }

  document.querySelectorAll('.probe-pickbtn').forEach(function (btn) {
    btn.addEventListener('click', onPickClick);
  });

  var submitBtn = document.getElementById('probe-submit');
  var previewCheck = document.getElementById('probe-preview-check');
  var tradecheckCheck = document.getElementById('probe-tradecheck');
  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      if (!selected.symbol) {
        statusEl.textContent = '銘柄を選択してください';
        return;
      }
      submitBtn.disabled = true;
      var withPreview = !!(previewCheck && previewCheck.checked);
      var withTradecheck = !!(tradecheckCheck && tradecheckCheck.checked);
      var previewPrice = lastYahoo.symbol === selected.symbol ? lastYahoo.price : null;
      var opts = {};
      if (withPreview) { opts.preview = true; opts.price = previewPrice; }
      if (withTradecheck) opts.tradecheck = true;
      probe(selected.symbol, selected.category, opts).finally(function () {
        submitBtn.disabled = false;
      });
    });
  }

  // URL params は**プリ選択のみ** (自動実行しない — 選択 → 実行の流れを徹底)。
  var qs = new URLSearchParams(window.location.search);
  if (qs.has('symbol') && qs.has('category')) {
    setSelection(qs.get('symbol'), qs.get('category'));
    statusEl.textContent = '「診断を実行」で開始';
  } else {
    statusEl.textContent = '銘柄を選択してください';
  }
})();
</script>`
}

function chartsBody(args: ChartsBodyArgs): string {
  if (args.tab === 'overview') return renderOverviewTab(args)
  if (args.tab === 'quality') return renderQualityTab(args)
  if (args.tab === 'grid') return renderGridTab(args)
  return renderSymbolTab(args)
}

/**
 * チャート銘柄タブ内の判定履歴 (#decisions-chart-unify)。戦略判定ページと同じ
 * renderer を共用し、チャート上の判定 pin と同じデータを表でも読めるようにする
 * (pin はクリックで 1 件ずつ、表はラダー・実 fill・AI コピーまで一覧)。
 */
function renderSymbolDecisionHistory(args: ChartsBodySymbol): string {
  const rows = args.decisionRows ?? []
  if (rows.length === 0 || !args.focusSymbol) return ''
  const symbolCronHref = `/dashboard/cron?symbol=${encodeURIComponent(args.focusSymbol)}`
  return `<div style="margin-top:14px">
    <h2 style="font-size:14px;margin:0 0 6px;display:flex;align-items:center;gap:10px">判定履歴 <span class="muted" style="font-size:11px;font-weight:normal">直近 ${rows.length} 件 — チャートの判定 pin と同じデータ</span>
      <a href="${esc(symbolCronHref)}" style="font-size:11px">この銘柄の全件 →</a>
      <a href="/dashboard/trades?symbol=${encodeURIComponent(args.focusSymbol)}" style="font-size:11px">この銘柄の約定 →</a>
      <a href="/dashboard/cron" style="font-size:11px">全銘柄 →</a>
    </h2>
    ${renderDecisionTable(rows, args.universe, {
      copyVarName: '__decisionCopy',
      showSymbol: false,
      filterLabel: `symbol=${args.focusSymbol}, limit=30`,
    })}
  </div>`
}

/**
 * ペアレジーム行 (#472)。zone を日本語で表示し、score / proxy / 判定日を併記。
 * observe mode はその旨を明示 (gate していないことが分かるように)。
 */
export function renderPairRegimeLine(
  view: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null,
): string {
  if (!view) return ''
  const d = view.decision
  const color =
    d.zone === 'bull' ? '#057a55' : d.zone === 'bear' ? '#b25000' : d.zone === 'neutral' ? '#46608a' : '#c22'
  const sideJa = view.side === 'bull' ? 'ブル側' : 'ベア側'
  const allowed = (view.side === 'bull' && d.zone === 'bull') || (view.side === 'bear' && d.zone === 'bear')
  const verdict = allowed ? 'entry 可' : 'entry 不可'
  return `<div style="margin-top:8px;font-size:13px;color:#3a3a3c;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    ペアレジーム: <strong style="color:${color}">${esc(PAIR_REGIME_ZONE_LABELS[d.zone])}</strong>
    <span class="muted" style="font-size:12px">この銘柄は${sideJa} → ${verdict}${view.mode === 'observe' ? ' (observe: gate は未適用)' : ''}</span>
    <span class="muted" style="font-size:12px">${d.score !== null ? `score ${(d.score * 100).toFixed(2)}%` : ''} proxy ${esc(d.proxySymbol)}${d.asOfDate ? ` / ${esc(d.asOfDate)} 時点` : ''}</span>
    ${d.zone === 'unknown' ? `<span class="err" style="font-size:12px">${esc(d.reason)}</span>` : ''}
  </div>`
}

export function renderSymbolTab(args: ChartsBodySymbol): string {
  const noData =
    args.symbolChart === null ||
    args.symbolChart.points.length === 0
  if (noData) {
    return wrapWithSymbolRail(
      args,
      renderFocusSymbolHeader(args) +
        `<p class="muted">この銘柄にはまだ判定ログ / fill がありません。</p>` +
        renderStrategyParamsPanel(args.strategyParams, args.strategyParamsGlobal),
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
      // 「どこから新セッションか」が分かりにくくなった。15m interval なので
      // 隣接 bar は通常 15 分差。週末 / 夜間 closed 後の最初の bar は数時間〜
      // 数十時間ぶんの差が空く。閾値 90 分で safe に検出し、後ろ側
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

      // 押し目ゾーン端までの距離ラベル (#entry-distance): 「入場ライン」独立線は
      // 廃止し、既存の上端/下端点線に「あと −X.X% ($Y)」を付与する。現価格は
      // latestCronPrice (直近 strategy 評価値) 基準。過熱/トレンド等で実際に入場
      // できない件は下の「入場まで」パネルが説明する (ここは純粋な価格距離)。
      function bandEdgeLabel(name, edgeY) {
        if (!Number.isFinite(edgeY) || sc.latestCronPrice == null || !(sc.latestCronPrice > 0)) return name;
        var mv = (edgeY - sc.latestCronPrice) / sc.latestCronPrice;
        return name + ' あと ' + (mv >= 0 ? '+' : '') + (mv * 100).toFixed(1) + '% ($' + edgeY.toFixed(2) + ')';
      }
      var pullbackUpperLabel = bandEdgeLabel('押し目上端', bandUpperY);
      var pullbackLowerLabel = bandEdgeLabel('押し目下端', bandLowerY);

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
      // 具体的には intradayBars (15m candle、60 日で ~1500 点) の各 timestamp
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
      // fill 時刻を最近接 ohlc bar (= 15m 粒度) の index に snap するため、同 bar
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

      // 判定点 (#decision-trace のグラフ同期): cron の判定イベント (HOLD を除く
      // BUY/SELL/SKIP/REJECT/ERROR) を eval 時刻 × eval 価格に色分けでプロットする。
      // 点クリックで脇パネルに判定トレース・ラダー (server 事前レンダリング HTML)
      // を出し、文字ログとグラフを 1 画面で同期させる。category mode では eval
      // 時刻を最近接 ohlc index に snap (markPoint と同じ手法、xForTimestamp 流用)。
      // 色は取引品質タブの DECISION_COLORS と揃える。
      var DECISION_COLORS = { BUY: '#057a55', SELL: '#1471a8', SKIP: '#b25000', REJECT: '#7c3aed', ERROR: '#c22' };
      var DECISION_LABEL_JA = { BUY: '買い', SELL: '売り', SKIP: '見送り (bot判定)', REJECT: '拒否 (証券会社)', ERROR: 'エラー (原因不明・一時的)' };
      function escHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      var decisionList = sc.decisions || [];
      var decisionPoints = decisionList.map(function (d) {
        var color = DECISION_COLORS[d.decision] || '#888';
        return {
          value: [xForTimestamp(d.timestamp), d.price],
          decision: d.decision, reason: d.reason, evalTs: d.timestamp, ladderHtml: d.ladderHtml,
          itemStyle: { color: color, borderColor: '#fff', borderWidth: 1 },
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

      // 参考 価格外挿線 (#entry-distance のグラフ表現): 直近ペースを未来へ延ばした
      // 点線。category 軸に未来スロットを足して描く。**予測ではなく外挿** なので
      // 点線 + "参考" 明記。entryPrice が無い (価格非依存ブロック) 局面は server 側で
      // projection=null になり描かれない。time 軸 fallback は POC では描画しない。
      var projLineXY = null;
      var projCrossPoint = null;
      var projZoomEndIndex = null;
      var projEndPrice = null;
      (function () {
        var proj = data.projection;
        if (!proj || !Number.isFinite(proj.lastPrice) || !Number.isFinite(proj.slopePerStep)) return;
        if (!useCategoryAxis || ohlcMs.length < 2) return;
        var dayMs = 24 * 3600 * 1000;
        var lastBarMs = ohlcMs[ohlcMs.length - 1];
        // 1 営業日あたりの bar 本数を直近 1 日のスロット数で近似。
        var barsPerDay = 0;
        for (var bi = ohlcMs.length - 1; bi >= 0; bi -= 1) {
          if (lastBarMs - ohlcMs[bi] <= dayMs) barsPerDay += 1; else break;
        }
        barsPerDay = Math.max(1, barsPerDay);
        // 未来スロットの timestamp 間隔 (直近 bar の平均間隔)。
        var span = barsPerDay > 1 ? (lastBarMs - ohlcMs[ohlcMs.length - barsPerDay]) / (barsPerDay - 1) : 3600000;
        if (!Number.isFinite(span) || span <= 0) span = 3600000;
        // 描く未来 bar 数: 交差あり (= 入場時期の目安が見える) はその近辺まで
        // 1〜5 営業日に clamp。交差なしは向き (傾き) が読めれば十分なので
        // 半営業日分の bar だけ — 未来スロットは axis を占有して履歴側の candle
        // を左に圧縮するため、最小限に保つ (operator 指摘 ×2)。
        var drawBars;
        if (proj.crossingSteps != null) {
          var drawDays = Math.min(Math.max(Math.ceil(proj.crossingSteps), 1), 5);
          drawBars = Math.max(barsPerDay, Math.round(drawDays * barsPerDay));
        } else {
          drawBars = Math.max(2, Math.ceil(barsPerDay / 2));
        }
        var startIdx = categories.length - 1;
        for (var k = 1; k <= drawBars; k += 1) {
          categories.push(new Date(lastBarMs + k * span).toISOString());
        }
        var endIdx = startIdx + drawBars;
        projEndPrice = proj.lastPrice + proj.slopePerStep * (drawBars / barsPerDay);
        projLineXY = [[startIdx, proj.lastPrice], [endIdx, projEndPrice]];
        extraYValues.push(proj.lastPrice, projEndPrice);
        if (proj.entryPrice != null) extraYValues.push(proj.entryPrice);
        // 交差点 marker (描画範囲内のときだけ pin を出す)。
        if (proj.crossingSteps != null && proj.entryPrice != null) {
          var crossBars = Math.round(proj.crossingSteps * barsPerDay);
          if (crossBars >= 0 && crossBars <= drawBars) {
            projCrossPoint = { coord: [startIdx + crossBars, proj.entryPrice], value: proj.entryPrice };
          }
        }
        projZoomEndIndex = endIdx;
      })();

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
      pushIfFinite(data.prevClose); // 前日終値 markLine が枠外に出ないように
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
      // 外挿線を初期表示に収める: category mode で右端 (endValue) を外挿末尾まで
      // 広げる (未来スロットを足したぶん)。startValue は据え置きなので履歴 + 外挿が
      // 同時に見える。
      if (projZoomEndIndex != null && useCategoryAxis && dzInitial.endValue != null) {
        dzInitial.endValue = Math.min(projZoomEndIndex, categories.length - 1);
      }
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
      // 下部 slider と wheel/pinch zoom は廃止 (Google Finance 風 — range 操作は
      // 1日/5日/1か月/最大 のピルのみ。operator 要望)。inside dataZoom は
      // ピルの dispatchAction / URL 同期の受け皿として残すが、マウス・タッチ
      // 操作は全て無効化する (sticky チャート上で page scroll を奪わない効果も)。
      var dataZoomCfg = [
        Object.assign({
          type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter',
          zoomOnMouseWheel: false, moveOnMouseMove: false, moveOnMouseWheel: false,
          zoomLock: false,
        }, dzInitial),
      ];

      var symChart = echarts.init(document.getElementById('symbol-chart'));
      // chart title は出さない: 銘柄は左レールの強調で、表示要素は凡例で分かる。
      symChart.setOption({
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
        // candle が映える背景に (trader-strategist 助言)。下部 slider 廃止に伴い
        // bottom は x軸ラベル分 (28px) のみ。
        // right は stop/TP の endLabel ("stop X (preview)" 等) が見切れないよう
        // 80px 確保 (短い "stop X (-Y%)" でも余白として違和感ない範囲)。
        grid: { left: 50, right: 20, top: 56, bottom: 28, containLabel: true },
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
              // 入場まで距離を右端ラベルに (旧「入場ライン」線の代替)。
              endLabel: { show: true, formatter: pullbackUpperLabel, color: '#b25000', fontSize: 10 },
            },
            {
              name: '押し目下端',
              type: 'line', data: pullbackLowerXY,
              connectNulls: false,
              lineStyle: { width: 1, color: 'rgba(255, 140, 0, 0.55)', type: 'dashed' },
              itemStyle: { color: 'rgba(255, 140, 0, 0.55)' },
              symbol: 'none', z: 2,
              endLabel: { show: true, formatter: pullbackLowerLabel, color: '#b25000', fontSize: 10 },
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
          // candle: 主役。日本式配色 (Google Finance JA と同じ):
          // 赤 = 陽線 (close >= open) / 緑 = 陰線 (close < open)。
          // markPoint / markLine もここに anchor。barWidth 明示で overnight
          // gap 後の細い candle を視認可能に。borderWidth 強めて
          // body と wick の対比を確保。
          ...(ohlcXY.length > 0 ? [{
            name: 'price (15m OHLC)', type: 'candlestick', data: ohlcXY,
            // barWidth は auto (slot 幅比例)。15m 化で本数が 4 倍になったため、
            // 固定 px だと zoom out 時に candle が重なる。
            itemStyle: {
              color: '#d23f31',     // 陽線 (close >= open) — 日本式は赤
              color0: '#1e8e3e',    // 陰線 (close < open) — 日本式は緑
              borderColor: '#d23f31',
              borderColor0: '#1e8e3e',
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
            markLine: (function () {
              var mlData = sessionOpenIndices.map(function (idx) {
                return { xAxis: idx };
              });
              // 前日終値の水平点線 + 右端ラベル (Google Finance 風)。candle series
              // の markLine に同居させる (独立 series にすると legend を汚すため)。
              if (data.prevClose != null && Number.isFinite(data.prevClose)) {
                mlData.push({
                  yAxis: data.prevClose,
                  lineStyle: { color: '#9aa0a6', width: 1, type: 'dotted' },
                  label: {
                    show: true,
                    position: 'insideEndTop',
                    formatter: data.prevCloseLabel || '前日終値',
                    color: '#5f6368',
                    fontSize: 10,
                  },
                });
              }
              if (mlData.length === 0) return undefined;
              return {
                symbol: 'none',
                silent: true,
                label: { show: false },
                lineStyle: { color: '#bbb', width: 1, type: 'dashed' },
                z: 1,
                data: mlData,
              };
            })(),
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
          // 入場ライン (#entry-distance): 今 BUY が成立する最寄り価格。cyan 実線 +
          // endLabel で「入場ライン $Y (−X.X%)」。現価格との差がチャート上の縦の
          // 隙間として直感的に読める。z:9 で価格線群より前面、判定点 (z:11) より背面。
          // 参考 価格外挿線: 直近ペースの未来延長 (点線)。予測ではない (legend / 注記)。
          // 交差点 (= 入場ライン到達) には pin を立てる。
          ...(projLineXY ? [{
            name: '参考 価格外挿 (予測ではない)', type: 'line', data: projLineXY,
            lineStyle: { width: 1.4, color: '#0891b2', type: 'dotted', opacity: 0.85 }, symbol: 'none',
            itemStyle: { color: '#0891b2' },
            silent: true, emphasis: { disabled: true }, z: 8,
            markPoint: projCrossPoint ? {
              symbol: 'pin', symbolSize: 30,
              data: [{
                coord: projCrossPoint.coord, value: projCrossPoint.value,
                itemStyle: { color: '#0891b2' },
                label: { show: true, formatter: '参考\\n到達', color: '#fff', fontSize: 9, lineHeight: 11 },
              }],
            } : undefined,
          }] : []),
          // 判定点 scatter: cron 判定イベントを価格チャートに重ねる。z を最前面に
          // 寄せて (candle z:5 / 線 z:6-8 より上) クリック可能にする。REJECT/ERROR
          // (= broker 拒否 / 失敗) は少し大きくして目立たせる。SKIP (bot 内部
          // ゲート見送り) は定常運転に近いので通常サイズ。
          // tooltip は item trigger で decision + reason 要約 (詳細は click→ラダー)。
          ...(decisionPoints.length > 0 ? [{
            name: '判定', type: 'scatter', data: decisionPoints,
            symbol: 'circle',
            symbolSize: function (val, p) {
              var dec = p && p.data ? p.data.decision : '';
              return (dec === 'REJECT' || dec === 'ERROR') ? 13 : 9;
            },
            z: 11, emphasis: { scale: 1.6 }, cursor: 'pointer',
            tooltip: {
              trigger: 'item',
              formatter: function (p) {
                var d = p.data;
                var ja = DECISION_LABEL_JA[d.decision] || d.decision;
                var price = Array.isArray(d.value) ? Number(d.value[1]).toFixed(2) : '';
                var rsn = d.reason ? '<div style="font-size:11px;max-width:280px;white-space:normal">' + escHtml(d.reason) + '</div>' : '';
                return '<div style="font-weight:600">' + escHtml(ja) + ' (' + escHtml(d.decision) + ') @ ' + price + '</div>'
                  + '<div style="font-size:11px">' + jstLabelSec(d.evalTs) + '</div>'
                  + rsn
                  + '<div style="font-size:10px;color:#888;margin-top:2px">クリックで判定トレース表示</div>';
              },
            },
          }] : []),
        ],
      });
      window.addEventListener('resize', function () { symChart.resize(); });

      // 判定点クリック → 脇パネルにその判定の判定トレース・ラダーを表示する
      // (文字ログ↔グラフ同期の肝)。ladderHtml は server 側で renderDecisionLadder
      // により事前レンダリング済み (全値 esc 済みの自前 markup) なので innerHTML
      // へ挿すだけ。JS 側にラダー描画ロジックを複製しない。
      var tracePanel = document.getElementById('decision-trace-panel');
      function showDecisionTrace(d) {
        if (!tracePanel || !d) return;
        tracePanel.innerHTML = d.ladderHtml || '';
      }
      symChart.on('click', function (p) {
        if (p && p.seriesName === '判定' && p.data && p.data.ladderHtml != null) {
          showDecisionTrace(p.data);
          if (tracePanel) tracePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      // 初期表示: 最新の判定点のトレースを開いておく。操作前から log↔graph が
      // 結びついた状態 (= 直近に何が起きたか) を一目で見せる。
      if (decisionPoints.length > 0) showDecisionTrace(decisionPoints[decisionPoints.length - 1]);

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
        // visible 範囲内の SMA50 は「candle range の近傍にある時だけ」含める。
        // #181 では SMA50 常時可視を優先したが、乖離が大きい銘柄 (3x ETF rally
        // 等: SMA50=125 / 価格=260) では軸が倍近く引き伸ばされ、candle の
        // 高値-安値が読めなくなる (operator 指摘で方針転換)。近傍 = candle
        // range を上下 25% 拡張した帯。帯の外の SMA50 線は clip されるが、値は
        // 価格ヘッダーのサブ行 (SMA50: X) で常に確認できる。
        var candleMin = visibleY.length ? Math.min.apply(null, visibleY) : null;
        var candleMax = visibleY.length ? Math.max.apply(null, visibleY) : null;
        sc.points.forEach(function (p) {
          if (!inRangeMs(new Date(p.timestamp).getTime())) return;
          var v = p.sma50;
          if (v == null || !Number.isFinite(v)) return;
          if (candleMin == null) { visibleY.push(v); return; }
          var nearBand = Math.max((candleMax - candleMin) * 0.25, 0.5);
          if (v >= candleMin - nearBand && v <= candleMax + nearBand) visibleY.push(v);
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
        // 押し目ゾーン上端 (= 入場まで距離ラベルを載せた線) を y 範囲に含めて
        // ラベルが枠外に切れないようにする。下端は広がりすぎ防止のため含めない。
        if (Number.isFinite(bandUpperY)) pushIfFinite(bandUpperY);
        // 参考 価格外挿線の末尾価格も含める (未来スロットに描くので zoom 右端で visible)。
        if (projEndPrice != null) pushIfFinite(projEndPrice);
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
          // Google 風ピルの active 付替 (押した range を強調)
          for (var pj = 0; pj < presetButtons.length; pj += 1) presetButtons[pj].classList.remove('active');
          ev.currentTarget.classList.add('active');
          // dataZoom は inside 1 つだけ (slider 廃止)
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
        });
      }
    });
  `
  // chart payload に displayName を注入。client 側の chart title / tooltip header
  // は `sc.displayName || sc.symbol` で読む (US 銘柄は displayName === symbol)。
  // evalIndicators は buyability を server で算出済みなので client へは送らない
  // (入場までの距離は押し目ゾーン端ラベル / 外挿線で表現)。
  const symbolChartPayload = args.symbolChart
    ? (({ evalIndicators: _omit, ...rest }) => ({
        ...rest,
        displayName: displaySymbol(args.symbolChart!.symbol, args.universe),
      }))(args.symbolChart)
    : null
  // 参考 価格外挿線 (#entry-distance のグラフ表現)。直近ペースを未来へ延ばした
  // 「予測ではない外挿」。client は category 軸に未来スロットを足して描く。
  const projection = args.buyability?.projection ?? null
  // 前日終値 (header の前日比とチャート点線の共通基準)。
  const prevClose = prevDailyClose(args.symbolChart)
  const prevCloseLabel =
    prevClose !== null
      ? `前日終値 ${fmtPriceCcy(prevClose, args.universe?.symbolCurrency[args.symbolChart!.symbol.toUpperCase()] ?? null)}`
      : null
  const content = `<div class="symbol-chart-pin">
  ${renderFocusSymbolHeader(args)}
  ${renderPriceHeader(args.symbolChart, args.universe)}
  <div id="symbol-chart" style="width:100%;height:380px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:8px"></div>
  ${renderZoomPresetButtons(args.symbolChart)}
  </div>
  ${renderSymbolPolicyLine(args.focusSymbol, args.symbolPolicy ?? null)}
  ${renderPairRegimeLine(args.pairRegime ?? null)}
  ${renderBuyabilityPanel(args.buyability ?? null, {
    entryStatus: args.entryStatus ?? null,
    currency: args.focusSymbol ? currencyOfSymbol(args.focusSymbol) : null,
  })}
  ${renderDecisionPlotCaption(args.symbolChart)}
  <div id="decision-trace-panel" class="reason-panel" style="margin-top:10px">
    <p class="muted" style="font-size:12px;margin:0">判定点 (●) をクリックすると、その判定が通った採用ロジックのトレースがここに表示されます。</p>
  </div>
  ${renderSymbolDecisionHistory(args)}
  ${renderStrategyParamsPanel(args.strategyParams, args.strategyParamsGlobal)}`
  return `${wrapWithSymbolRail(args, content)}
  ${safeJsonScript('__chartData', {
    symbolChart: symbolChartPayload,
    projection,
    prevClose,
    prevCloseLabel,
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
 * - candle (15m OHLC)
 * - 価格トレンド (linear regression)
 * - SMA50
 * - 押し目ゾーン markArea + sloped 上下端線 (未保有時のみ)
 * - 保有時の avg / stop / TP 水平線 + endLabel
 * - 未保有時の preview stop / TP 点線 + endLabel
 * - BUY/SELL pin (markPoint, hover で qty / PnL / fill 時刻 tooltip)
 * - session divider (vertical lines)
 */
/** 段階判定 badge の配色 (#452 PR 2)。 */
const ENTRY_STATUS_BADGE: Record<EntryStatus, { label: string; bg: string; fg: string }> = {
  ENTRY: { label: 'ENTRY', bg: '#e6f6ec', fg: '#057a55' },
  HALF: { label: 'HALF 0.5x', bg: '#fff4e6', fg: '#b25000' },
  WATCH: { label: 'WATCH', bg: '#eef2f8', fg: '#46608a' },
  NG: { label: 'NG', bg: '#fdecec', fg: '#c22' },
}

function entryStatusBadgeHtml(status: EntryStatus): string {
  const b = ENTRY_STATUS_BADGE[status]
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:${b.bg};color:${b.fg};font-weight:700;font-size:11px" title="段階判定 (#452): 発注対象は ENTRY / HALF のみ">${b.label}</span>`
}

/**
 * Grid panel の表示優先度ソート (#452 PR 2)。
 * ENTRY > HALF > WATCH > NG > cash_parking > 判定不能 (データ無し) > inactive。
 * 同順位内は元の並び (pair 隣接など) を保つ stable sort。
 */
export function sortGridChartsByEntryPriority<T extends { symbol: string }>(
  charts: T[],
  entryStatuses: Record<string, EntryStatus>,
  universe: SymbolUniverse,
): T[] {
  const inactive = new Set(universe.inactiveSymbols)
  const priority = (symbol: string): number => {
    if (inactive.has(symbol)) return 6
    if (universe.symbolRole[symbol] === 'cash_parking') return 4
    const status = entryStatuses[symbol]
    if (status === 'ENTRY') return 0
    if (status === 'HALF') return 1
    if (status === 'WATCH') return 2
    if (status === 'NG') return 3
    return 5 // 判定不能 (chart/eval データ無し)
  }
  return charts
    .map((entry, idx) => ({ entry, idx }))
    .sort((a, b) => priority(a.entry.symbol) - priority(b.entry.symbol) || a.idx - b.idx)
    .map(({ entry }) => entry)
}

/**
 * target / active weight の並記 (#452 Layer 3)。target を持つ (or 退避を受けた)
 * 銘柄のみ 1 行出す。「設定上 5% だが現在は SGOV に退避中」を panel 上で見せる。
 */
export function renderAllocationLine(alloc: SymbolAllocation | undefined): string {
  if (!alloc) return ''
  const pct = (w: number) => `${Math.round(w * 1000) / 10}%`
  const changed = Math.abs(alloc.activeWeight - alloc.targetWeight) > 1e-9
  const color = alloc.activeWeight === 0 ? '#b25000' : changed ? '#057a55' : '#86868b'
  const arrow = changed ? ` → <strong>${pct(alloc.activeWeight)}</strong>` : ''
  const reroute = alloc.rerouteTo ? `（${esc(alloc.rerouteTo)} へ退避中）` : ''
  const rerouted = alloc.reroutedInWeight > 0 ? `（+${pct(alloc.reroutedInWeight)} 退避受入）` : ''
  return `<div style="font-size:11px;color:${color};margin-bottom:4px" title="${esc(alloc.reason)}">配分 target ${pct(alloc.targetWeight)}${arrow}${reroute}${rerouted}</div>`
}

/**
 * 個別銘柄タブのロール / 配分ポリシー行 (#452)。role も配分も未設定なら出さない
 * (従来挙動の銘柄でノイズにしない)。設定変更は編集フォームへのリンクで誘導。
 */
export function renderSymbolPolicyLine(
  symbol: string | null,
  policy: SymbolPolicySummary | null,
): string {
  if (!symbol || !policy) return ''
  const hasAny =
    policy.role !== null ||
    policy.targetWeight !== null ||
    policy.entryRequired ||
    policy.alwaysActive ||
    policy.cashFallbackSymbols !== null
  if (!hasAny) return ''
  const parts: string[] = []
  if (policy.role !== null) {
    const known = (SYMBOL_ROLES as readonly string[]).includes(policy.role)
    parts.push(
      known
        ? `ロール: <code style="font-size:12px" title="${esc(SYMBOL_ROLE_LABELS[policy.role as SymbolRole])}">${esc(policy.role)}</code>: <strong>${esc(SYMBOL_ROLE_LABELS_SHORT[policy.role as SymbolRole])}</strong>`
        : `ロール: <span class="err" title="不正な role 値 — entry は抑止されます (fail-closed)">⚠ ${esc(policy.role)}</span>`,
    )
  }
  if (policy.targetWeight !== null) {
    parts.push(`配分 target ${Math.round(policy.targetWeight * 1000) / 10}%`)
  }
  if (policy.alwaysActive) parts.push('<span title="判定に関わらず常時 target = active">常時配分</span>')
  if (policy.entryRequired) parts.push('<span title="entry 判定 (ENTRY/HALF) 通過時のみ実配分有効">条件連動</span>')
  if (policy.cashFallbackSymbols !== null) {
    parts.push(
      `退避先 ${policy.cashFallbackSymbols.map((fb) => `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(fb)}">${esc(fb)}</a>`).join(' / ')}`,
    )
  }
  return `<div style="margin-top:8px;font-size:13px;color:#3a3a3c;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    ${parts.join('<span style="color:#d0d0d5">｜</span>')}
    <a href="/dashboard/symbols/${encodeURIComponent(symbol)}/edit" style="font-size:12px">設定変更</a>
  </div>`
}

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
      // 段階判定 badge (#452 PR 2)。inactive 銘柄は cron 評価対象外なので出さない。
      const status = args.entryStatuses?.[entry.symbol]
      const statusBadge = status !== undefined && !inactive ? entryStatusBadgeHtml(status) : ''
      const allocationLine = inactive
        ? ''
        : renderAllocationLine(args.allocations?.[entry.symbol])
      const rightSide = (inactive ? inactiveBadge : '') + statusBadge + positionBadge + badge
      return `<div class="${panelClass}"${dataAttrs} style="${baseStyle}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px">
          ${headerLink}
          <div style="display:flex;gap:6px;align-items:center">${rightSide}</div>
        </div>
        ${allocationLine}
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
    charts: args.charts.map((c) => {
      // grid の mini chart は判定点 / 入場距離を描かないので、ラダー HTML を持つ
      // decisions と evalIndicators は payload から落としてサイズを抑える
      // (どちらも個別銘柄タブ専用)。
      const lean = c.chart
        ? (({ decisions: _omitD, evalIndicators: _omitE, ...rest }) => rest)(c.chart)
        : null
      return {
        symbol: c.symbol,
        chart: lean ? { ...lean, displayName: displaySymbol(c.chart!.symbol, args.universe) } : null,
        error: c.error,
        displayName: displaySymbol(c.symbol, args.universe),
      }
    }),
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
              // barWidth は auto (15m 化で本数 4 倍、固定 px だと mini panel で潰れる)
              // 日本式配色: 赤=陽線 / 緑=陰線 (個別銘柄タブと揃える)
              itemStyle: {
                color: '#d23f31', color0: '#1e8e3e',
                borderColor: '#d23f31', borderColor0: '#1e8e3e', borderWidth: 1,
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
  maxSma50DeviationPct: 0.6,
  maxAtrRatio: 1.5,
}

/**
 * チャート併置の戦略パラメータパネル (#168)。チャート上のラベル
 * (押し目 ×N、stop -4% 等) はオーバーレイ 4 本制限のため限定的なので、
 * 補助情報として全パラメータを一覧表示。default からの変更を ⚠ で強調し
 * 「設定の意図しない残存」(例: pullback_max=0 のデバッグ残骸) に運用者が
 * 気づきやすくする。
 */
export function renderStrategyParamsPanel(
  p: StrategyParamsSnapshot,
  globalParams?: StrategyParamsSnapshot,
): string {
  const flag = (current: number | boolean, def: number | boolean): string =>
    current === def ? '' : ' <span class="warn" title="default 値から変更">⚠</span>'
  // effective 値が global と異なる = role preset / 銘柄管理の override 由来。
  // 「銘柄管理で設定した値ではなく global が出ている」と誤読されないよう、
  // 出どころを行内で明示する (operator 指摘)。
  const symbolTag = (key: keyof StrategyParamsSnapshot): string =>
    globalParams !== undefined && p[key] !== globalParams[key]
      ? ' <span style="font-size:10px;padding:1px 5px;border-radius:8px;background:#e8f0fe;color:#1a56db" title="role preset / 銘柄別 override 由来 (global と異なる)">銘柄別</span>'
      : ''
  const pct = (n: number): string =>
    (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
  const rows: Array<{ label: string; key: keyof StrategyParamsSnapshot; current: string; def: string; flag: string }> = [
    {
      label: '損切ライン (stopPct)',
      key: 'stopPct',
      current: pct(p.stopPct),
      def: pct(STRATEGY_DEFAULTS.stopPct),
      flag: flag(p.stopPct, STRATEGY_DEFAULTS.stopPct),
    },
    {
      label: '利食ライン (takeProfitPct)',
      key: 'takeProfitPct',
      current: pct(p.takeProfitPct),
      def: pct(STRATEGY_DEFAULTS.takeProfitPct),
      flag: flag(p.takeProfitPct, STRATEGY_DEFAULTS.takeProfitPct),
    },
    {
      label: '時間切れ (timeStopDays)',
      key: 'timeStopDays',
      current: `${p.timeStopDays} 営業日`,
      def: `${STRATEGY_DEFAULTS.timeStopDays} 営業日`,
      flag: flag(p.timeStopDays, STRATEGY_DEFAULTS.timeStopDays),
    },
    {
      label: '押し目 上限 (pullbackMax)',
      key: 'pullbackMax',
      current: pct(p.pullbackMax),
      def: pct(STRATEGY_DEFAULTS.pullbackMax),
      flag: flag(p.pullbackMax, STRATEGY_DEFAULTS.pullbackMax),
    },
    {
      label: '押し目 下限 (pullbackMin)',
      key: 'pullbackMin',
      current: pct(p.pullbackMin),
      def: pct(STRATEGY_DEFAULTS.pullbackMin),
      flag: flag(p.pullbackMin, STRATEGY_DEFAULTS.pullbackMin),
    },
    {
      // lookback の実体は 20 営業日 (#318)。field 名は global_config 列との互換で
      // minReturn50d のまま、人間向け文言だけ 20 日に揃える。
      label: '20日騰落率 閾値 (minReturn50d)',
      key: 'minReturn50d',
      current: pct(p.minReturn50d),
      def: pct(STRATEGY_DEFAULTS.minReturn50d),
      flag: flag(p.minReturn50d, STRATEGY_DEFAULTS.minReturn50d),
    },
    {
      label: 'SMA50 上 必須 (requireAboveSma50)',
      key: 'requireAboveSma50',
      current: p.requireAboveSma50 ? 'true' : 'false',
      def: STRATEGY_DEFAULTS.requireAboveSma50 ? 'true' : 'false',
      flag: flag(p.requireAboveSma50, STRATEGY_DEFAULTS.requireAboveSma50),
    },
    {
      label: 'ATR 倍率 (kAtr、サイジング用)',
      key: 'kAtr',
      current: p.kAtr.toFixed(2),
      def: STRATEGY_DEFAULTS.kAtr.toFixed(2),
      flag: flag(p.kAtr, STRATEGY_DEFAULTS.kAtr),
    },
  ]
  const tbody = rows
    .map(
      (r) =>
        `<tr><th>${esc(r.label)}</th><td>${esc(r.current)}${r.flag}${symbolTag(r.key)}</td><td class="muted">${esc(r.def)}</td></tr>`,
    )
    .join('')
  return `<details open style="margin-top:12px">
    <summary style="cursor:pointer;font-size:13px">戦略パラメータ (PullbackUptrendStrategy${globalParams !== undefined ? ' — この銘柄に適用される値' : ''}) — <span class="muted">⚠ は default から変更されている項目</span></summary>
    <table style="margin-top:8px">
      <thead><tr><th>項目</th><th>現在値</th><th>default</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">
      「銘柄別」タグは role preset / 銘柄管理の override 由来 (設定は 銘柄管理 → 編集)。
      global の変更は 設定ページ (pullback_default_*)。
    </p>
  </details>`
}

/**
 * チャート上に「現在の主要 indicator (price / SMA50 / high20d / low20d / atr20)」
 * を inline badge で表示。trader-strategist 助言で SMA50 を chart line から
 * 撤去 (15m chart の y軸を引き伸ばさないため) した代替表示。最新の cron-eval
 * point から取得し、null は em-dash (—) で fallback。
 */
const JST_MD_FMT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
})

/**
 * 入場ゲートを「<左辺名> <実測> <記号> [<閾値名>] <閾値>」で整形 (#entry-distance /
 * #trace-readability)。左の値が何の数字かを名前で明示する。価格系は通貨記号 ($/¥)
 * 付き (currency 未指定なら $)。
 */
function fmtGateValue(g: EntryGateStatus, currency: string | null = null): string {
  const sym = ({ '>': '>', '>=': '≥', '<': '<', '<=': '≤' } as Record<string, string>)[g.operator] ?? g.operator
  const price = (v: number): string => fmtPriceCcy(v, currency)
  switch (g.key) {
    case 'trend':
      return `20日騰落率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'overextension':
      return `移動平均乖離率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'pullback_shallow':
    case 'pullback_deep':
      return `押し目率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'above_sma50':
      return `株価 ${price(g.actual)} ${sym} SMA50 ${price(g.threshold)}`
    case 'volatility':
      return `ATR倍率 ${g.actual.toFixed(2)}× ${sym} ${g.threshold.toFixed(2)}×`
    case 'high20d_valid':
      return `直近高値 ${price(g.actual)} ${sym} ${price(g.threshold)}`
  }
}

/**
 * 「入場まで あとどれくらい / いつ頃」パネル (#entry-distance)。
 * - 結論 (buyable / 価格であと X% / 価格では不可+ボトルネック)
 * - 距離の推移 (mini bar、縮小/拡大トレンド)
 * - 参考 ETA (外挿・非予測の注記つき)
 * - 全ゲートの現在値 vs 閾値チェックリスト
 * buyability / current が無ければ空文字。
 */
export interface BuyabilityPanelContext {
  /** 段階判定 (#452 PR 2)。null = 出さない。 */
  entryStatus?: EntryStatusResult | null
  /** 価格表示の通貨 ($/¥)。未指定なら $。 */
  currency?: string | null
}

export function renderBuyabilityPanel(
  buyability: BuyabilityView | null,
  ctx: BuyabilityPanelContext = {},
): string {
  if (!buyability || !buyability.current) return ''
  const cur = buyability.current
  const status = ctx.entryStatus ?? null
  const ccy = ctx.currency ?? null

  // --- 結論 ---
  let headline: string
  let headColor: string
  if (cur.buyable) {
    headline =
      '現在 入場条件を充足（cron 評価では BUY 候補。実発注は資金 / 単元など発注側ゲート次第）'
    headColor = '#057a55'
  } else if (cur.entryPrice !== null && cur.priceMove !== null) {
    const dir = cur.priceMove < 0 ? '下落' : '上昇'
    const binding = cur.bindingGate ? ` ／ ボトルネック: ${esc(cur.bindingGate.labelJa)}` : ''
    headline = `入場まで: あと 価格 <strong>${fmtPctSigned(cur.priceMove)}</strong>（${fmtPriceCcy(cur.entryPrice, ccy)} 到達 = ${dir}）${binding}`
    headColor = '#b25000'
  } else {
    const g = cur.bindingGate
    const why = g
      ? g.priceDependent
        ? '押し目ゾーンと過熱上限が同時に成立しない局面です。'
        : 'この指標が条件を満たすまでは、価格がどこでも入場しません。'
      : ''
    headline = g
      ? `価格を動かすだけでは入場不可 — ボトルネック: <strong>${esc(g.labelJa)}</strong>（${esc(fmtGateValue(g, ccy))} 不成立）。${why}`
      : '入場条件 評価不可'
    headColor = '#c22'
  }

  // --- 距離の推移 (mini bars) ---
  const movePts = buyability.series.filter(
    (p): p is typeof p & { priceMove: number } => p.priceMove !== null,
  )
  const recent = movePts.slice(-8)
  let trendBlock = ''
  if (recent.length > 0) {
    const maxGap = Math.max(...recent.map((p) => Math.abs(p.priceMove)), 1e-9)
    const bars = recent
      .map((p, i) => {
        const gap = Math.abs(p.priceMove)
        const w = Math.max(2, Math.round((gap / maxGap) * 90))
        const last = i === recent.length - 1
        const color = last ? headColor : '#c9c9cf'
        const md = JST_MD_FMT.format(new Date(p.timestamp))
        return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.5">
          <span style="width:34px;color:#86868b;text-align:right">${esc(md)}</span>
          <span style="display:inline-block;height:8px;width:${w}px;background:${color};border-radius:2px"></span>
          <span style="font-variant-numeric:tabular-nums">${fmtPctSigned(p.priceMove)}</span>
        </div>`
      })
      .join('')
    const trendLabel =
      buyability.trend === 'closing'
        ? '<span style="color:#057a55">縮小中（入場に近づいている）</span>'
        : buyability.trend === 'widening'
          ? '<span style="color:#b25000">拡大中（入場から遠ざかっている）</span>'
          : buyability.trend === 'flat'
            ? '<span class="muted">横ばい</span>'
            : '<span class="muted">判定不能</span>'
    trendBlock = `<div style="margin-top:8px"><strong>距離の推移</strong>(入場までの価格距離)：${trendLabel}
      <div style="margin-top:4px">${bars}</div></div>`
  } else {
    trendBlock = `<div style="margin-top:8px" class="muted">距離の推移: 価格距離が算出できる評価日がありません（価格非依存ゲートが要因）。</div>`
  }

  // --- 参考 ETA ---
  let etaBlock = ''
  if (buyability.etaTradingDays !== null && buyability.trend === 'closing') {
    const days = Math.max(1, Math.ceil(buyability.etaTradingDays))
    etaBlock = `<div style="margin-top:8px"><strong>参考 ETA</strong>: このペースが続けば 約 ${days} 営業日
      <div class="muted" style="font-size:11px">⚠ 外挿の参考値・予測ではない（相場が逆行すれば遠のく / 押し目バンドも日々動く）</div></div>`
  }

  // --- ゲートチェックリスト ---
  const gateRows = cur.gates
    .map((g) => {
      const ok = g.passed
      const binding = cur.bindingGate?.key === g.key
      const mark = ok ? '✅' : '❌'
      const bg = ok ? '#f1f8f4' : '#fdf0f0'
      const border = binding ? 'border-left:3px solid #c22;' : 'border-left:3px solid transparent;'
      const tag = binding ? ' <span style="color:#c22;font-weight:600">◀ ボトルネック</span>' : ''
      return `<div style="display:flex;align-items:baseline;gap:8px;padding:3px 8px;background:${bg};${border}border-radius:4px;font-size:12px;flex-wrap:wrap">
        <span>${mark}</span><span>${esc(g.labelJa)}</span>
        <span style="color:#555;font-variant-numeric:tabular-nums">${esc(fmtGateValue(g, ccy))}</span>${tag}
      </div>`
    })
    .join('')

  // --- 段階判定 badge + HALF 説明 (#452 PR 2) ---
  const statusBadge = status ? entryStatusBadgeHtml(status.status) : ''
  let halfNote = ''
  if (status?.status === 'HALF' && status.halfGate) {
    halfNote = `<div style="margin-top:6px;font-size:12px;color:#b25000">HALF: 未通過は「${esc(status.halfGate.labelJa)}」のみで閾値の許容バンド内 → 0.5x サイジングで entry 候補 (role が entry 有効な銘柄のみ発注対象)。</div>`
  }

  // 距離の推移 (+ETA) と 入場ゲート は 2 列 (narrow 画面は .panel-row の
  // media query で 1 列に落ちる)。
  return `<div class="reason-panel" style="margin-top:10px;max-width:1000px">
    <div style="font-size:13px;color:${headColor};margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${statusBadge}<span>${headline}</span></div>
    ${halfNote}
    <div class="panel-row" style="gap:8px 20px">
      <div>${trendBlock}${etaBlock}</div>
      <div style="margin-top:8px"><strong>入場ゲート</strong>(全条件。閾値は global 既定 + role preset + 銘柄 override、#452)
        <div style="margin-top:4px;display:flex;flex-direction:column;gap:3px">${gateRows}</div>
      </div>
    </div>
  </div>`
}

/**
 * 判定点プロットの凡例 + 件数キャプション (#decision-trace のグラフ同期)。
 * decisions が空なら空文字。最新 `MAX_CHART_DECISIONS` 件に達していれば
 * truncation を明示する (silent cap を避ける)。色は chart 側 DECISION_COLORS
 * および取引品質タブと揃える。
 */
export function renderDecisionPlotCaption(chart: SymbolChartData | null): string {
  const decisions = chart?.decisions ?? []
  if (decisions.length === 0) return ''
  const dot = (color: string, label: string): string =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span style="width:9px;height:9px;border-radius:50%;background:${color};box-shadow:0 0 0 1px #fff,0 0 0 2px ${color}"></span>${esc(label)}</span>`
  const capped =
    decisions.length >= MAX_CHART_DECISIONS
      ? ` <span class="muted">(直近 ${MAX_CHART_DECISIONS} 件まで表示)</span>`
      : ''
  return `<p class="muted" style="font-size:12px;margin:6px 0 2px">
    ● は cron の判定イベント。点をクリックすると下に判定トレースが出ます (文字ログとグラフを同期)。HOLD (保有継続 / 様子見) は省略。${capped}
  </p>
  <div style="font-size:12px;margin:0 0 4px">
    ${dot('#057a55', '買い (BUY)')}${dot('#1471a8', '売り (SELL)')}${dot('#b25000', '見送り・bot判定 (SKIP)')}${dot('#7c3aed', '拒否・証券会社 (REJECT)')}${dot('#c22', 'エラー (ERROR)')}
  </div>`
}

/**
 * 前日終値 (= 最終 daily point の 1 つ前の price)。比較・markLine 共用。
 * points が 2 点未満 / 非有限なら null。
 */
export function prevDailyClose(chart: SymbolChartData | null): number | null {
  const pts = chart?.points ?? []
  if (pts.length < 2) return null
  const v = pts[pts.length - 2]!.price
  return Number.isFinite(v) ? v : null
}

/**
 * Google Finance 風の価格ヘッダー: 大きい現在値 + 前日比 (%/絶対値)。
 * 日本式配色 (上昇=赤 / 下落=緑)。下段に SMA50 / high20d / low20d の小バッジ。
 * 現在値は latestCronPrice (直近 strategy 評価値)、無ければ最終 point の price。
 */
export function renderPriceHeader(
  chart: SymbolChartData | null,
  universe?: SymbolUniverse | null,
): string {
  if (!chart || chart.points.length === 0) return ''
  const last = chart.points[chart.points.length - 1]!
  const cur = chart.latestCronPrice ?? last.price
  if (!Number.isFinite(cur)) return ''
  const ccy = universe?.symbolCurrency[chart.symbol.toUpperCase()] ?? null
  const prev = prevDailyClose(chart)
  let changeHtml = ''
  if (prev !== null && prev > 0) {
    const diff = cur - prev
    const pct = (diff / prev) * 100
    const up = diff >= 0
    // 日本式: 上昇=赤 / 下落=緑 (Google Finance JA と同じ)
    const color = up ? '#d23f31' : '#188038'
    const arrow = up ? '▲' : '▼'
    const sign = up ? '+' : ''
    changeHtml = ` <span style="font-size:14px;font-weight:600;color:${color};margin-left:6px">${arrow} ${sign}${pct.toFixed(2)}% (${sign}${diff.toFixed(2)}) 前日比</span>`
  }
  // 最新の indicator 付き point (Yahoo filler は indicators null)
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  const subItems: Array<[string, string]> = latest
    ? [
        ['SMA50', fmt(latest.sma50)],
        ['high20d', fmt(latest.high20d)],
        ['low20d', fmt(latest.low20d)],
      ]
    : []
  const sub = subItems
    .map(
      ([k, v]) =>
        `<span style="display:inline-block;margin-right:10px;font-size:12px"><span class="muted">${esc(k)}:</span> <strong>${esc(v)}</strong></span>`,
    )
    .join('')
  return `<div style="margin:2px 0 0">
    <span style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${esc(fmtPriceCcy(cur, ccy))}</span>${changeHtml}
  </div>
  ${sub ? `<p style="margin:2px 0 0">${sub}</p>` : ''}`
}

/**
 * 個別銘柄タブの銘柄レール (左固定)。旧 inline picker (「切替: <長い名前の列挙>」)
 * は full name の link が折り返して読みづらかったため、ticker + 小さい銘柄名の
 * 縦リストに変更。zoom 範囲は従来通り URL で伝搬する。
 */
function renderSymbolRail(args: ChartsBodySymbol): string {
  if (args.availableSymbols.length === 0) return ''
  // 銘柄切替時にズーム範囲を維持するため、現在の from/to をレール URL に伝搬
  const zoomQs = args.zoom
    ? `&from=${encodeURIComponent(args.zoom.from.toISOString())}&to=${encodeURIComponent(args.zoom.to.toISOString())}`
    : ''
  const items = args.availableSymbols
    .map((s) => {
      const inactive = isSymbolInactive(s, args.universe)
      const isFocus = s === args.focusSymbol
      const name = args.universe?.symbolName[s.toUpperCase()] ?? ''
      const cls = ['rail-item', isFocus ? 'active' : '', inactive ? 'inactive' : '']
        .filter(Boolean)
        .join(' ')
      const titleAttr = inactive
        ? ` title="${esc(inactiveTooltip(s, args.universe))}"`
        : name
          ? ` title="${esc(name)}"`
          : ''
      return `<a class="${cls}" href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(s)}${zoomQs}"${titleAttr}>
        <span class="rail-sym">${esc(s)}</span>${name ? `<span class="rail-name">${esc(name)}</span>` : ''}
      </a>`
    })
    .join('')
  return `<aside class="symbol-rail"><div class="rail-head">銘柄</div>${items}</aside>`
}

/** レール + 本文の 2 カラム。レールが空 (銘柄ゼロ) なら本文のみ。 */
function wrapWithSymbolRail(args: ChartsBodySymbol, content: string): string {
  const rail = renderSymbolRail(args)
  if (!rail) return content
  return `<div class="symbol-layout">${rail}<div class="symbol-main">${content}</div></div>`
}

/**
 * 表示中銘柄の見出し行。active 銘柄では出さない (左レールの強調表示で自明)。
 * inactive 銘柄の時だけ、注記 (cron 評価対象外) 付きで出す。
 */
function renderFocusSymbolHeader(args: ChartsBodySymbol): string {
  const focusInactive = args.focusSymbol
    ? isSymbolInactive(args.focusSymbol, args.universe)
    : false
  if (!args.focusSymbol || !focusInactive) return ''
  const focusLabel = displaySymbol(args.focusSymbol, args.universe)
  const note = args.universe?.symbolNotes[args.focusSymbol.toUpperCase()] ?? 'cron 評価対象外'
  return `<p class="muted" style="font-size:12px;margin:0 0 4px">銘柄: <strong>${esc(focusLabel)}</strong> <span class="muted" style="font-size:11px">(inactive — ${esc(note)})</span></p>`
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

const ROLE_NODE_COLORS: Record<string, string> = {
  cash_parking: '#5b8c5a',
  core_trend: '#1a56db',
  leveraged_trend: '#d97706',
  low_volatility: '#7e3af2',
  sector_trend: '#0e9f9f',
  inverse_hedge: '#c22d2d',
}

/**
 * 配分マップキャンバス (#symbol-relation-map)。描画単位は **unit (対 = 1 カード、
 * 単独銘柄 = 1 カード)** — 対を 2 カード + 連動パッチ (ミラー線・連動移動・
 * 共有側ポート非表示) で表現していた旧方式は edit/view で不整合が漏れ続けた
 * ため、operator の指定で一塊に再設計した。
 *
 *   - ペアカード: `SOXL ⇄ SOXS`。両側の状態を 1 枚に表示、配分は対で 1 枠
 *   - 口座 → unit = 配分 1 本 (1/枝)。unit → unit = 退避 1 本 (緑破線) で、
 *     適用時に**側別に展開** (対→対は role で側合わせ、対→単独は両側→同一先)
 *   - 単独 → 対の退避は側を特定できないため不可 (理由付き拒否)
 *   - 'view' はノード移動のみ可 (編集系は封印)、'edit' は draft + 適用
 * DB / API は従来の銘柄単位のまま — 展開はこのキャンバスの適用時のみ。
 */
export function symbolMapEditorBody(
  rows: SymbolConfigRow[],
  inversePairs: Record<string, string>,
  amounts: Record<string, { native: string; jpy: number }>,
  opts: { mode?: 'edit' | 'view'; pairRegimes?: PairRegimeEntry[]; tradable?: TradableAllowlist } = {},
): string {
  const mode = opts.mode ?? 'edit'
  const pairRegimes = opts.pairRegimes ?? []
  const tradable: TradableAllowlist = opts.tradable ?? new Map()
  // unit の取扱 status = メンバー中で最も重い状態 (unknown > disappeared > tradable)。
  // ペアで片側が取扱不可なら警告を出す。
  const tradeRank: Record<TradableStatus, number> = { tradable: 0, disappeared: 1, unknown: 2 }
  const unitTradeBadge = (syms: string[]): string => {
    let worst: TradableStatus = 'tradable'
    for (const x of syms) {
      const s = tradable.get(x.toUpperCase())?.status ?? 'unknown'
      if (tradeRank[s] > tradeRank[worst]) worst = s
    }
    return tradableBadgeHtml(worst)
  }
  const bySym = new Map(rows.map((r) => [r.symbol.toUpperCase(), r]))
  const pctOf = (r: SymbolConfigRow): number =>
    r.budgetAllocPct != null ? Math.round(r.budgetAllocPct * 1000) / 10 : 0

  // unit 構築: 対 (両方登録済み) は 1 unit。並びは leveraged 側を先頭に。
  interface Unit {
    id: string
    syms: string[]
    label: string
    currency: string
    color: string
    roles: Record<string, string | null>
    pct: number
    active: boolean
    held: Record<string, string>
    entryRequired: boolean
    fallbackSyms: Record<string, string[]>
    y: number
  }
  const units: Unit[] = []
  const unitOfSym: Record<string, string> = {}
  const usedSyms = new Set<string>()
  for (const r of rows) {
    const sym = r.symbol.toUpperCase()
    if (usedSyms.has(sym)) continue
    const partnerSym = inversePairs[sym]?.toUpperCase()
    const partner = partnerSym !== undefined ? bySym.get(partnerSym) : undefined
    let syms = [sym]
    if (partner !== undefined) {
      usedSyms.add(partnerSym!)
      syms = [sym, partnerSym!]
      // leveraged (bull) 側を先頭に揃える (側合わせの基準)。
      syms.sort((a, b) => {
        const ra = bySym.get(a)?.role === 'leveraged_trend' ? 0 : 1
        const rb = bySym.get(b)?.role === 'leveraged_trend' ? 0 : 1
        return ra - rb || a.localeCompare(b)
      })
    }
    usedSyms.add(sym)
    const members = syms.map((x) => bySym.get(x)!)
    const unit: Unit = {
      id: syms.join('/'),
      syms,
      label: syms.join(' ⇄ '),
      currency: r.currency,
      color: ROLE_NODE_COLORS[members[0]!.role ?? ''] ?? '#5f6368',
      roles: Object.fromEntries(syms.map((x) => [x, bySym.get(x)?.role ?? null])),
      pct: Math.max(...members.map(pctOf)),
      active: members.some((m) => m.active),
      held: Object.fromEntries(
        syms.filter((x) => amounts[x] !== undefined).map((x) => [x, amounts[x]!.native]),
      ),
      entryRequired: members.some((m) => m.entryRequired === true),
      fallbackSyms: Object.fromEntries(
        syms.map((x) => [x, parseCashFallbacksJson(bySym.get(x)?.cashFallbackSymbols, x)]),
      ),
      y: 0,
    }
    for (const x of syms) unitOfSym[x] = unit.id
    units.push(unit)
  }
  const onCanvas = units.filter((u) => u.active)
  if (onCanvas.length === 0) {
    return `<p class="muted">有効な銘柄がありません。</p>`
  }
  // unit の退避先 (unit 単位、#496 多分岐): 各側の fallback リストが指す unit
  // 群の和集合。側ごとの食い違い (旧データの片側欠け等) は適用で側別に正規化
  // される。
  const fallbackUnitsOf = (u: Unit): string[] => {
    const targets = u.syms
      .flatMap((x) => u.fallbackSyms[x] ?? [])
      .map((x) => unitOfSym[x] ?? null)
      .filter((x): x is string => x !== null)
    return [...new Set(targets)]
  }
  // JPY 群 → USD 群で縦に並べる。
  let yCursor = 30
  for (const ccy of ['JPY', 'USD']) {
    for (const u of onCanvas.filter((x) => x.currency === ccy)) {
      u.y = yCursor
      yCursor += 130
    }
  }
  const payload = {
    mode,
    units: onCanvas.map((u) => ({
      id: u.id,
      syms: u.syms,
      label: u.label,
      currency: u.currency,
      color: u.color,
      roles: u.roles,
      pct: u.pct,
      held: u.held,
      entryRequired: u.entryRequired,
      fallbacks: fallbackUnitsOf(u),
      // #460: OpenAPI 取扱バッジ HTML (tradable は空文字)。card に innerHTML 挿入。
      tradeBadge: unitTradeBadge(u.syms),
      y: u.y,
    })),
    // スポーン在庫: 盤面に無い (= 全側 inactive) unit。
    inventory: units
      .filter((u) => !u.active)
      .map((u) => ({
        id: u.id,
        syms: u.syms,
        label: u.label,
        currency: u.currency,
        color: u.color,
        roles: u.roles,
        tradeBadge: unitTradeBadge(u.syms),
      })),
    unitOfSym,
  }

  // 脚注チップ: regime proxy (盤面の unit に関係するもののみ)。misconfig は警告。
  const activeSyms = new Set(onCanvas.flatMap((u) => u.syms))
  const chips: string[] = []
  for (const pair of pairRegimes) {
    const members = [pair.proxySymbol, pair.bullSymbol, pair.bearSymbol].map((x) => x.toUpperCase())
    if (!members.some((x) => activeSyms.has(x))) continue
    if (pair.invalidConfig !== null) {
      chips.push(`<span style="padding:2px 8px;border-radius:10px;background:#fff4e5;color:#9a5b00;font-size:11px">⚠ regime misconfig ${esc(pair.bullSymbol.toUpperCase())}/${esc(pair.bearSymbol.toUpperCase())}: ${esc(pair.invalidConfig)} (zone=unknown で両側 BUY 停止中)</span>`)
      continue
    }
    chips.push(`<span style="padding:2px 8px;border-radius:10px;background:#f1ebfd;color:#7e3af2;font-size:11px">regime proxy ${esc(pair.proxySymbol.toUpperCase())} → ${esc(pair.bullSymbol.toUpperCase())}/${esc(pair.bearSymbol.toUpperCase())}</span>`)
  }
  const chipRow = chips.length > 0
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${chips.join('')}</div>`
    : ''
  const legend = `塗り: <span style="background:#5f6368;border:1px solid #3c4043;color:#fff;padding:0 6px;border-radius:4px">口座</span>
      <span style="background:#fdf3f2;border:1px solid #d4a09a;padding:0 6px;border-radius:4px">JPY</span>
      <span style="background:#f0f6ff;border:1px solid #9ab8dd;padding:0 6px;border-radius:4px">USD</span>
      <span style="color:#8a8f98">実線 = 配分</span>
      <span style="color:#0e9f6e">緑破線 = 退避</span>`
  const helpText = [
    '口座 → カードの線 = 配分 (1/枝 均等。対は 1 カード = 1 枠)',
    'カード → カードの線 = 退避先 (緑破線)。対→対は適用時に側別へ展開 (bull→bull / bear→bear)',
    '単独銘柄 → 対への退避は側を特定できないため不可',
    '線の削除 = 線を選択 → Backspace / Delete',
    '線を空中で放す = 既存 Inactive を呼び出して紐づけ (適用で有効化)',
    '口座から到達できないカードは適用時に無効化 (保有中は除く)',
    '変更は「適用」までは保存されない',
  ].join('\n')
  const header = mode === 'edit'
    ? `<p style="margin:0 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols" style="font-size:13px">← 銘柄管理</a>
    <button type="button" id="sm-simulate" style="padding:4px 12px;background:#fff;border:1px solid #06c;color:#06c;border-radius:6px;cursor:pointer;font-size:12px">シミュレート</button>
    <button type="button" id="sm-delete-conn" disabled style="padding:4px 12px;background:#fff;border:1px solid #ccc;color:#999;border-radius:6px;cursor:pointer;font-size:12px">選択中の線を削除</button>
    <span title="${esc(helpText)}" style="cursor:help;color:#9aa0a6;font-size:14px;border:1px solid #d0d0d5;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center">?</span>
    <span class="muted" style="font-size:12px">${legend}</span>
  </p>
  <div id="sm-changes-bar" hidden style="position:sticky;top:0;z-index:10;display:flex;gap:10px;align-items:flex-start;padding:8px 12px;background:#fff8e6;border:1px solid #e6c46a;border-radius:8px;margin-bottom:8px">
    <div style="flex:1;min-width:0">
      <strong style="font-size:12px">未適用の変更</strong>
      <ul id="sm-changes-list" style="margin:4px 0 0 16px;padding:0;font-size:12px"></ul>
    </div>
    <button type="button" id="sm-apply" style="padding:6px 18px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">適用</button>
    <button type="button" id="sm-reset" style="padding:6px 12px;background:#fff;border:1px solid #ccc;border-radius:6px;cursor:pointer;font-size:13px">リセット</button>
  </div>`
    : `<p class="muted" style="margin:0 0 6px;font-size:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols/map">✏️ 編集モード</a>
    <button type="button" id="sm-simulate" style="padding:3px 10px;background:#fff;border:1px solid #06c;color:#06c;border-radius:6px;cursor:pointer;font-size:12px">シミュレート</button>
    <span title="${esc(helpText)}" style="cursor:help;color:#9aa0a6;font-size:13px;border:1px solid #d0d0d5;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center">?</span>
    <span>${legend}</span>
  </p>`
  const canvasHeight = mode === 'edit'
    ? 'height:calc(100vh - 150px);min-height:520px'
    : `height:${Math.max(300, yCursor + 60)}px`
  return `${header}
  <div id="sm-sim-meta" hidden style="display:flex;gap:10px;align-items:center;margin:0 0 6px;padding:6px 10px;background:#eafaf1;border:1px solid #0e9f6e;border-radius:8px;font-size:12px">
    <strong style="color:#0e9f6e">シミュレーション表示中</strong>
    <span id="sm-sim-meta-text" class="muted" style="flex:1;min-width:0"></span>
    <button type="button" id="sm-sim-clear" style="padding:2px 10px;background:#fff;border:1px solid #0e9f6e;color:#0e9f6e;border-radius:6px;cursor:pointer;font-size:12px">クリア</button>
  </div>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/drawflow@0.0.60/dist/drawflow.min.css">
  <style>
  #symbol-map-editor{${canvasHeight};background:#fafafa;border:1px solid #d0d0d5;border-radius:8px}
  #symbol-map-editor .drawflow .drawflow-node{background:#fff;border:2px solid #d0d0d5;border-radius:10px;padding:0;width:210px;box-shadow:0 1px 4px rgba(0,0,0,0.08)}
  #symbol-map-editor .drawflow .drawflow-node.selected{border-color:#06c}
  #symbol-map-editor .drawflow .drawflow-node.sm-dirty{border-color:#e6a23c;box-shadow:0 0 0 3px rgba(230,162,60,0.25)}
  #symbol-map-editor .drawflow .drawflow-node.sm-account{background:#5f6368;border-color:#3c4043}
  #symbol-map-editor .drawflow .drawflow-node.sm-jpy{background:#fdf3f2;border-color:#d4a09a}
  #symbol-map-editor .drawflow .drawflow-node.sm-usd{background:#f0f6ff;border-color:#9ab8dd}
  #symbol-map-editor .drawflow .drawflow-node .input,
  #symbol-map-editor .drawflow .drawflow-node .output{background:#9aa0a6;border:2px solid #6e6e73;width:14px;height:14px}
  #symbol-map-editor .drawflow .drawflow-node .input:hover,
  #symbol-map-editor .drawflow .drawflow-node .output:hover{background:#6e6e73}
  #symbol-map-editor.sm-view .drawflow .drawflow-node .input,
  #symbol-map-editor.sm-view .drawflow .drawflow-node .output{pointer-events:none}
  /* 退避線は保存済みでも緑破線 (配分の実線と常に区別がつくように)。 */
  #symbol-map-editor svg.connection.sm-fallback path{stroke:#0e9f6e !important;stroke-dasharray:7 5;stroke-width:2.5px}
  #symbol-map-editor svg.connection.sm-pending path{stroke-width:3.5px !important}
  .sm-card{padding:8px 10px;font-size:12px}
  .sm-card .sm-title{font-size:14px;font-weight:700}
  .sm-card .sm-status-active{color:#0e9f6e;font-size:11px}
  .sm-card .sm-status-pending{color:#b25000;font-size:11px}
  .sm-card .sm-meta{color:#6e6e73;font-size:10px;margin-top:2px}
  .sm-card .sm-share{font-weight:600}
  /* シミュレーション結果はカードの「外」に浮かせる (#496 follow-up): フロー内に
     置くとカードが伸び、Drawflow が線の端点を再計算しないため点と線がズレる。
     absolute overlay なら几何が一切変わらない。 */
  #symbol-map-editor .drawflow .drawflow-node{overflow:visible}
  .sm-sim-wrap{position:absolute;top:calc(100% + 4px);left:2px;right:2px;z-index:6;display:flex;flex-direction:column;gap:3px;pointer-events:none}
  .sm-sim{padding:3px 6px;border-radius:6px;font-size:10px;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,0.18)}
  .sm-sim.sm-sim-active{background:#eafaf1;color:#0b6e4f}
  .sm-sim.sm-sim-reroute{background:#fff4e5;color:#9a5b00}
  .sm-sim.sm-sim-recv{background:#eafaf1;color:#0b6e4f;border:1px dashed #0e9f6e}
  #symbol-map-editor svg.connection.sm-sim-flow path{stroke:#0e9f6e !important;stroke-width:4px;stroke-dasharray:10 6;animation:smflow 1.2s linear infinite}
  #symbol-map-editor svg.connection.sm-sim-dim path{opacity:0.25}
  @keyframes smflow{to{stroke-dashoffset:-32}}
  </style>
  <div id="symbol-map-editor"></div>
  ${chipRow}
  ${safeJsonScript('__symbolMapEditor', payload)}
  <script src="https://cdn.jsdelivr.net/npm/drawflow@0.0.60/dist/drawflow.min.js"></script>
  <script>
  document.addEventListener('DOMContentLoaded', function () {
    var data = window.__symbolMapEditor;
    var el = document.getElementById('symbol-map-editor');
    if (!data || !el || typeof Drawflow === 'undefined') return;
    var isView = data.mode === 'view';
    var editor = new Drawflow(el);
    editor.reroute = false;
    editor.start();
    if (isView) el.classList.add('sm-view');

    // 盤面レイアウトの記憶 (#496 follow-up): ノード位置とパン/ズームを
    // localStorage に保存する (origin 単位・管理画面のみなのでティッカーと座標が
    // 残る程度は許容、operator 合意)。view/edit でキーを共有して同じ配置に。
    var LAYOUT_KEY = 'webull-sm-map-layout-v1';
    var savedLayout = {};
    try {
      savedLayout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {};
    } catch (e) { savedLayout = {}; }
    var savedPos = savedLayout.pos || {};
    function persistLayout() {
      try {
        var pos = {};
        Object.keys(idOf).forEach(function (uid) {
          var d2 = editor.drawflow.drawflow[editor.module].data[idOf[uid]];
          if (d2) pos[uid] = { x: d2.pos_x, y: d2.pos_y };
        });
        Object.keys(accountIds).forEach(function (ccy) {
          var d2 = editor.drawflow.drawflow[editor.module].data[accountIds[ccy]];
          if (d2) pos['__account_' + ccy + '__'] = { x: d2.pos_x, y: d2.pos_y };
        });
        localStorage.setItem(LAYOUT_KEY, JSON.stringify({
          pos: pos,
          zoom: editor.zoom,
          canvasX: editor.canvas_x,
          canvasY: editor.canvas_y,
        }));
      } catch (e) { /* private mode 等は黙って諦める (表示専用機能) */ }
    }

    var idOf = {};      // unitId -> drawflow node id
    var unitOf = {};    // drawflow node id -> unitId
    var unitBy = {};    // unitId -> unit payload
    var baseline = {};  // unitId -> { pct, fallback, active }
    var draft = {};     // unitId -> { connected, fallback }
    var programmatic = false;

    var currencies = [];
    data.units.forEach(function (u) { if (currencies.indexOf(u.currency) === -1) currencies.push(u.currency); });
    currencies.sort();
    var accountIds = {};
    var accountCcyOf = {};
    var nJpy = data.units.filter(function (u) { return u.currency === 'JPY'; }).length;
    currencies.forEach(function (ccy) {
      var label = ccy === 'JPY' ? '日本口座 (JPY)' : '米国口座 (USD)';
      var y = ccy === 'JPY' ? 30 + ((Math.max(nJpy, 1) - 1) * 130) / 2 : 30 + nJpy * 130 + ((Math.max(data.units.length - nJpy, 1) - 1) * 130) / 2;
      var saved = savedPos['__account_' + ccy + '__'];
      var id = editor.addNode('口座' + ccy, 0, 1, saved ? saved.x : 40, saved ? saved.y : y, 'sm-node sm-account',
        { unit: '口座' + ccy },
        '<div class="sm-card"><div class="sm-title" style="color:#fff">' + label + '</div>' +
        '<div class="sm-meta" style="color:#e8eaed">—</div></div>');
      accountIds[ccy] = id;
      unitOf[id] = '__account_' + ccy + '__';
      accountCcyOf['__account_' + ccy + '__'] = ccy;
    });

    function unitCardHtml(u, spawned) {
      var heldSyms = Object.keys(u.held || {});
      var statusHtml = heldSyms.length > 0
        ? '<div class="sm-status-active">Active ・ ' + heldSyms.map(function (x) { return x + ' ' + u.held[x]; }).join(' / ') + '</div>'
        : spawned
          ? '<div class="sm-status-pending">Inactive (適用で有効化)</div>'
          : '<div class="sm-status-pending">Pending (様子見' + (u.entryRequired ? '・条件連動 ON' : '') + ')</div>';
      var roleShorts = u.syms.map(function (x) { return u.roles[x]; }).filter(Boolean);
      var metaParts = [];
      if (roleShorts.length > 0) metaParts.push(roleShorts.join(' / '));
      metaParts.push(u.currency);
      // #460: OpenAPI 取扱バッジ (server 生成済み HTML、tradable は空)。
      var tradeBadgeHtml = u.tradeBadge ? '<div style="margin-top:4px">' + u.tradeBadge + '</div>' : '';
      return '<div class="sm-card">' +
        '<div class="sm-title" style="color:' + u.color + '">' + u.label + '</div>' +
        statusHtml +
        tradeBadgeHtml +
        '<div style="margin-top:4px">配分 <span class="sm-share" id="sm-share-' + u.id.replace('/', '_') + '">—</span></div>' +
        '<div class="sm-meta">' + metaParts.join(' ・ ') + '</div>' +
        '</div>';
    }
    function addUnitNode(u, x, y, opts2) {
      var spawned = !!(opts2 && opts2.spawned);
      unitBy[u.id] = u;
      baseline[u.id] = baseline[u.id] || { pct: u.pct || 0, fallbacks: (u.fallbacks || []).slice().sort(), active: !spawned };
      draft[u.id] = { connected: (u.pct || 0) > 0, fallbacks: (u.fallbacks || []).slice() };
      var id = editor.addNode(u.id, 1, 1, x, y, 'sm-node ' + (u.currency === 'JPY' ? 'sm-jpy' : 'sm-usd'), { unit: u.id }, unitCardHtml(u, spawned));
      idOf[u.id] = id;
      unitOf[id] = u.id;
      return id;
    }
    data.units.forEach(function (u) {
      var saved = savedPos[u.id];
      addUnitNode(u, saved ? saved.x : (u.pct > 0 ? 360 : 760), saved ? saved.y : u.y);
    });

    function tagConnectionClass(srcId, dstId, cls) {
      var conn = el.querySelector('svg.connection.node_in_node-' + dstId + '.node_out_node-' + srcId);
      if (conn) conn.classList.add(cls);
    }
    programmatic = true;
    data.units.forEach(function (u) {
      if (u.pct > 0) editor.addConnection(accountIds[u.currency], idOf[u.id], 'output_1', 'input_1');
      (u.fallbacks || []).forEach(function (fb) {
        if (!idOf[fb]) return;
        editor.addConnection(idOf[u.id], idOf[fb], 'output_1', 'input_1');
        tagConnectionClass(idOf[u.id], idOf[fb], 'sm-fallback');
      });
    });
    programmatic = false;

    // パン/ズームの復元と、移動・ズームのたびの保存。
    if (typeof savedLayout.zoom === 'number' && savedLayout.zoom > 0.2 && savedLayout.zoom <= 2) {
      editor.zoom = savedLayout.zoom;
      editor.canvas_x = savedLayout.canvasX || 0;
      editor.canvas_y = savedLayout.canvasY || 0;
      editor.zoom_refresh();
    }
    editor.on('nodeMoved', function () { persistLayout(); });
    editor.on('zoom', function () { persistLayout(); });
    editor.on('translate', function () { persistLayout(); });

    function deriveShares() {
      var branches = 0;
      Object.keys(draft).forEach(function (uid) { if (draft[uid].connected) branches += 1; });
      var share = branches > 0 ? Math.round((100 / branches) * 10) / 10 : 0;
      var shares = {};
      Object.keys(draft).forEach(function (uid) { shares[uid] = draft[uid].connected ? share : 0; });
      return { branches: branches, share: share, shares: shares };
    }
    function renderShares() {
      var d = deriveShares();
      Object.keys(draft).forEach(function (uid) {
        var span = document.getElementById('sm-share-' + uid.replace('/', '_'));
        if (!span) return;
        span.textContent = draft[uid].connected ? '1/' + d.branches + ' = ' + d.share + '%' : 'なし (risk-%)';
      });
      currencies.forEach(function (ccy) {
        var accountEl = document.getElementById('node-' + accountIds[ccy]);
        if (!accountEl) return;
        var meta = accountEl.querySelector('.sm-meta');
        if (!meta) return;
        var n = 0;
        Object.keys(draft).forEach(function (uid) {
          if (draft[uid].connected && unitBy[uid].currency === ccy) n += 1;
        });
        var subtotal = Math.round(n * d.share * 10) / 10;
        meta.textContent = n + ' 枝 ・ 小計 ' + subtotal + '% (全体 ' + d.branches + ' 枝 ・ 1 枝 = ' + (d.branches > 0 ? d.share + '%' : '—') + ')';
      });
      return d;
    }

    // ---- シミュレーション (両モード共通)。結果は銘柄 → unit カードに重ねる。
    var simBtn = document.getElementById('sm-simulate');
    function clearSim() {
      el.querySelectorAll('.sm-sim-wrap').forEach(function (n) { n.remove(); });
      el.querySelectorAll('svg.connection.sm-sim-flow').forEach(function (n) { n.classList.remove('sm-sim-flow'); });
      el.querySelectorAll('svg.connection.sm-sim-dim').forEach(function (n) { n.classList.remove('sm-sim-dim'); });
      document.getElementById('sm-sim-meta').hidden = true;
    }
    var clearBtn = document.getElementById('sm-sim-clear');
    if (clearBtn) clearBtn.addEventListener('click', clearSim);
    function simBadge(uid, cls, html) {
      var nodeEl = document.getElementById('node-' + idOf[uid]);
      if (!nodeEl) return;
      var wrap = nodeEl.querySelector('.sm-sim-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'sm-sim-wrap';
        nodeEl.appendChild(wrap);
      }
      var div = document.createElement('div');
      div.className = 'sm-sim ' + cls;
      div.innerHTML = html;
      wrap.appendChild(div);
    }
    // 適用/シミュレートで使う「unit → 銘柄ごとの fallback 展開」(#496 多分岐)。
    // 各 src 側は dst unit ごとに 1 銘柄ずつ受け取る:
    //   対→対: 役割で側合わせ (leveraged↔leveraged)、なければ並び順。
    //   対→単独: 両側 → 同一先。単独→単独: そのまま。
    function expandFallbacks(srcUid, dstUids) {
      var src = unitBy[srcUid];
      var out = {};
      src.syms.forEach(function (x) { out[x] = (dstUids && dstUids.length > 0) ? [] : null; });
      (dstUids || []).forEach(function (dstUid) {
        var dst = unitBy[dstUid];
        src.syms.forEach(function (x, i) {
          var pick;
          if (dst.syms.length === 1) {
            pick = dst.syms[0];
          } else {
            var role = src.roles[x];
            var match = null;
            dst.syms.forEach(function (y) { if (dst.roles[y] === role && role) match = y; });
            pick = match || dst.syms[Math.min(i, dst.syms.length - 1)];
          }
          out[x].push(pick);
        });
      });
      return out;
    }
    function fallbacksChanged(uid) {
      var a = (draft[uid].fallbacks || []).slice().sort().join(',');
      var b = (baseline[uid].fallbacks || []).slice().sort().join(',');
      return a !== b;
    }
    if (simBtn) simBtn.addEventListener('click', function () {
      simBtn.disabled = true;
      simBtn.textContent = '計算中…';
      var bodyPayload = {};
      if (!isView) {
        var d = deriveShares();
        var pcts = {};
        var fallbacks = {};
        Object.keys(draft).forEach(function (uid) {
          var u = unitBy[uid];
          if (d.shares[uid] !== baseline[uid].pct) {
            u.syms.forEach(function (x) { pcts[x] = d.shares[uid] > 0 ? d.shares[uid] : null; });
          }
          if (fallbacksChanged(uid)) {
            var exp = expandFallbacks(uid, draft[uid].fallbacks);
            Object.keys(exp).forEach(function (x) { fallbacks[x] = exp[x]; });
          }
        });
        bodyPayload = { pcts: pcts, fallbacks: fallbacks };
      }
      fetch('/admin/allocation/simulate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (res) {
          clearSim();
          var pctTxt = function (w) { return Math.round(w * 1000) / 10 + '%'; };
          Object.keys(draft).forEach(function (uid) {
            (draft[uid].fallbacks || []).forEach(function (fb) {
              if (idOf[fb]) tagConnectionClass(idOf[uid], idOf[fb], 'sm-sim-dim');
            });
          });
          var planBySym = {};
          if (res.plan) res.plan.orders.forEach(function (o) { planBySym[o.symbol] = o; });
          Object.keys(res.allocations).forEach(function (sym) {
            var uid = data.unitOfSym[sym];
            if (!uid || !idOf[uid]) return;
            var a = res.allocations[sym];
            var status = res.entryStatuses[sym] || '—';
            var held = res.heldSymbols.indexOf(sym) !== -1;
            var prefix = unitBy[uid].syms.length > 1 ? sym + ': ' : '';
            if (a.rerouteTo) {
              var targets = Array.isArray(a.rerouteTo) ? a.rerouteTo : [a.rerouteTo];
              var per = targets.length > 1 ? ' (各 ' + pctTxt(a.targetWeight / targets.length) + ')' : '';
              simBadge(uid, 'sm-sim-reroute', prefix + '判定 ' + status + ' → <strong>' + pctTxt(a.targetWeight) + ' を ' + targets.join('/') + ' へ退避' + per + '</strong>');
              targets.forEach(function (t) {
                var dstUid = data.unitOfSym[t];
                if (dstUid && idOf[dstUid]) {
                  var conn = el.querySelector('svg.connection.node_in_node-' + idOf[dstUid] + '.node_out_node-' + idOf[uid]);
                  if (conn) { conn.classList.remove('sm-sim-dim'); conn.classList.add('sm-sim-flow'); }
                }
              });
            } else {
              simBadge(uid, 'sm-sim-active', prefix + (held ? '保有中' : '判定 ' + status) + ' ・ <strong>active ' + pctTxt(a.activeWeight) + '</strong>');
            }
            if (a.reroutedInWeight > 0) {
              var order = planBySym[sym];
              simBadge(uid, 'sm-sim-recv', prefix + '受入 +' + pctTxt(a.reroutedInWeight) +
                (order ? ' ・ <strong>' + order.quantity + ' 単位 買付予定</strong>' : ''));
            }
          });
          var metaBits = [(res.draftApplied ? '未適用 draft 込み' : '保存済み設定'), 'cron と同一ロジック ・ 発注なし'];
          if (res.plan && !res.ordersEnabledFlag && res.plan.orders.length > 0) metaBits.push('自動発注 flag OFF (cron は判定のみ)');
          if (res.plan) res.plan.skipped.forEach(function (k) { metaBits.push('⚠ ' + k.symbol + ' skip: ' + k.reason); });
          res.notes.forEach(function (n) { metaBits.push('⚠ ' + n); });
          document.getElementById('sm-sim-meta-text').textContent = metaBits.join(' ・ ');
          document.getElementById('sm-sim-meta').hidden = false;
        })
        .catch(function (e) {
          document.getElementById('sm-sim-meta-text').textContent = 'シミュレーション失敗: ' + e.message;
          document.getElementById('sm-sim-meta').hidden = false;
        })
        .then(function () {
          simBtn.disabled = false;
          simBtn.textContent = 'シミュレート';
        });
    });

    if (isView) {
      // view: ノード移動・パン・ズーム・シミュレートのみ。編集系は封印。
      editor.on('connectionCreated', function (info) {
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
      });
      editor.on('nodeRemoved', function () { location.reload(); });
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.stopPropagation(); ev.preventDefault(); }
      }, true);
      el.addEventListener('contextmenu', function (ev) { ev.stopPropagation(); ev.preventDefault(); }, true);
      renderShares();
      return;
    }

    // ---- ここから edit 専用 ----
    function markConnectionPending(srcId, dstId) {
      tagConnectionClass(srcId, dstId, 'sm-pending');
    }
    function setCardDirty(uid, dirty) {
      var nodeEl = document.getElementById('node-' + idOf[uid]);
      if (nodeEl) nodeEl.classList.toggle('sm-dirty', dirty);
    }
    function reachableSet() {
      var seen = {};
      var queue = Object.keys(draft).filter(function (uid) { return draft[uid].connected; });
      while (queue.length > 0) {
        var uid = queue.pop();
        if (seen[uid]) continue;
        seen[uid] = true;
        (draft[uid].fallbacks || []).forEach(function (fb) {
          if (draft[fb] && !seen[fb]) queue.push(fb);
        });
      }
      return seen;
    }
    function activeDiffs() {
      var reach = reachableSet();
      var activate = [];
      var deactivate = [];
      var heldSkip = [];
      Object.keys(draft).forEach(function (uid) {
        var willActive = !!reach[uid];
        var wasActive = baseline[uid].active !== false;
        if (willActive && !wasActive) activate.push(uid);
        if (!willActive && wasActive) {
          if (Object.keys(unitBy[uid].held || {}).length > 0) heldSkip.push(uid);
          else deactivate.push(uid);
        }
      });
      return { activate: activate, deactivate: deactivate, heldSkip: heldSkip };
    }
    function renderChanges() {
      var d = renderShares();
      var bar = document.getElementById('sm-changes-bar');
      var list = document.getElementById('sm-changes-list');
      var items = [];
      Object.keys(draft).forEach(function (uid) {
        var b = baseline[uid];
        var u = unitBy[uid];
        var newPct = d.shares[uid];
        var pctChanged = newPct !== b.pct;
        var fbChanged = fallbacksChanged(uid);
        if (pctChanged) {
          items.push(u.label + ': 配分 ' + (b.pct ? b.pct + '%' : 'なし') + ' → ' + (newPct ? '1/' + d.branches + ' = ' + newPct + '%' : '解除 (risk-%)'));
        }
        if (fbChanged) {
          var fbs = draft[uid].fallbacks || [];
          if (fbs.length > 0) {
            var exp = expandFallbacks(uid, fbs);
            var detail = u.syms.map(function (x) { return x + '→' + exp[x].join('+'); }).join(' / ');
            var split = fbs.length > 1 ? '、各 1/' + fbs.length + ' に等分割' : '';
            items.push(u.label + ': 退避先 → ' + fbs.map(function (f) { return unitBy[f].label; }).join(' + ') + ' (' + detail + split + '、条件連動 ON)');
          } else {
            items.push(u.label + ': 退避先を解除');
          }
        }
        setCardDirty(uid, pctChanged || fbChanged);
      });
      var ad = activeDiffs();
      ad.activate.forEach(function (uid) { items.push(unitBy[uid].label + ': 有効化 (口座に接続)'); });
      ad.deactivate.forEach(function (uid) {
        items.push(unitBy[uid].label + ': 無効化 (口座から到達不能)');
        setCardDirty(uid, true);
      });
      ad.heldSkip.forEach(function (uid) { items.push(unitBy[uid].label + ': 到達不能だが保有中のため無効化しません (手動で対応)'); });
      list.innerHTML = items.map(function (t) { return '<li>' + t + '</li>'; }).join('');
      bar.hidden = items.length === 0;
      return d;
    }
    renderChanges();

    // ---- カード削除 = 盤面から下ろす (在庫に戻る) ----
    var removedOnCanvas = {};
    editor.on('nodeRemoved', function (id) {
      var uid = unitOf[id];
      if (!uid) return;
      if (accountCcyOf[uid]) {
        alert('口座カードは削除できません。再読込します。');
        location.reload();
        return;
      }
      delete unitOf[id];
      delete idOf[uid];
      removedOnCanvas[uid] = true;
      draft[uid].connected = false;
      draft[uid].fallbacks = [];
      Object.keys(draft).forEach(function (x) {
        draft[x].fallbacks = (draft[x].fallbacks || []).filter(function (f) { return f !== uid; });
      });
      renderChanges();
    });

    // ---- 接続の作成/削除 ----
    editor.on('connectionCreated', function (info) {
      if (programmatic) return;
      var src = unitOf[info.output_id];
      var dst = unitOf[info.input_id];
      if (!src || !dst || accountCcyOf[dst]) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        return;
      }
      if (accountCcyOf[src]) {
        if (unitBy[dst].currency !== accountCcyOf[src]) {
          programmatic = true;
          editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
          programmatic = false;
          alert(unitBy[dst].label + ' は ' + unitBy[dst].currency + ' です。' + accountCcyOf[src] + ' 口座からは接続できません。');
          return;
        }
        draft[dst].connected = true;
        markConnectionPending(info.output_id, info.input_id);
        renderChanges();
        return;
      }
      // 退避: 単独 → 対は側を特定できないため不可。通貨も一致必須。
      if (unitBy[src].syms.length === 1 && unitBy[dst].syms.length > 1) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        alert('単独銘柄から対 (' + unitBy[dst].label + ') への退避は側を特定できないため設定できません。');
        return;
      }
      if (unitBy[src].currency !== unitBy[dst].currency) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        alert('異通貨の退避先は設定できません (同一通貨のみ)。');
        return;
      }
      // 退避は多分岐可 (#496): 追加で**等分割**される。重複と上限 (4) のみ防ぐ。
      var cur = draft[src].fallbacks || [];
      if (cur.indexOf(dst) !== -1 || cur.length >= 4) {
        programmatic = true;
        editor.removeSingleConnection(info.output_id, info.input_id, info.output_class, info.input_class);
        programmatic = false;
        if (cur.length >= 4) alert('退避先は最大 4 つまでです。');
        return;
      }
      draft[src].fallbacks = cur.concat([dst]);
      tagConnectionClass(info.output_id, info.input_id, 'sm-fallback');
      markConnectionPending(info.output_id, info.input_id);
      renderChanges();
    });

    editor.on('connectionRemoved', function (info) {
      if (programmatic) return;
      var src = unitOf[info.output_id];
      var dst = unitOf[info.input_id];
      if (!src || !dst) return;
      if (accountCcyOf[src]) {
        draft[dst].connected = false;
        renderChanges();
        return;
      }
      draft[src].fallbacks = (draft[src].fallbacks || []).filter(function (f) { return f !== dst; });
      renderChanges();
    });

    // ---- 空中リリース → 在庫から spawn ----
    var connStartId = null;
    var connConsumed = false;
    var picker = document.createElement('div');
    picker.id = 'sm-spawn-picker';
    picker.hidden = true;
    picker.style.cssText = 'position:fixed;z-index:50;background:#fff;border:1px solid #d0d0d5;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:6px;font-size:12px;max-height:240px;overflow:auto';
    document.body.appendChild(picker);
    function hidePicker() { picker.hidden = true; connStartId = null; }
    document.addEventListener('mousedown', function (ev) {
      if (!picker.hidden && !picker.contains(ev.target)) hidePicker();
    });
    function canvasPos(clientX, clientY) {
      var pre = editor.precanvas;
      var rect = pre.getBoundingClientRect();
      var zoom = pre.clientWidth / (pre.clientWidth * editor.zoom);
      return { x: clientX * zoom - rect.x * zoom, y: clientY * zoom - rect.y * zoom };
    }
    function spawnAndConnect(item, srcNodeId, clientX, clientY) {
      var pos = canvasPos(clientX, clientY);
      var known = unitBy[item.id];
      var u = known || {
        id: item.id,
        syms: item.syms,
        label: item.label,
        currency: item.currency,
        color: item.color,
        roles: item.roles,
        pct: 0,
        held: {},
        entryRequired: false,
        fallback: { id: null, mixed: false },
        y: 0,
      };
      programmatic = true;
      var newId = addUnitNode(u, pos.x, pos.y, { spawned: baseline[u.id] ? baseline[u.id].active === false : true });
      editor.addConnection(srcNodeId, newId, 'output_1', 'input_1');
      programmatic = false;
      var src = unitOf[srcNodeId];
      if (accountCcyOf[src]) {
        draft[u.id].connected = true;
      } else {
        draft[src].fallbacks = (draft[src].fallbacks || []).concat([u.id]);
        tagConnectionClass(srcNodeId, newId, 'sm-fallback');
      }
      markConnectionPending(srcNodeId, newId);
      delete removedOnCanvas[u.id];
      data.inventory = data.inventory.filter(function (x) { return x.id !== u.id; });
      renderChanges();
    }
    function showPicker(srcNodeId, clientX, clientY) {
      var src = unitOf[srcNodeId];
      var srcIsAccount = !!accountCcyOf[src];
      var ccy = srcIsAccount ? accountCcyOf[src] : unitBy[src].currency;
      var removedItems = Object.keys(removedOnCanvas).map(function (uid) {
        var u = unitBy[uid];
        return { id: u.id, syms: u.syms, label: u.label, currency: u.currency, color: u.color, roles: u.roles };
      });
      var candidates = data.inventory.concat(removedItems).filter(function (x) { return x.currency === ccy; });
      // 単独銘柄からの退避先候補に対は出さない (側を特定できない)。
      if (!srcIsAccount && unitBy[src].syms.length === 1) {
        candidates = candidates.filter(function (x) { return x.syms.length === 1; });
      }
      if (candidates.length === 0) return;
      picker.innerHTML = '<div class="muted" style="padding:2px 6px 6px">既存 Inactive を紐づけ (' + ccy + ')</div>' +
        candidates.map(function (x) {
          return '<div class="sm-spawn-item" data-uid="' + x.id + '" style="padding:5px 10px;border-radius:6px;cursor:pointer">' +
            '<strong style="color:' + x.color + '">' + x.label + '</strong>' +
            (x.syms.length > 1 ? ' <span class="muted" style="font-size:10px">対</span>' : '') + '</div>';
        }).join('');
      picker.style.left = clientX + 'px';
      picker.style.top = clientY + 'px';
      picker.hidden = false;
      var sx = clientX;
      var sy = clientY;
      picker.querySelectorAll('.sm-spawn-item').forEach(function (itemEl) {
        itemEl.addEventListener('mouseenter', function () { itemEl.style.background = '#f0f6ff'; });
        itemEl.addEventListener('mouseleave', function () { itemEl.style.background = ''; });
        itemEl.addEventListener('click', function () {
          var uid = itemEl.getAttribute('data-uid');
          var item = null;
          candidates.forEach(function (x) { if (x.id === uid) item = x; });
          var srcId = srcNodeId;
          hidePicker();
          if (item) spawnAndConnect(item, srcId, sx, sy);
        });
      });
    }
    el.addEventListener('mousedown', function (ev) {
      var out = ev.target && ev.target.closest ? ev.target.closest('.output') : null;
      if (!out) return;
      var nodeEl = ev.target.closest('.drawflow-node');
      if (!nodeEl) return;
      connStartId = parseInt(nodeEl.id.replace('node-', ''), 10);
      connConsumed = false;
    });
    editor.on('connectionCreated', function () { connConsumed = true; connStartId = null; });
    document.addEventListener('mouseup', function (ev) {
      if (connStartId === null) return;
      var srcId = connStartId;
      var mx = ev.clientX;
      var my = ev.clientY;
      setTimeout(function () {
        if (connConsumed) { connStartId = null; return; }
        connStartId = null;
        showPicker(srcId, mx, my);
      }, 30);
    });

    // ---- 入力ポートドラッグで線の付け替え ----
    var retarget = null;
    var guide = null;
    function portCenter(nodeId, cls) {
      var port = el.querySelector('#node-' + nodeId + ' .' + cls);
      if (!port) return null;
      var r = port.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function showGuide(from, to) {
      if (!guide) {
        guide = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        guide.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:40';
        guide.innerHTML = '<line stroke="#6e6e73" stroke-width="2.5" stroke-dasharray="6 5"/>';
        document.body.appendChild(guide);
      }
      var line = guide.querySelector('line');
      line.setAttribute('x1', from.x);
      line.setAttribute('y1', from.y);
      line.setAttribute('x2', to.x);
      line.setAttribute('y2', to.y);
    }
    function hideGuide() { if (guide) { guide.remove(); guide = null; } }
    el.addEventListener('mousedown', function (ev) {
      var inp = ev.target && ev.target.closest ? ev.target.closest('.input') : null;
      if (!inp) return;
      var nodeEl = ev.target.closest('.drawflow-node');
      if (!nodeEl) return;
      var dstId = parseInt(nodeEl.id.replace('node-', ''), 10);
      var dstUid = unitOf[dstId];
      if (!dstUid || accountCcyOf[dstUid]) return;
      var moduleData = editor.drawflow.drawflow[editor.module].data[dstId];
      var conns = moduleData && moduleData.inputs && moduleData.inputs.input_1 ? moduleData.inputs.input_1.connections : [];
      if (!conns || conns.length === 0) return;
      var srcId = parseInt(conns[conns.length - 1].node, 10);
      ev.preventDefault();
      ev.stopPropagation();
      retarget = { srcId: srcId, oldDstId: dstId };
      var from = portCenter(srcId, 'output') || { x: ev.clientX, y: ev.clientY };
      showGuide(from, { x: ev.clientX, y: ev.clientY });
    }, true);
    document.addEventListener('mousemove', function (ev) {
      if (!retarget) return;
      var from = portCenter(retarget.srcId, 'output') || { x: ev.clientX, y: ev.clientY };
      showGuide(from, { x: ev.clientX, y: ev.clientY });
    });
    document.addEventListener('mouseup', function (ev) {
      if (!retarget) return;
      var state = retarget;
      retarget = null;
      hideGuide();
      var dropNode = document.elementFromPoint(ev.clientX, ev.clientY);
      dropNode = dropNode && dropNode.closest ? dropNode.closest('.drawflow-node') : null;
      if (!dropNode) return;
      var newDstId = parseInt(dropNode.id.replace('node-', ''), 10);
      var newDst = unitOf[newDstId];
      var src = unitOf[state.srcId];
      var oldDst = unitOf[state.oldDstId];
      if (!newDst || accountCcyOf[newDst] || newDst === oldDst || newDst === src) return;
      // 旧線を外す。
      programmatic = true;
      editor.removeSingleConnection(state.srcId, state.oldDstId, 'output_1', 'input_1');
      programmatic = false;
      if (accountCcyOf[src]) {
        draft[oldDst].connected = false;
        if (unitBy[newDst].currency !== accountCcyOf[src]) {
          alert(unitBy[newDst].label + ' は ' + unitBy[newDst].currency + ' です。元に戻します。');
          programmatic = true;
          editor.addConnection(state.srcId, state.oldDstId, 'output_1', 'input_1');
          programmatic = false;
          draft[oldDst].connected = true;
          renderChanges();
          return;
        }
        programmatic = true;
        editor.addConnection(state.srcId, idOf[newDst], 'output_1', 'input_1');
        programmatic = false;
        draft[newDst].connected = true;
        markConnectionPending(state.srcId, idOf[newDst]);
      } else {
        draft[src].fallbacks = (draft[src].fallbacks || []).filter(function (f) { return f !== oldDst; });
        var invalid = (unitBy[src].syms.length === 1 && unitBy[newDst].syms.length > 1) ||
          unitBy[src].currency !== unitBy[newDst].currency ||
          (draft[src].fallbacks || []).indexOf(newDst) !== -1;
        if (invalid) {
          alert('その付け替えはできません (単独→対 / 異通貨 / 重複)。元に戻します。');
          programmatic = true;
          editor.addConnection(state.srcId, state.oldDstId, 'output_1', 'input_1');
          programmatic = false;
          tagConnectionClass(state.srcId, state.oldDstId, 'sm-fallback');
          draft[src].fallbacks = (draft[src].fallbacks || []).concat([oldDst]);
          renderChanges();
          return;
        }
        programmatic = true;
        editor.addConnection(state.srcId, idOf[newDst], 'output_1', 'input_1');
        programmatic = false;
        draft[src].fallbacks = (draft[src].fallbacks || []).concat([newDst]);
        tagConnectionClass(state.srcId, idOf[newDst], 'sm-fallback');
        markConnectionPending(state.srcId, idOf[newDst]);
      }
      renderChanges();
    });

    // ---- 線の削除 (選択 → Backspace/Delete or ボタン) ----
    var deleteBtn = document.getElementById('sm-delete-conn');
    function refreshDeleteBtn() {
      var has = editor.connection_selected != null;
      deleteBtn.disabled = !has;
      deleteBtn.style.color = has ? '#c22' : '#999';
      deleteBtn.style.borderColor = has ? '#c22' : '#ccc';
    }
    el.addEventListener('click', function () { setTimeout(refreshDeleteBtn, 0); });
    deleteBtn.addEventListener('click', function () {
      if (editor.connection_selected != null) editor.removeConnection();
      refreshDeleteBtn();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Backspace') return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (editor.connection_selected != null) {
        ev.preventDefault();
        editor.removeConnection();
        refreshDeleteBtn();
      }
    });

    // ---- 適用 (有効化 → 配分 → 退避 → 無効化) ----
    document.getElementById('sm-reset').addEventListener('click', function () { location.reload(); });
    document.getElementById('sm-apply').addEventListener('click', function () {
      var d = deriveShares();
      var ad = activeDiffs();
      var pctUnits = Object.keys(draft).filter(function (uid) { return d.shares[uid] !== baseline[uid].pct; });
      var fbUnits = Object.keys(draft).filter(function (uid) { return fallbacksChanged(uid); });
      if (pctUnits.length === 0 && fbUnits.length === 0 && ad.activate.length === 0 && ad.deactivate.length === 0) return;
      var confirmMsg = '表示中の変更をまとめて適用します (' + d.branches + ' 枝 ・ 1 枝 = ' + d.share + '%';
      if (ad.activate.length > 0) confirmMsg += ' ・ 有効化 ' + ad.activate.map(function (x) { return unitBy[x].label; }).join('/');
      if (ad.deactivate.length > 0) confirmMsg += ' ・ 無効化 ' + ad.deactivate.map(function (x) { return unitBy[x].label; }).join('/');
      confirmMsg += ')。よろしいですか？';
      if (!confirm(confirmMsg)) return;
      var steps = Promise.resolve();
      function toggleStep(sym, label) {
        return function () {
          return fetch('/admin/symbol-config/' + encodeURIComponent(sym) + '/toggle-active', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
          }).then(function (r) {
            if (!r.ok) throw new Error(sym + ' の' + label + 'に失敗 (HTTP ' + r.status + ')');
          });
        };
      }
      ad.activate.forEach(function (uid) {
        unitBy[uid].syms.forEach(function (sym) { steps = steps.then(toggleStep(sym, '有効化')); });
      });
      if (pctUnits.length > 0) {
        var form = new FormData();
        pctUnits.forEach(function (uid) {
          unitBy[uid].syms.forEach(function (sym) {
            form.append('pct_' + sym, d.shares[uid] > 0 ? String(d.shares[uid]) : '');
          });
        });
        steps = steps.then(function () {
          return fetch('/admin/symbol-config/budget-alloc', { method: 'POST', credentials: 'same-origin', body: form })
            .then(function (r) { if (!r.ok) throw new Error('配分の保存に失敗 (HTTP ' + r.status + ')'); });
        });
      }
      fbUnits.forEach(function (uid) {
        var exp = expandFallbacks(uid, draft[uid].fallbacks || []);
        Object.keys(exp).forEach(function (sym) {
          steps = steps.then(function () {
            return fetch('/admin/symbol-config/' + encodeURIComponent(sym) + '/cash-fallback', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ targets: exp[sym] }),
            }).then(function (r) {
              if (!r.ok) return r.json().then(function (b) { throw new Error(sym + ' の退避先の保存に失敗: ' + (b.error || 'HTTP ' + r.status)); });
            });
          });
        });
      });
      ad.deactivate.forEach(function (uid) {
        unitBy[uid].syms.forEach(function (sym) { steps = steps.then(toggleStep(sym, '無効化')); });
      });
      steps
        .then(function () { location.reload(); })
        .catch(function (e) { alert(e.message + ' — 再読込して状態を確認してください。'); location.reload(); });
    });
  });
  </script>`
}

function symbolsListBody(args: {
  rows: SymbolConfigRow[]
  inversePairs?: Record<string, string>
  pairRegimes?: PairRegimeEntry[]
  mapAmounts?: Record<string, { native: string; jpy: number }>
  /** #460: OpenAPI 取扱 allowlist。各行/カードの取扱バッジに使う。 */
  tradable?: TradableAllowlist
  errorCode?: string | null
  errorSymbol?: string | null
  filter: SymbolsListFilter
  /** 'list' = 表 (default)、'workflow' = 配分キャンバス。マップ埋め込みでページが
   *  重くなったため tab 分離 (operator 要望)。Drawflow の読み込みも workflow 時のみ。 */
  tab?: 'list' | 'workflow'
}): string {
  const { rows, inversePairs = {}, pairRegimes = [], mapAmounts = {}, errorCode = null, errorSymbol = null, filter } = args
  const tradable: TradableAllowlist = args.tradable ?? new Map()
  const tab = args.tab ?? 'list'
  const tabBar = `<div style="display:flex;gap:4px;margin:0 0 12px;border-bottom:1px solid #e3e3e8">
    <a href="/dashboard/symbols" style="padding:6px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab === 'list' ? '#06c' : 'transparent'};color:${tab === 'list' ? '#06c' : '#5f6368'};font-weight:${tab === 'list' ? '600' : 'normal'}">一覧</a>
    <a href="/dashboard/symbols?tab=workflow" style="padding:6px 16px;font-size:13px;text-decoration:none;border-bottom:2px solid ${tab === 'workflow' ? '#06c' : 'transparent'};color:${tab === 'workflow' ? '#06c' : '#5f6368'};font-weight:${tab === 'workflow' ? '600' : 'normal'}">ワークフロー</a>
  </div>`
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

  // #460: allowlist の取得状況サマリ (操作判断のため最終取得日と件数を出す)。
  const tradableEntries = [...tradable.values()]
  const tradableCount = tradableEntries.filter((e) => e.status === 'tradable').length
  const lastSync = tradableEntries.reduce<string>(
    (acc, e) => (e.lastSeenAt && e.lastSeenAt > acc ? e.lastSeenAt : acc),
    '',
  )
  const allowlistNote =
    tradableEntries.length === 0
      ? '<span class="muted" style="font-size:12px">OpenAPI 取扱リスト: 未取得 — 「取扱リスト更新」で取得</span>'
      : `<span class="muted" style="font-size:12px" title="tradable/list を全件 sweep した結果のキャッシュ (#460)">OpenAPI 取扱リスト: ${tradableCount} 銘柄 (最終取得 ${esc(lastSync.slice(0, 10))})</span>`
  const headerBar = `<p style="margin:0 0 12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <a href="/dashboard/symbols/new" style="padding:6px 12px;background:#06c;color:#fff;border-radius:4px;text-decoration:none">+ 新規追加</a>
    <span class="muted" style="font-size:12px">${filtered.length} / ${rows.length} 件表示 (有効 ${activeCount} / 無効 ${inactiveCount})</span>
    <button type="button" id="tradable-refresh-btn" onclick="window.refreshTradableAllowlist()" style="padding:5px 10px;font-size:12px;background:#fff;border:1px solid #d0d0d5;border-radius:4px;cursor:pointer" title="Webull の OpenAPI 取扱可能銘柄リスト (tradable/list) を今すぐ再取得して allowlist を更新します。全件 sweep のため数十秒かかります (#460)">🔄 取扱リスト更新</button>
    ${allowlistNote}
    <span id="tradable-refresh-status" style="font-size:12px"></span>
  </p>
  <script>
  // #460: 全件 sweep は 1 リクエストの予算で完走できないので、チャンク式で
  // done になるまで連続 POST する。各 POST は ~15 ページ (~20秒) を処理し、
  // nextCursor + watermark を返すので同じ watermark で続きを叩く。件数は
  // total でライブ表示。done で再読込してバッジを反映。
  window.refreshTradableAllowlist = function () {
    var btn = document.getElementById('tradable-refresh-btn');
    var st = document.getElementById('tradable-refresh-status');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    if (st) { st.textContent = '⏳ 取得中... (全件まで約1分)'; st.style.color = '#86868b'; }
    var step = function (cursor, watermark, guard) {
      if (guard > 40) { // 安全上限 (40 チャンク = 600 ページ相当)
        if (st) { st.textContent = '⚠ 取得が長すぎるため中断 (部分反映済み)'; st.style.color = '#b25000'; }
        if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        return;
      }
      var qs = [];
      if (cursor) qs.push('cursor=' + encodeURIComponent(cursor));
      if (watermark) qs.push('watermark=' + encodeURIComponent(watermark));
      var url = '/admin/tradable-allowlist/refresh' + (qs.length ? '?' + qs.join('&') : '');
      fetch(url, { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || res.ok === false) {
            if (st) { st.textContent = '⚠ 取得失敗: ' + ((res && res.error) || 'unknown'); st.style.color = '#c22'; }
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
            return;
          }
          var n = res.total != null ? res.total : 0;
          if (res.done) {
            if (st) { st.textContent = '✓ ' + n + ' 銘柄取得完了' + (res.disappeared > 0 ? ' / ' + res.disappeared + ' 消失' : '') + ' — 再読込します'; st.style.color = '#0e9f6e'; }
            setTimeout(function () { window.location.reload(); }, 700);
            return;
          }
          if (st) { st.textContent = '⏳ 取得中... ' + n + ' 銘柄'; st.style.color = '#86868b'; }
          step(res.nextCursor, res.watermark, guard + 1);
        })
        .catch(function () {
          if (st) { st.textContent = '⚠ 通信エラー'; st.style.color = '#c22'; }
          if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        });
    };
    step(null, null, 0);
  };
  </script>`

  if (tab === 'workflow') {
    return `${errorBanner}${tabBar}${symbolMapEditorBody(rows, inversePairs, mapAmounts, { mode: 'view', pairRegimes, tradable })}`
  }

  if (rows.length === 0) {
    return `${errorBanner}${tabBar}${headerBar}<p class="muted">登録銘柄なし。「+ 新規追加」から最初の symbol を登録してください。</p>`
  }
  if (filtered.length === 0) {
    return `${errorBanner}${tabBar}${filterBar}${headerBar}<p class="muted">フィルタに一致する銘柄無し。条件を緩めてください。</p>`
  }
  // #315: インバース対が隣接するよう並べ替え、ペアごとに交互の薄色背景 + ツリー表記。
  const ordered = orderRowsByPair(filtered, inversePairs)
  const pairColor = assignPairColors(ordered, inversePairs)
  const roles = pairRoles(ordered, inversePairs)
  // 共有 slider の初期値計算用 (対の max を採るため両側の % を引けるように)。
  const pctOf = new Map(
    ordered.map((r) => [
      r.symbol.toUpperCase(),
      r.budgetAllocPct != null ? Math.round(r.budgetAllocPct * 1000) / 10 : 0,
    ]),
  )
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
      // 戦略ロール + 条件連動配分の要約 (#452)。NULL は従来挙動なので「—」。
      // entry 抑止 role (cash_parking / 定義のみ) は title で発注されない旨を明示。
      const roleCell = renderSymbolRoleCell(r)
      const lotSizeValid = Number.isInteger(r.lotSize) && (r.lotSize as number) >= 1
      const lotSizeCell = !lotSizeValid
        ? '<span class="err" title="売買単位が未設定または不正です。設定するまで BUY は発注されません (fail-closed)。編集から入力してください。">⚠ 未設定</span>'
        : `${esc(String(r.lotSize))} <span class="muted" style="font-size:11px">${r.lotSize === 1 ? '株/口' : '株'}</span>`
      // 予算配分 ladder slider (#budget-alloc): 5%刻み。確定するまで client 側で仮調整、
      // form="symbol-budget-form" で一括 POST。両側表示中のインバース対は 1 本の共有
      // slider (rowspan=2) に統合する — 同時に建つのは片側のみで予算消費は 1 回分
      // なのに、2 本並ぶと倍取られているように見えるため。初期値は両側の max、
      // POST に載らない相手側は server が同値同期する (admin #budget-alloc)。
      const allocPctNum =
        role === 'top'
          ? Math.max(pctOf.get(sym) ?? 0, pctOf.get(inverse!.toUpperCase()) ?? 0)
          : (pctOf.get(sym) ?? 0)
      const sliderHtml = `<div style="display:flex;align-items:center;gap:6px;min-width:170px">
          <input type="range" name="pct_${esc(r.symbol)}" form="symbol-budget-form" min="0" max="100" step="5" value="${allocPctNum}"
            data-symbol="${esc(r.symbol)}"${inverse ? ` data-inverse="${esc(inverse)}"` : ''}
            oninput="window.onBudgetSlide(this)" style="width:110px;vertical-align:middle">
          <span id="budget-label-${esc(r.symbol)}" class="muted" style="font-size:12px;width:42px;text-align:right;font-variant-numeric:tabular-nums">${allocPctNum === 0 ? 'risk' : allocPctNum + '%'}</span>
        </div>`
      const budgetTd =
        role === 'bottom'
          ? ''
          : role === 'top'
            ? `<td rowspan="2" style="vertical-align:middle">${sliderHtml}<div class="muted" style="font-size:11px;margin-top:2px">ペア共通 — 建玉は片側のみ、予算消費は1回分</div></td>`
            : `<td>${sliderHtml}</td>`
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
      // #460: OpenAPI 取扱 allowlist バッジ (tradable は出さない)。
      const tradBadge = tradableBadgeHtml(tradable.get(sym)?.status ?? 'unknown')
      const tradBadgeHtml = tradBadge ? `<div style="margin-top:2px">${tradBadge}</div>` : ''
      return `<tr${rowStyle}>
        <td style="position:relative;width:28px;padding:0">${treeCell}</td>
        <td><a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}" title="チャート銘柄タブで見る" style="text-decoration:none"><strong><span${symStyle}>${esc(r.symbol)}</span></strong></a>${tradBadgeHtml}</td>
        <td>${esc(r.name ?? '')}</td>
        <td><code style="font-size:11px">${esc(r.market)}/${esc(r.currency)}</code></td>
        <td>${roleCell}</td>
        <td>${lotSizeCell}</td>
        <td>${maxNotionalCell}</td>
        ${budgetTd}
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
  return `${errorBanner}${tabBar}${filterBar}${headerBar}
  <table>
    <thead><tr>
      <th style="width:28px" title="インバース対のツリー表記"></th>
      <th>銘柄</th>
      <th>銘柄名</th>
      <th>市場/通貨</th>
      <th>ロール</th>
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

// #budget-alloc ladder の client JS: slider 移動でラベル更新 + 「未確定」バーを表示。
// 保存は確定ボタン押下の form POST のみ (即保存しない = 確定するまで仮)。
// インバース対は 1 本の共有 slider なので相手 slider の同期は不要 — POST に載らない
// 相手側は server が同値同期する (#315 regime hedge)。
const BUDGET_LADDER_JS = `
  window.__budgetDirty = {};
  window.__fmtBudget = function (v) { return Number(v) <= 0 ? 'risk' : v + '%'; };
  window.onBudgetSlide = function (el) {
    var sym = el.getAttribute('data-symbol');
    var inv = el.getAttribute('data-inverse');
    var v = el.value;
    var lb = document.getElementById('budget-label-' + sym);
    if (lb) lb.textContent = window.__fmtBudget(v);
    // 保存時に server 同期で相手側も変わるので、dirty 数には相手も数える。
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
      var inv = s.getAttribute('data-inverse');
      var v = Number(s.value);
      // 対の共有 slider は両側を上書きする (相手の baseline が残ると max が
      // 旧値に張り付き、下げた時にメーターが追従しない)。
      if (v > 0) {
        bySym[sym] = { pct: v, inv: inv };
        if (inv) bySym[inv] = { pct: v, inv: sym };
      } else {
        // 0 にした表示中銘柄は除外 (baseline 値で復活させない)
        delete bySym[sym];
        if (inv) delete bySym[inv];
      }
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
  /** #460: OpenAPI 取扱 allowlist status (edit モードの server 描画用)。 */
  tradableStatus?: TradableStatus
}

/**
 * OpenAPI 取扱 allowlist (#460) のバッジ表現。tradable/list 由来の status を
 * operator が判断できる短い日本語ラベル + 色 + tooltip にまとめる。
 *   - tradable    : 直近 sweep で OpenAPI 取扱可
 *   - disappeared : 過去は取扱可だったが直近 sweep で消失 (取扱停止の可能性)
 *   - unknown     : allowlist 未観測 (OpenAPI で発注できない可能性)
 * 登録/発注は止めない警告レイヤー (ユーザー方針: 警告のみ)。`tradable` は
 * バッジを出さない (ノイズ削減 — 問題のある状態だけ目立たせる)。
 */
const TRADABLE_BADGE: Record<
  Exclude<TradableStatus, 'tradable'>,
  { label: string; bg: string; fg: string; title: string }
> = {
  disappeared: {
    label: '⚠ 取扱消失',
    bg: '#fff4e5',
    fg: '#9a5b00',
    title:
      'OpenAPI 取扱リスト (tradable/list) に過去は在籍したが直近の sweep で消失。取扱停止された可能性 — 保有・運用中なら確認を (#460)',
  },
  unknown: {
    label: '⚠ 取扱未確認',
    bg: '#f1f1f4',
    fg: '#6e6e73',
    title:
      'OpenAPI 取扱リスト (tradable/list) に未観測。アプリで売買できても OpenAPI 経由では発注できない可能性 (USMV 等)。発注後に 417 で弾かれる場合あり (#460)',
  },
}

/** allowlist status → 一覧/フォーム用バッジ HTML。tradable は空 (バッジ無し)。 */
function tradableBadgeHtml(status: TradableStatus): string {
  if (status === 'tradable') return ''
  const b = TRADABLE_BADGE[status]
  return `<span title="${esc(b.title)}" style="display:inline-block;padding:1px 6px;border-radius:6px;background:${b.bg};color:${b.fg};font-size:11px;font-weight:600;white-space:nowrap">${b.label}</span>`
}

/** role の短い日本語名 (#452)。一覧 / チャートタブのインライン表示用。 */
const SYMBOL_ROLE_LABELS_SHORT: Record<SymbolRole, string> = {
  cash_parking: '待機資金ETF',
  core_trend: '非レバ・トレンド',
  leveraged_trend: 'レバETF・トレンド',
  low_volatility: '低ボラ',
  sector_trend: 'セクター',
  inverse_hedge: 'インバースヘッジ (短期)',
  momentum: 'モメンタム (⚠未検証)',
}

/** role select の表示ラベル (#452)。値は DB enum と同一、表示だけ日本語補足。 */
const SYMBOL_ROLE_LABELS: Record<SymbolRole, string> = {
  cash_parking: 'cash_parking — 待機資金 ETF (SGOV / BIL 等)',
  core_trend: 'core_trend — 非レバ・トレンド (QQQ / VOO 等)',
  leveraged_trend: 'leveraged_trend — レバ ETF (TQQQ / SOXL 等)',
  low_volatility: 'low_volatility — 低ボラ ETF (USMV / SPLV 等)',
  sector_trend: 'sector_trend — 1x セクター ETF (SMH / SOXX 等)',
  inverse_hedge: 'inverse_hedge — 3x インバース・短期 (SQQQ / SOXS。1x は override 必須)',
  momentum: 'momentum — ⚠ モメンタム/ブレイク (1x向け・backtest未検証・要警告)',
}

/** 一覧テーブルの「ロール」セル (#452)。role + 配分の条件連動を 1 セルに要約する。 */
export function renderSymbolRoleCell(row: SymbolConfigRow): string {
  const role = row.role?.trim() || null
  const known = role !== null && (SYMBOL_ROLES as readonly string[]).includes(role)
  const roleBadge =
    role === null
      ? '<span class="muted" title="role 未設定 = 従来挙動">—</span>'
      : known
        ? `<code style="font-size:11px" title="${esc(SYMBOL_ROLE_LABELS[role as SymbolRole])}">${esc(role)}</code><div class="muted" style="font-size:11px">${esc(SYMBOL_ROLE_LABELS_SHORT[role as SymbolRole])}</div>`
        : `<span class="err" title="不正な role 値です。entry は抑止されます (fail-closed)。編集から正しい値を選んでください。">⚠ ${esc(role)}</span>`
  const notes: string[] = []
  if (row.alwaysActive) notes.push('<span title="判定に関わらず常時 target = active">常時配分</span>')
  if (row.entryRequired) notes.push('<span title="entry 判定 (ENTRY/HALF) 通過時のみ実配分有効">条件連動</span>')
  const fallbackList = parseCashFallbacksJson(row.cashFallbackSymbols, row.symbol)
  if (fallbackList.length > 0) {
    notes.push(
      `<span title="条件未通過時の退避先${fallbackList.length > 1 ? ' (等分割)' : ''}">→${fallbackList
        .map((fb) => `<a href="/dashboard/symbols/${encodeURIComponent(fb)}/edit">${esc(fb)}</a>`)
        .join('/')}</span>`,
    )
  }
  const noteHtml = notes.length
    ? `<div class="muted" style="font-size:11px;margin-top:2px">${notes.join(' / ')}</div>`
    : ''
  return `${roleBadge}${noteHtml}`
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
  // stop/TP override は DB に fraction 保存、表示は % (×100、stop は符号付き)。
  const stopPctOverrideValue =
    row?.stopPctOverride === null || row?.stopPctOverride === undefined
      ? ''
      : String(Math.round(row.stopPctOverride * 1000) / 10)
  const takeProfitPctOverrideValue =
    row?.takeProfitPctOverride === null || row?.takeProfitPctOverride === undefined
      ? ''
      : String(Math.round(row.takeProfitPctOverride * 1000) / 10)
  // 持ち越し設定は radio 2 択で両状態を明示する (「持ち越し」ラベル + 「持ち越さ
  // ない」checkbox の二重否定が ON/OFF どちらか読めない、という operator 指摘)。
  const intradayOnlyChecked = row?.intradayOnly ? ' checked' : ''
  // role / entry override (#452)。pullback / trend / 過伸長は
  // DB に fraction 保存、表示は % (×100)。ATR 比は ratio 生値。
  // 不正 role 値 (enum 外の DB 直書き) の fail-closed をフォームで弱めない
  // (CodeRabbit #453): 一致 option が無いと先頭 '' が選択され、保存で意図せず
  // 「未設定 = 従来挙動」へ silent に戻ってしまう。不正値はそのまま selected
  // option として出し、保存時は admin parse の enum 検証が 400 で弾く —
  // operator が明示的に正しい role を選び直すまで解除されない。
  const rawRoleValue = row?.role?.trim() ?? ''
  const roleIsKnown = rawRoleValue === '' || (SYMBOL_ROLES as readonly string[]).includes(rawRoleValue)
  const roleValue = rawRoleValue
  const pullbackMaxOverrideValue =
    row?.pullbackMaxOverride === null || row?.pullbackMaxOverride === undefined
      ? ''
      : String(Math.round(row.pullbackMaxOverride * 1000) / 10)
  const pullbackMinOverrideValue =
    row?.pullbackMinOverride === null || row?.pullbackMinOverride === undefined
      ? ''
      : String(Math.round(row.pullbackMinOverride * 1000) / 10)
  const minReturn50dOverrideValue =
    row?.minReturn50dOverride === null || row?.minReturn50dOverride === undefined
      ? ''
      : String(Math.round(row.minReturn50dOverride * 1000) / 10)
  const maxAtrRatioOverrideValue =
    row?.maxAtrRatioOverride === null || row?.maxAtrRatioOverride === undefined
      ? ''
      : String(row.maxAtrRatioOverride)
  const maxSma50DeviationPctOverrideValue =
    row?.maxSma50DeviationPctOverride === null || row?.maxSma50DeviationPctOverride === undefined
      ? ''
      : String(Math.round(row.maxSma50DeviationPctOverride * 1000) / 10)
  const requireAboveSma50OverrideValue =
    row?.requireAboveSma50Override === null || row?.requireAboveSma50Override === undefined
      ? ''
      : String(row.requireAboveSma50Override)
  // 条件連動配分 (#452 Layer 3)。
  const entryRequiredChecked = row?.entryRequired ? ' checked' : ''
  const alwaysActiveChecked = row?.alwaysActive ? ' checked' : ''
  const cashFallbackValue = row ? parseCashFallbacksJson(row.cashFallbackSymbols, row.symbol).join(', ') : ''
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
  // #460: edit モードは symbol 確定なので allowlist バッジを server 描画。
  const editAllowlistBadge =
    mode === 'edit'
      ? (() => {
          const badge = tradableBadgeHtml(args.tradableStatus ?? 'unknown')
          return badge
            ? `<div style="margin-top:6px">${badge}</div>`
            : `<div style="margin-top:6px"><span title="OpenAPI 取扱リスト (tradable/list) 在籍 — 発注可能" style="font-size:12px;color:#0e9f6e">✓ OpenAPI 取扱リスト在籍</span></div>`
        })()
      : ''
  const symbolField =
    mode === 'edit'
      ? // 値セルは必ず 1 要素 (div) に包む。複数の裸要素を出すと 2 列グリッドが
        // 1 セルずれて以降のラベル/値が全部崩れる (#layout)。
        `<div>
           <input type="text" name="symbol" value="${esc(symbolValue)}" readonly style="padding:6px;background:#eee">
           ${editAllowlistBadge}
           <p class="muted" style="margin:4px 0 0;font-size:11px">symbol は immutable です。変更したい場合は一度削除して再追加してください。</p>
         </div>`
      : `<div>
           <div style="position:relative;display:inline-block">
             <input type="text" name="symbol" id="symbol-form-symbol" value="${esc(symbolValue)}" required maxlength="10" pattern="[A-Za-z0-9]{1,10}" placeholder="SOXL / 7974 / 1570" autocomplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" oninput="window.searchSymbolSuggest(this.value)" onfocus="window.searchSymbolSuggest(this.value)" onblur="setTimeout(window.hideSymbolSuggest, 200)" style="padding:6px;width:200px;text-transform:uppercase">
             <ul id="symbol-form-symbol-suggest" style="display:none;position:absolute;top:100%;left:0;margin:2px 0 0;padding:0;list-style:none;background:#fff;border:1px solid #d0d0d5;border-radius:4px;width:380px;max-height:280px;overflow-y:auto;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.1)"></ul>
           </div>
           <span id="symbol-tradability" style="margin-left:10px;font-size:13px"></span>
           <div id="symbol-allowlist" style="margin-top:4px;font-size:12px"></div>
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
  // セクション開閉の初期状態: 値が入っている (= 編集で触った) セクションだけ開く。
  // 不正 role の警告はユーザーが見るべきなので強制 open。
  const hasSizingValues = maxNotionalValue !== '' || budgetAllocPctValue !== ''
  const hasStrategyValues =
    pullbackMaxOverrideValue !== '' ||
    pullbackMinOverrideValue !== '' ||
    minReturn50dOverrideValue !== '' ||
    maxAtrRatioOverrideValue !== '' ||
    maxSma50DeviationPctOverrideValue !== '' ||
    requireAboveSma50OverrideValue !== ''
  const hasExitValues =
    timeStopDaysOverrideValue !== '' ||
    kAtrOverrideValue !== '' ||
    stopPctOverrideValue !== '' ||
    takeProfitPctOverrideValue !== '' ||
    intradayOnlyChecked !== ''
  const hasAllocValues =
    entryRequiredChecked !== '' || alwaysActiveChecked !== '' || cashFallbackValue !== ''
  // 必須バッジ。任意 field は無印 (バッジだらけにしない)。
  const REQ =
    '<span style="display:inline-block;padding:0 6px;border-radius:8px;background:#fdecec;color:#c22;font-size:10px;font-weight:700;margin-left:4px;vertical-align:middle">必須</span>'
  const fieldGrid = 'display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center'
  const optSection = (title: string, hint: string, inner: string, open: boolean): string =>
    `<details${open ? ' open' : ''} style="border:1px solid #e3e3e8;border-radius:10px;background:#fff">
      <summary style="cursor:pointer;padding:10px 14px;font-size:13px;font-weight:600">${title} <span class="muted" style="font-size:11px;font-weight:normal">— ${hint} (任意)</span></summary>
      <div style="padding:2px 14px 14px;${fieldGrid}">${inner}</div>
    </details>`

  return `<h2 style="font-size:16px;margin:8px 0 12px">${heading}</h2>
  ${errBlock}
  <form method="post" action="${esc(action)}" style="max-width:680px;display:flex;flex-direction:column;gap:12px">
    ${modeSelector}
    <div style="border:1px solid #e3e3e8;border-radius:10px;background:#fff;padding:12px 14px">
      <div style="font-size:13px;font-weight:600;margin-bottom:2px">基本 <span class="muted" style="font-size:11px;font-weight:normal">— ${REQ} 以外は空欄で global 設定を使用</span></div>
      <div style="${fieldGrid}">
        <label>銘柄${REQ}</label>${symbolField}
        ${inverseField}
        <label>銘柄名</label>
        <input type="text" name="name" id="symbol-form-name" value="${esc(nameValue)}" maxlength="256" placeholder="Yahoo 選択で自動入力" style="padding:6px">
        <label>市場${REQ}</label>
        <select name="market" id="symbol-form-market" required style="padding:6px" onchange="window.syncSymbolFormCurrencyFromMarket(this.value)">
          <option value="US"${marketValue === 'US' ? ' selected' : ''}>US (米国)</option>
          <option value="JP"${marketValue === 'JP' ? ' selected' : ''}>JP (日本)</option>
        </select>
        <label>通貨${REQ}</label>
        <select name="currency" id="symbol-form-currency" required style="padding:6px;max-width:200px" onchange="window.syncSymbolFormCurrencyUnits(this.value)">
          <option value="USD"${currencyValue === 'USD' ? ' selected' : ''}>USD (米ドル)</option>
          <option value="JPY"${currencyValue === 'JPY' ? ' selected' : ''}>JPY (日本円)</option>
        </select>
        <label>売買単位${REQ}</label>
        <div>
          <input type="number" name="lot_size" id="symbol-form-lot-size" value="${esc(lotSizeValue)}" required step="1" min="1" max="100000" placeholder="JP 個別株=100 / ETF・US=1" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">株/口</span>
          <span id="symbol-form-lot-suggest" class="muted" style="font-size:11px;margin-left:6px"></span>
          <div class="muted" style="font-size:11px;margin-top:2px">未設定の銘柄は発注されません (fail-closed)</div>
        </div>
        <label>ロール${REQ}</label>
        <div style="flex:1 1 100%">
          <!-- #role-stats: select を廃止し、カードのギャラリー = ロール選択。クリックで
               選択 (hidden input に同期)、ホバーで画面右に大きいプレビュー (虚のチャート
               + 入場ゲート閾値、個別銘柄チャートタブの視覚言語を流用)。 -->
          <input type="hidden" name="role" id="symbol-form-role" value="${esc(roleValue)}">
          <div style="font-size:12px;margin-bottom:6px">選択中: <strong id="role-current" style="font-size:13px">—</strong></div>
          ${roleIsKnown ? '' : '<p class="err" style="margin:0 0 4px;font-size:11px">DB に enum 外の role 値が入っています。この銘柄の entry は抑止中 (fail-closed)。正しい role を選んで保存してください。</p>'}
          <!-- 2軸を構造で表現: タブ = 入場アーキ、タブ内のカード = 銘柄プロファイル。
               現状は「押し目」タブのみ有効。モメンタム/逆張りは設計中。 -->
          <div style="display:flex;gap:2px;border-bottom:1px solid #e3e3e8;margin-bottom:8px">
            <button type="button" class="role-arch-tab" data-arch="pullback" style="background:none;border:none;border-bottom:2px solid transparent;padding:6px 16px;font-size:13px;cursor:pointer">押し目</button>
            <button type="button" class="role-arch-tab" data-arch="momentum" style="background:none;border:none;border-bottom:2px solid transparent;padding:6px 16px;font-size:13px;cursor:pointer">モメンタム <span style="font-size:10px;color:#bbb">設計中</span></button>
            <button type="button" class="role-arch-tab" data-arch="reversion" style="background:none;border:none;border-bottom:2px solid transparent;padding:6px 16px;font-size:13px;cursor:pointer">逆張り <span style="font-size:10px;color:#bbb">設計中</span></button>
          </div>
          <div class="role-arch-panel" data-arch="pullback">
            <div id="role-gallery" style="display:flex;flex-wrap:wrap;gap:8px"></div>
          </div>
          <div class="role-arch-panel" data-arch="momentum" style="display:none">
            <div style="font-size:12px;color:#9a5b00;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:10px 12px;line-height:1.55;margin-bottom:8px">
              <strong>⚠ 要注意ロール(エッジ未検証)</strong> — 新高値ブレイクの継続を取る入場アーキ。選択・取引は可能ですが、
              <b>backtest 上、発注可能なテーマ ETF (ICLN/TAN/QCLN) では成績まちまち〜不良 (TAN -60%DD)</b>。広域/テック 1x では有効だがそれらは OpenAPI 発注不可。<b>1x 銘柄のみ</b>に付け、少額・DRY_RUN から。
            </div>
            <div id="momentum-gallery" style="display:flex;flex-wrap:wrap;gap:8px"></div>
          </div>
          <div class="role-arch-panel" data-arch="reversion" style="display:none">
            <div style="font-size:12px;color:#9a5b00;background:#fff4e5;border:1px solid #f0c98a;border-radius:8px;padding:12px 14px;line-height:1.6">
              <strong>⚠ 使用不可(見送り)</strong> — 売られすぎの反発を拾う入場アーキ(1x向け)。<br>
              理由: red-team 評価で <b>$ POC のコスト/為替でエッジ証明困難</b>＋ <b>逆張りに適した 1x(広域指数)が OpenAPI 取扱外</b>(発注可の ICLN/TAN 等はテーマ ETF で逆張り不適=ナイフ掴み)。<br>
              現状は見送り。再訪は universe 拡大 + notional 引き上げが前提。
            </div>
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px">cash_parking は BUY を生成しない / inverse_hedge は短期プリセット (time stop 5日)</div>
        </div>
        <!-- ホバー時に画面右へ出る大プレビュー (fixed)。 -->
        <div id="role-preview" style="display:none;position:fixed;right:16px;top:96px;width:300px;z-index:60;background:#fff;border:1px solid #d0d0d5;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,0.14);padding:10px 12px">
          <div id="role-preview-body"></div>
        </div>
        <script>
        (function () {
          // ROLE_RULE_PRESETS を global default に重ねた解決値 (%・日・倍)。
          var P = {
            leveraged_trend: { tr: 8, heat: 60, atr: 1.5, pbMax: -3, pbMin: -6, stop: -4, tp: 7, tstop: 10, katr: 2.0 },
            core_trend: { tr: 3, heat: 20, atr: 1.5, pbMax: -1.5, pbMin: -5, stop: -4, tp: 7, tstop: 10, katr: 2.0 },
            sector_trend: { tr: 4, heat: 30, atr: 1.5, pbMax: -2, pbMin: -5, stop: -4, tp: 7, tstop: 10, katr: 2.0 },
            low_volatility: { tr: 1.5, heat: 10, atr: 1.3, pbMax: -1, pbMin: -3, stop: -1.5, tp: 2.5, tstop: 15, katr: 2.0 },
            inverse_hedge: { tr: 15, heat: 40, atr: 1.5, pbMax: -3, pbMin: -6, stop: -4, tp: 7, tstop: 5, katr: 1.5 }
          };
          var COLOR = {
            core_trend: '#1a56db', leveraged_trend: '#d97706', sector_trend: '#0e9f9f',
            low_volatility: '#7e3af2', inverse_hedge: '#c22d2d', cash_parking: '#5b8c5a',
            momentum: '#b25000'
          };
          var LABEL = {
            leveraged_trend: 'レバETF・トレンド', core_trend: '非レバ・トレンド',
            sector_trend: 'セクター', low_volatility: '低ボラ',
            inverse_hedge: 'インバースヘッジ', cash_parking: '待機資金',
            momentum: 'モメンタム ⚠'
          };
          // 2軸の説明 (入場アーキ / horizon / 想定銘柄の性質)。現状は全ロール
          // 「押し目」アーキ。モメンタム/逆張りアーキは別軸で設計中 (未実装)。
          var DESC = {
            leveraged_trend: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~10日', character: '3x レバ ETF' },
            core_trend: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~10日', character: '1x トレンド' },
            sector_trend: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~10日', character: '1x セクター ETF' },
            low_volatility: { arch: '押し目 (上昇中の押し目買い)', horizon: '中期 ~15日', character: '低ボラ 1x' },
            inverse_hedge: { arch: '押し目 (下落レジームの inverse 押し目)', horizon: '超短 5日', character: '3x インバース' },
            cash_parking: { arch: 'entry なし', horizon: '—', character: '待機資金 (退避先・常時配分)' },
            momentum: { arch: 'モメンタム (新高値ブレイク継続)', horizon: '短期 3–7日', character: '1x モメンタム ⚠ backtest 未検証' }
          };
          var ORDER = ['leveraged_trend', 'core_trend', 'sector_trend', 'low_volatility', 'inverse_hedge', 'cash_parking'];
          function fmtPct(v) { return (v > 0 ? '+' : '') + v + '%'; }
          // 銘柄別 override 入力 (任意セクション) を読む。空 → null。
          var OV_NAMES = {
            tr: 'min_return_50d_override', heat: 'max_sma50_deviation_pct_override',
            atr: 'max_atr_ratio_override', pbMax: 'pullback_max_override',
            pbMin: 'pullback_min_override', stop: 'stop_pct_override',
            tp: 'take_profit_pct_override', tstop: 'time_stop_days_override', katr: 'k_atr_override'
          };
          function ovNum(name) {
            var el = document.getElementsByName(name)[0];
            if (!el) return null;
            var v = (el.value || '').trim();
            if (v === '') return null;
            var n = Number(v);
            return isFinite(n) ? n : null;
          }
          function ovSel(name) {
            var el = document.getElementsByName(name)[0];
            return el ? (el.value || '') : '';
          }
          // 実効値 = override ?? preset ?? (sma50 は global 既定 true)。
          function eff(role) {
            var b = P[role], r = {}, ov = {}, any = false;
            var keys = ['tr', 'heat', 'atr', 'pbMax', 'pbMin', 'stop', 'tp', 'tstop', 'katr'];
            for (var i = 0; i < keys.length; i++) {
              var k = keys[i], o = ovNum(OV_NAMES[k]);
              r[k] = (o == null) ? b[k] : o;
              ov[k] = o != null;
              if (o != null) any = true;
            }
            var sma = ovSel('require_above_sma50_override');
            r.sma50 = sma === '' ? true : (sma === 'true');
            ov.sma50 = sma !== '';
            if (sma !== '') any = true;
            ov.any = any;
            r.ov = ov;
            return r;
          }
          function omark(b) { return b ? ' <span style="color:#d97706;font-weight:700" title="この銘柄の override">*</span>' : ''; }
          // 価格ラダー SVG。p = 実効パラメータ。big=true で軸ラベル付き。
          function ladder(role, p, w, h, big) {
            if (role === 'cash_parking') {
              return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '"><text x="' + (w / 2) + '" y="' + (h / 2) + '" font-size="' + (big ? 12 : 10) + '" fill="#5b8c5a" text-anchor="middle">entry なし</text></svg>';
            }
            var color = COLOR[role], ov = p.ov || {};
            var em = (p.pbMax + p.pbMin) / 2, tp = em + p.tp, st = em + p.stop;
            // 縦軸は描画する全水準 (0% / TP / stop / 押し目バンド) に合わせて動的スケール。
            // 固定レンジ (+4%..-11%) だと override で押し目や stop を広げた時に SVG 枠外へ
            // はみ出し、下の入場ゲート文字に重なっていた (operator 指摘) ため。
            var hi = Math.max(0, tp, p.pbMax) + 2, lo = Math.min(st, p.pbMin) - 2;
            if (hi - lo < 6) { hi += 1; lo -= 1; }
            function y(pct) { return 12 + (hi - pct) * ((h - 24) / (hi - lo)); }
            var X0 = 14, X1 = big ? w - 70 : w - 12, a = [];
            a.push('<line x1="' + X0 + '" y1="' + y(0).toFixed(1) + '" x2="' + X1 + '" y2="' + y(0).toFixed(1) + '" stroke="#c4c8cd" stroke-width="1"/>');
            var zy = y(p.pbMax), zh = y(p.pbMin) - y(p.pbMax);
            a.push('<rect x="' + X0 + '" y="' + zy.toFixed(1) + '" width="' + (X1 - X0) + '" height="' + zh.toFixed(1) + '" fill="#f59e0b33" stroke="#f59e0b" stroke-width="0.8"/>');
            a.push('<circle cx="' + ((X0 + X1) / 2).toFixed(1) + '" cy="' + y(em).toFixed(1) + '" r="' + (big ? 3.2 : 2.6) + '" fill="' + color + '"/>');
            a.push('<line x1="' + X0 + '" y1="' + y(st).toFixed(1) + '" x2="' + X1 + '" y2="' + y(st).toFixed(1) + '" stroke="#c22d2d" stroke-width="1" stroke-dasharray="3,2"/>');
            a.push('<line x1="' + X0 + '" y1="' + y(tp).toFixed(1) + '" x2="' + X1 + '" y2="' + y(tp).toFixed(1) + '" stroke="#0e9f6e" stroke-width="1" stroke-dasharray="3,2"/>');
            if (big) {
              var lx = X1 + 4;
              var mz = (ov.pbMax || ov.pbMin) ? ' *' : '', ms = ov.stop ? ' *' : '', mt = ov.tp ? ' *' : '';
              a.push('<text x="' + lx + '" y="' + y(0).toFixed(1) + '" font-size="8" fill="#80868b" dominant-baseline="middle">高値 0%</text>');
              a.push('<text x="' + lx + '" y="' + (zy + zh / 2).toFixed(1) + '" font-size="8" fill="#b25000" dominant-baseline="middle">押し目 ' + p.pbMax + '〜' + p.pbMin + '%' + mz + '</text>');
              a.push('<text x="' + lx + '" y="' + y(st).toFixed(1) + '" font-size="8" fill="#c22d2d" dominant-baseline="middle">stop ' + fmtPct(p.stop) + ms + '</text>');
              a.push('<text x="' + lx + '" y="' + y(tp).toFixed(1) + '" font-size="8" fill="#0e9f6e" dominant-baseline="middle">TP ' + fmtPct(p.tp) + mt + '</text>');
            } else {
              a.push('<text x="' + X0 + '" y="' + (y(0) - 2).toFixed(1) + '" font-size="7" fill="#9aa0a6">高値0%</text>');
            }
            return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" style="overflow:visible">' + a.join('') + '</svg>';
          }
          function gateHtml(role, p) {
            if (role === 'cash_parking') return '<div style="color:#5b8c5a;font-size:11px">戦略 entry なし。条件未達時の<b>退避先</b>・<b>常時配分</b>枠 (pullback 判定なし)。</div>';
            var ov = p.ov || {}, g = [];
            g.push('<div style="font-weight:600;font-size:11px;margin-bottom:2px">入場ゲート(閾値)</div>');
            g.push('<div>トレンド &gt; ' + fmtPct(p.tr) + omark(ov.tr) + '</div>');
            g.push('<div>SMA50 ' + (p.sma50 ? '上抜け必須' : '上抜け不問') + omark(ov.sma50) + '</div>');
            g.push('<div>過熱(SMA50乖離) ≤ ' + fmtPct(p.heat) + omark(ov.heat) + '</div>');
            g.push('<div>ボラ(ATR比) ≤ ' + p.atr + '×' + omark(ov.atr) + '</div>');
            g.push('<div>押し目 ' + p.pbMax + '% 〜 ' + p.pbMin + '%' + omark(ov.pbMax || ov.pbMin) + '</div>');
            g.push('<div style="font-weight:600;margin:4px 0 2px">退場</div>');
            g.push('<div>損切 ' + fmtPct(p.stop) + ' / 利確 ' + fmtPct(p.tp) + omark(ov.stop || ov.tp) + '</div>');
            g.push('<div>保有上限 ' + p.tstop + '日 (損切ATR ' + p.katr + '×)' + omark(ov.tstop || ov.katr) + '</div>');
            return '<div style="font-size:11px;line-height:1.55">' + g.join('') + '</div>';
          }
          function cardHtml(role) {
            var color = COLOR[role] || '#5f6368';
            var d = DESC[role] || {};
            // カードはグラフ無し (ホバー右プレビューに虚チャートがある)。名前 +
            // 銘柄プロファイル + 保有 だけのコンパクト表示。
            var sub = role === 'cash_parking'
              ? (d.character || '')
              : (d.character || '') + ' ・ 保有' + P[role].tstop + '日';
            return '<div class="role-tpl-card" data-role="' + role + '" ' +
              'style="cursor:pointer;border:1px solid #e3e3e8;border-radius:8px;padding:8px 10px;background:#fff;min-width:150px">' +
              '<div style="font-size:12px;font-weight:600"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color + ';margin-right:5px"></span>' + LABEL[role] + '</div>' +
              '<div style="font-size:10px;color:#86868b;margin-top:2px">' + sub + '</div>' +
              '</div>';
          }
          var selected = ${JSON.stringify(roleValue)};
          var currentShown = selected;
          function labelOf(role) { return LABEL[role] || (role ? ('⚠ ' + role) : '未選択'); }
          // 4 つの説明 (ロール / 入場アーキ / horizon / 想定銘柄の性質)。
          function descHtml(role) {
            var d = DESC[role];
            if (!d) return '';
            function row(k, v) { return '<div style="display:flex;gap:6px"><span style="color:#86868b;min-width:62px">' + k + '</span><span>' + v + '</span></div>'; }
            return '<div style="font-size:11px;line-height:1.5;background:#f6f6f9;border-radius:6px;padding:5px 7px;margin-bottom:6px">' +
              row('入場アーキ', d.arch) + row('horizon', d.horizon) + row('想定銘柄', d.character) + '</div>';
          }
          function showPreview(role) {
            currentShown = role;
            var pv = document.getElementById('role-preview');
            var body = document.getElementById('role-preview-body');
            if (!pv || !body) return;
            if (role === 'momentum') {
              body.innerHTML = '<div style="font-size:13px;font-weight:700;margin-bottom:4px;color:' + COLOR.momentum + '">⚡ モメンタム ⚠</div>' +
                descHtml('momentum') +
                '<div style="font-size:11px;line-height:1.55">新高値ブレイクの継続を取る別戦略 (BreakoutMomentumStrategy)。' +
                'entry: トレンド+ 新高値ブレイク+ SMA50上+ 過熱でない。exit: stop -5% / TP +10% / 保有~7日。<br>' +
                '<span style="color:#c22;font-weight:600">⚠ backtest 未検証。発注可テーマETFでは成績不良の例あり (TAN -60%DD)。1x のみ・少額で。</span></div>';
              pv.style.display = '';
              return;
            }
            if (!role || (!P[role] && role !== 'cash_parking')) { pv.style.display = 'none'; return; }
            var color = COLOR[role] || '#5f6368';
            if (role === 'cash_parking') {
              body.innerHTML = '<div style="font-size:13px;font-weight:700;margin-bottom:4px;color:' + color + '">待機資金</div>' + descHtml(role) + ladder(role, {}, 280, 120, true) + '<div style="margin-top:6px">' + gateHtml(role, {}) + '</div>';
              pv.style.display = '';
              return;
            }
            var p = eff(role);
            var note = p.ov.any ? 'preset + この銘柄の override (* 印) を反映' : 'preset の姿 (override 未設定)';
            body.innerHTML =
              '<div style="font-size:13px;font-weight:700;margin-bottom:4px;color:' + color + '">' + LABEL[role] + '</div>' +
              descHtml(role) +
              ladder(role, p, 280, 150, true) +
              '<div style="margin-top:6px">' + gateHtml(role, p) + '</div>' +
              '<div style="font-size:10px;color:#aaa;margin-top:6px">直近高値=0% 基準・実効値の模式<br>' + note + '</div>';
            pv.style.display = '';
          }
          function highlight(role) {
            var cards = document.querySelectorAll('.role-tpl-card');
            for (var i = 0; i < cards.length; i++) {
              var r = cards[i].getAttribute('data-role'), on = r === role;
              cards[i].style.border = on ? ('2px solid ' + (COLOR[r] || '#06c')) : '1px solid #e3e3e8';
              cards[i].style.background = on ? '#fcfbf7' : '#fff';
              cards[i].style.boxShadow = on ? '0 1px 4px rgba(0,0,0,0.08)' : 'none';
            }
          }
          function pick(role) {
            selected = role;
            var inp = document.getElementById('symbol-form-role');
            if (inp) inp.value = role;
            var cur = document.getElementById('role-current');
            if (cur) cur.textContent = labelOf(role);
            highlight(role);
            showPreview(role);
          }
          function rerender() { showPreview(currentShown); }
          // momentum はグラフ無し (preset が押し目と別形)。名前 + 性質だけのカード。
          function momentumCardHtml() {
            var d = DESC.momentum || {};
            return '<div class="role-tpl-card" data-role="momentum" ' +
              'style="cursor:pointer;border:1px solid #f0c98a;border-radius:8px;padding:8px 10px;background:#fffaf2;min-width:150px">' +
              '<div style="font-size:12px;font-weight:600;color:' + COLOR.momentum + '">⚡ モメンタム</div>' +
              '<div style="font-size:10px;color:#9a5b00;margin-top:2px">' + (d.character || '') + ' ・ 保有~7日</div>' +
              '</div>';
          }
          function init() {
            var gallery = document.getElementById('role-gallery');
            if (!gallery) return;
            gallery.innerHTML = ORDER.map(cardHtml).join('');
            var mg = document.getElementById('momentum-gallery');
            if (mg) mg.innerHTML = momentumCardHtml();
            // gallery + momentum の全カードに listener を張る。
            var cards = document.querySelectorAll('.role-tpl-card');
            for (var i = 0; i < cards.length; i++) {
              (function (card) {
                var r = card.getAttribute('data-role');
                card.addEventListener('click', function () { pick(r); });
                card.addEventListener('mouseenter', function () { showPreview(r); });
              })(cards[i]);
            }
            // ホバーが外れたら選択中ロールのプレビューに戻す。
            gallery.addEventListener('mouseleave', function () { showPreview(selected); });
            // 銘柄別 override を編集したら実効プレビューを即更新。
            var names = ['min_return_50d_override', 'max_sma50_deviation_pct_override', 'max_atr_ratio_override', 'pullback_max_override', 'pullback_min_override', 'stop_pct_override', 'take_profit_pct_override', 'time_stop_days_override', 'k_atr_override', 'require_above_sma50_override'];
            for (var j = 0; j < names.length; j++) {
              var el = document.getElementsByName(names[j])[0];
              if (el) { el.addEventListener('input', rerender); el.addEventListener('change', rerender); }
            }
            // 入場アーキのタブ切替 (押し目=有効、モメンタム/逆張り=設計中パネル)。
            function setArchTab(arch) {
              var tabs = document.querySelectorAll('.role-arch-tab');
              for (var t = 0; t < tabs.length; t++) {
                var a = tabs[t].getAttribute('data-arch'), on = a === arch;
                tabs[t].style.borderBottom = on ? '2px solid #06c' : '2px solid transparent';
                tabs[t].style.color = on ? '#06c' : '#5f6368';
                tabs[t].style.fontWeight = on ? '600' : 'normal';
              }
              var panels = document.querySelectorAll('.role-arch-panel');
              for (var q = 0; q < panels.length; q++) {
                panels[q].style.display = panels[q].getAttribute('data-arch') === arch ? '' : 'none';
              }
            }
            var tabs = document.querySelectorAll('.role-arch-tab');
            for (var k = 0; k < tabs.length; k++) {
              (function (tab) {
                tab.addEventListener('click', function () { setArchTab(tab.getAttribute('data-arch')); });
              })(tabs[k]);
            }
            setArchTab(selected === 'momentum' ? 'momentum' : 'pullback');
            var cur = document.getElementById('role-current');
            if (cur) cur.textContent = labelOf(selected);
            highlight(selected);
            showPreview(selected);
          }
          if (document.readyState !== 'loading') init();
          else document.addEventListener('DOMContentLoaded', init);
        })();
        </script>
        <label>状態</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="hidden" name="active" value="false">
          <input type="checkbox" name="active" value="true"${activeChecked}> 取引対象として有効
        </label>
      </div>
    </div>

    ${optSection(
      '発注サイズ',
      '1 注文の上限と配分',
      `<label>1注文上限</label>
        <div>
          <input type="number" name="max_notional" value="${esc(maxNotionalValue)}" step="0.01" min="0.01" placeholder="空欄 = global 上限" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px"><span id="symbol-form-max-notional-unit">${esc(currencyValue)}</span> / 1 発注 (global: <code>max_order_notional_<span id="symbol-form-max-notional-global-key">${currencyValue.toLowerCase()}</span></code>)</span>
        </div>
        <label>予算配分</label>
        <div>
          <input type="number" name="budget_alloc_pct" value="${esc(budgetAllocPctValue)}" step="0.1" min="0.1" max="100" placeholder="空欄 = risk-% sizing" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% — 口座総額(円) × この % で発注</span>
        </div>`,
      hasSizingValues,
    )}

    ${optSection(
      '戦略ロール・entry 条件',
      'role プリセットと entry gate の銘柄別調整',
      `<label>押し目バンド</label>
        <div>
          <input type="number" name="pullback_max_override" value="${esc(pullbackMaxOverrideValue)}" step="0.1" min="-100" max="0" placeholder="浅い側 (例 -3)" style="padding:6px;width:130px">
          〜
          <input type="number" name="pullback_min_override" value="${esc(pullbackMinOverrideValue)}" step="0.1" min="-100" max="0" placeholder="深い側 (例 -6)" style="padding:6px;width:130px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (浅い側 ≥ 深い側)</span>
        </div>
        <label>トレンド条件</label>
        <div>
          <input type="number" name="min_return_50d_override" value="${esc(minReturn50dOverrideValue)}" step="0.1" min="-100" max="1000" placeholder="空欄 = preset / global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (20日騰落率の下限)</span>
        </div>
        <label>ボラ過熱上限</label>
        <div>
          <input type="number" name="max_atr_ratio_override" value="${esc(maxAtrRatioOverrideValue)}" step="0.1" min="0.1" max="10" placeholder="空欄 = preset / global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">× baseline ATR</span>
        </div>
        <label>過伸長上限</label>
        <div>
          <input type="number" name="max_sma50_deviation_pct_override" value="${esc(maxSma50DeviationPctOverrideValue)}" step="0.1" min="0.1" max="1000" placeholder="空欄 = preset / global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (SMA50 上方乖離)</span>
        </div>
        <label>SMA50 上抜け</label>
        <select name="require_above_sma50_override" style="padding:6px;max-width:240px">
          <option value=""${requireAboveSma50OverrideValue === '' ? ' selected' : ''}>global default に従う</option>
          <option value="true"${requireAboveSma50OverrideValue === 'true' ? ' selected' : ''}>必須 (price &gt; SMA50)</option>
          <option value="false"${requireAboveSma50OverrideValue === 'false' ? ' selected' : ''}>不要</option>
        </select>
        `,
      hasStrategyValues,
    )}

    ${optSection(
      '損切・利食・保有',
      'exit 系の銘柄別調整',
      `<label>保有上限</label>
        <div>
          <input type="number" name="time_stop_days_override" value="${esc(timeStopDaysOverrideValue)}" step="1" min="1" max="365" placeholder="${esc(timeStopPlaceholder)}" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">営業日</span>
        </div>
        <label>ATR stop 倍率</label>
        <div>
          <input type="number" name="k_atr_override" value="${esc(kAtrOverrideValue)}" step="0.1" min="0.5" max="5.0" placeholder="${esc(kAtrPlaceholder)}" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">× ATR20</span>
        </div>
        <label>損切ライン</label>
        <div>
          <input type="number" name="stop_pct_override" value="${esc(stopPctOverrideValue)}" step="0.1" min="-99" max="-0.1" placeholder="空欄 = global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (負値)。exit は max(この%, kAtr×ATR) の広い方</span>
        </div>
        <label>利食ライン</label>
        <div>
          <input type="number" name="take_profit_pct_override" value="${esc(takeProfitPctOverrideValue)}" step="0.1" min="0.1" max="100" placeholder="空欄 = global" style="padding:6px;width:180px">
          <span class="muted" style="font-size:12px;margin-left:6px">% (正値)</span>
        </div>
        <label>持ち越し</label>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:13px">
          <label style="display:flex;align-items:center;gap:6px">
            <input type="radio" name="intraday_only" value="false"${intradayOnlyChecked === '' ? ' checked' : ''}> 持ち越す <span class="muted" style="font-size:12px">(スイング — 既定)</span>
          </label>
          <label style="display:flex;align-items:center;gap:6px">
            <input type="radio" name="intraday_only" value="true"${intradayOnlyChecked}> 持ち越さない <span class="muted" style="font-size:12px">(デイトレ — US 引け前に強制クローズ)</span>
          </label>
        </div>`,
      hasExitValues,
    )}

    ${optSection(
      '配分の条件連動',
      'entry 判定と予算配分の連動 (#452)',
      `<label>条件連動</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="hidden" name="entry_required" value="false">
          <input type="checkbox" name="entry_required" value="true"${entryRequiredChecked}> entry 判定 (ENTRY/HALF) 通過時のみ実配分を有効化
        </label>
        <label>常時配分</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px">
          <input type="hidden" name="always_active" value="false">
          <input type="checkbox" name="always_active" value="true"${alwaysActiveChecked}> 判定に関わらず常時 target = active (待機資金 ETF 用)
        </label>
        <label>退避先</label>
        <div>
          <input type="text" name="cash_fallback_symbol" value="${esc(cashFallbackValue)}" maxlength="60" placeholder="例: SGOV, USMV (複数は等分割)" style="padding:6px;width:240px;text-transform:uppercase">
          <span class="muted" style="font-size:12px;margin-left:6px"><strong>条件連動 ON のときのみ有効</strong>。同一通貨のみ。自動発注は flag (default off) を on にするまで無し</span>
        </div>`,
      hasAllocValues,
    )}

    <div style="border:1px solid #e3e3e8;border-radius:10px;background:#fff;padding:12px 14px;${fieldGrid}">
      <label>メモ</label>
      <textarea name="notes" maxlength="256" rows="2" placeholder="自由記述 (例: 一時停止理由)" style="padding:6px;font-family:inherit">${esc(notesValue)}</textarea>
    </div>

    <div style="display:flex;gap:8px">
      <button type="submit" id="symbol-form-save" style="padding:8px 24px;background:#06c;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">保存</button>
      <a href="/dashboard/symbols" style="padding:8px 24px;text-decoration:none;border:1px solid #d0d0d5;border-radius:6px;font-size:13px">キャンセル</a>
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
      window.checkSymbolTradability();
    };
    // 取扱チェック (#461): 銘柄確定時に Preview Order (発注なし) で Webull JP の
    // 取引可否を照会。'denied' (TICKER_IS_DENY 確定) のみ保存をブロックする。
    // 'error' / 'unavailable' はブロックしない — check 不能で登録が全部止まるのは
    // 過剰 fail-closed (発注側には #460 の事後ガードがある)。
    window._tradabilityDenied = false;
    window._tradabilitySeq = 0;
    window.checkSymbolTradability = function () {
      var statusEl = document.getElementById('symbol-tradability');
      var saveBtn = document.getElementById('symbol-form-save');
      var symInput = document.getElementById('symbol-form-symbol');
      var marketSel = document.getElementById('symbol-form-market');
      if (!statusEl || !symInput) return;
      var sym = (symInput.value || '').trim().toUpperCase();
      window._tradabilityDenied = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
      var allowElEarly = document.getElementById('symbol-allowlist');
      if (!/^[A-Z0-9]{1,10}$/.test(sym)) { statusEl.textContent = ''; if (allowElEarly) allowElEarly.textContent = ''; return; }
      var mySeq = ++window._tradabilitySeq;
      statusEl.textContent = '⏳ 取扱確認中...';
      statusEl.style.color = '#86868b';
      var market = marketSel && marketSel.value === 'JP' ? 'JP' : 'US';
      fetch('/admin/symbol-config/tradability-check?symbol=' + encodeURIComponent(sym) + '&market=' + market, { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (mySeq !== window._tradabilitySeq) return; // 古い応答は捨てる
          // instrument 照会 (#475) のフラグ要約。verdict 行の後ろに添える。
          var instSuffix = '';
          if (res.instrument) {
            var chips = [];
            if (res.instrument.overnightTradingSupported === true) chips.push('24h取引対応');
            if (res.instrument.shortable === true) chips.push('空売り可');
            var lev = Number(res.instrument.etfLeveragedFactor);
            if (Number.isFinite(lev) && lev !== 0) chips.push('レバレッジ ' + (lev > 0 ? '+' : '') + lev + 'x' + (res.instrument.inverseEtf === true ? ' / インバース' : ''));
            if (chips.length > 0) instSuffix = ' ｜ ' + chips.join(' ・ ');
          }
          // #460: OpenAPI allowlist (tradable/list)。instrument status (OC) では
          // 区別できない deny を区別できる唯一の事前シグナルなので別行で強調する。
          var allowEl = document.getElementById('symbol-allowlist');
          if (allowEl) {
            if (res.allowlist === 'tradable') {
              allowEl.textContent = '✓ OpenAPI 取扱リスト在籍 (発注可能)';
              allowEl.style.color = '#0e9f6e';
            } else if (res.allowlist === 'disappeared') {
              allowEl.textContent = '⚠ OpenAPI 取扱リストから消失 (取扱停止の可能性)';
              allowEl.style.color = '#9a5b00';
            } else {
              allowEl.textContent = '⚠ OpenAPI 取扱リスト未登録 — アプリで売買できても OpenAPI 経由では発注で弾かれる可能性';
              allowEl.style.color = '#6e6e73';
            }
          }
          if (res.verdict === 'denied') {
            var why = res.reason === 'known_deny' ? '過去に Webull が発注拒否'
              : res.reason === 'invalid_symbol' ? 'Webull に存在しない銘柄'
              : res.reason === 'not_listed' ? 'Webull の銘柄マスタに不存在'
              : res.reason === 'instrument_status' ? '取引停止中の銘柄 (status CO/NT)'
              : 'Webull JP 取扱なし';
            statusEl.textContent = '❌ ' + why + ' — 登録できません';
            statusEl.style.color = '#c22';
            window._tradabilityDenied = true;
            if (saveBtn) { saveBtn.disabled = true; saveBtn.style.opacity = '0.4'; }
          } else if (res.reason === 'quote_ok') {
            // instrument status=OC でも発注 deny は事前検証不可 (USMV 前例) ので
            // ✅ は出さない
            var head = res.instrument && res.instrument.status === 'OC'
              ? '△ status OC (取引可) + 見積もり可 — 発注 deny のみ未保証'
              : '△ 見積もり可 — 発注可否は未保証 (Webull アプリで確認)';
            statusEl.textContent = head + instSuffix;
            statusEl.style.color = '#b25000';
          } else {
            statusEl.textContent = '❓ 確認不可 (登録は可能)';
            statusEl.style.color = '#86868b';
          }
        })
        .catch(function () {
          if (mySeq !== window._tradabilitySeq) return;
          statusEl.textContent = '❓ 取扱を確認できませんでした (登録は可能)';
          statusEl.style.color = '#86868b';
        });
    };
    // 手入力で symbol を変えた場合も blur で再チェック。submit は denied 時に阻止。
    (function () {
      var symInput = document.getElementById('symbol-form-symbol');
      if (symInput && !symInput.readOnly) {
        symInput.addEventListener('change', function () { window.checkSymbolTradability(); });
        var form = symInput.closest('form');
        if (form) {
          form.addEventListener('submit', function (ev) {
            if (window._tradabilityDenied) {
              ev.preventDefault();
              var statusEl = document.getElementById('symbol-tradability');
              if (statusEl) statusEl.textContent = '❌ Webull JP 取扱なし — 登録できません';
            }
          });
        }
      }
    })();
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
