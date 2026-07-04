import { Hono } from 'hono'
import { rateLimit } from '../../middleware/rateLimit'

import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadOverviewPanelsCsv, setOverviewPanels } from '../../infrastructure/db/globalConfigRepo'
import { resolveTradingEnabled } from '../../trading/runtime/killSwitch'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { loadInversePairs, loadPairRegimeConfigs } from '../../infrastructure/db/symbolConfigRepo'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import {
  getTradableStatusForSymbol,
  loadTradableAllowlist,
} from '../../infrastructure/db/tradableInstrumentsRepo'
import { strategyDecisionLog, tradeJournal } from '../../infrastructure/db/schema'
import { loadRecentAudit, type LoadAuditOptions } from '../../infrastructure/db/configAuditLog'
import {
  loadRecentAlerts,
  type LoadAlertOptions,
} from '../../infrastructure/notification/notificationEmitLog'
import { loadVixRegimeSnapshot } from '../../infrastructure/notification/vixRegimeChange'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import { buildBuyabilityView } from '../../trading/strategy/entryDistance'
import {
  deriveEntryStatus,
  deriveEntryStatusFromIndicators,
  type EntryStatus,
} from '../../trading/strategy/entryStatus'
import { buildSymbolRules } from '../../trading/strategy/symbolRuleResolution'
import { evaluatePairRegime, type PairRegimeDecision } from '../../trading/strategy/pairRegime'
import { computeConditionalAllocation } from '../../trading/strategy/conditionalAllocation'
import type { SymbolRule } from '../../trading/strategy/strategies/PullbackUptrendStrategy'
import { and, asc, desc, eq } from 'drizzle-orm'
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
import { extractActor } from '../../infrastructure/db/configAuditLog'
// #21 Phase B follow-up: Webull token 管理 UI (seed / status / refresh)。
// admin/webull-token は JSON API、こちらは HTML form + redirect で operator が
// browser から完結できるようにする (DevTools fetch を強要しない)。
import { refreshWebullToken } from '../../infrastructure/webull/refreshWebullToken'
import { WebullAuth } from '../../infrastructure/webull/WebullAuth'
import { WebullTokenClient } from '../../infrastructure/webull/WebullTokenClient'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { clampLimit, jsonPretty, messageOf, parseCursor, unavailable } from './shared'
import { type DashboardBindings, loadKillSwitchState, renderAnalysisSubnav, renderLayout } from './layout'
import { extractTokenFromPaste, renderWebullTokenBody } from './webullToken'
import { brokerProbeBody } from './brokerProbe'
import { ALL_OVERVIEW_PANELS, type OverviewData, loadRecentFills, overviewBody, parseOverviewPanels } from './overview'
import { buildPositionsPacket, loadLatestStrategyPrices, loadPositionsPageData, positionsBody } from './positions'
import { parseEquityRange, portfolioBody, safeLoadPortfolioSnapshots } from './portfolio'
import { buildTradesPacket, loadTradeJournalRows, parseTradesQuery, tradesBody } from './trades'
import { configBody } from './config'
import { aggregateReasonTrend, buildDecisionMatrix, cronBody, cronDecisionJson, decisionMatrixBody, loadDecisionMatrix, loadDecisionRows } from './cron'
import { alertsBody, clampAlertLimit, parseAlertsQuery, parseEventTypeFilter, parseSeverityFilter } from './alerts'
import { auditBody, clampAuditLimit, parseAuditDateFilter, trimQuery } from './audit'
import { type StrategyParamsSnapshot, computeZoomRange, parseChartsTab, parseIsoTimestamp, renderChartsSubnav, strategyParamsFromGlobal } from './charts/shared'
import { type SymbolChartRules, buildSymbolChartPacket, loadAllSymbolCharts, loadSymbolChart, pickDefaultSymbol } from './charts/loaders'
import { type EquityTradeMarker, computeMonthlyReturns, computePeriodReturns, loadEquityCurve, loadEquityTradeMarkers } from './charts/equity'
import { loadBenchmarkSeries } from './charts/benchmark'
import { computePnlHistogram, computeTradeStats, loadDecisionBreakdown, loadTradePnls } from './charts/quality'
import { chartsBody, sortGridChartsByEntryPriority } from './charts/grid'
import { type SymbolsListFilter, findSymbolConfigForView, loadAllSymbolConfigRows, symbolFormBody, symbolMapEditorBody, symbolsListBody } from './symbols'
import { type EventsEarningsFormEcho, type EventsMacroFormEcho, eventsBody, eventsDisplayRange, loadEarningsInRange, renderEventsWithError, renderEventsWithNotice, validateEarningsForm, validateMacroForm, writeEventsAuditLog } from './events'
export { safeJsonScript } from './shared'
export { extractTokenFromPaste } from './webullToken'
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
export { aggregateDailyCloses, anchorJstMidnight, computeChartWindowDays, computeLinearRegressionLine, computeRollingSma, densifyHorizontalLine, densifyTrendLine, deriveOpenPosition, extractSma50, fetchYahooBarsForChart, loadAllSymbolCharts, loadSymbolChart, mergeYahooAndCronPoints, pairClosedTrades, pickDefaultSymbol, resolveFillSide, selectLatestCronSnapshot } from './charts/loaders'
export type { ClosedTradeSpan, OhlcBar, PivotPoint, SymbolChartData, SymbolChartDecision, SymbolChartMarker, SymbolChartPoint, SymbolChartPosition, SymbolChartRules, TrendLineSegment } from './charts/loaders'
export { buildOverviewChartData, computeEquitySeries, computeMonthlyReturns, computePeriodReturns, loadEquityCurve, loadEquityTradeMarkers, renderPeriodReturnsTable } from './charts/equity'
export type { EquityPoint, EquityTradeMarker, MonthlyReturn, OverviewChartData, PeriodReturn } from './charts/equity'
export { EQUITY_BENCHMARK_SYMBOL, loadBenchmarkSeries, toBenchmarkReturns } from './charts/benchmark'
export type { BenchmarkPoint } from './charts/benchmark'
export { aggregateDecisionRows, computePnlHistogram, computeTradeStats, loadDecisionBreakdown, loadTradePnls } from './charts/quality'
export type { DecisionBreakdownPoint, PnlHistogramBin, TradeStats } from './charts/quality'
export { prevDailyClose, renderAllocationLine, renderBuyabilityPanel, renderDecisionPlotCaption, renderPairRegimeLine, renderPriceHeader, renderStrategyParamsPanel, renderSymbolPolicyLine, renderSymbolTab } from './charts/symbol'
export type { BuyabilityPanelContext } from './charts/symbol'
export { renderGridTab, sortGridChartsByEntryPriority } from './charts/grid'
export { assignPairColors, computeBudgetUsage, orderRowsByPair, pairRoles, renderSymbolRoleCell, symbolMapEditorBody } from './symbols'

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
      const [panelsCsv, portfolio, snapshots, sparkSnapshots, usdJpy, positions, strategyPriceMap, recentTrades, vixRegime, global] =
        await Promise.all([
          loadOverviewPanelsCsv(db),
          c.env.PORTFOLIO_STATE
            ? new PortfolioStateClient(c.env.PORTFOLIO_STATE).getPortfolio().catch(() => null)
            : Promise.resolve(null),
          safeLoadPortfolioSnapshots(c.env.DB, range),
          // 資産サマリ帯のスパークラインは range 指定と独立に直近 30 日固定。
          safeLoadPortfolioSnapshots(c.env.DB, '30d'),
          // USDJPY は資産サマリ帯表示用。DO 不在 (帯を出さない) なら fetch 自体を省略。
          c.env.PORTFOLIO_STATE
            ? loadUsdJpyRate().catch(() => null)
            : Promise.resolve(null),
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
        sparkSnapshots,
        usdJpy,
        symbolStateBound: symbolClient !== null,
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
    // loader は /positions/json と共用 (#dashboard-json-api) — 「画面で見る内容 =
    // AI に渡す JSON」を同一の取得結果から作る。
    const data = await loadPositionsPageData(c.env)
    return c.html(
      renderLayout(c, 'ポートフォリオ', positionsBody(data.rows, data.strategyPriceMap, data.universe)),
    )
  })
  /**
   * positions の JSON export (#dashboard-json-api)。read-only GET のみ。
   * schema / envelope 規約は shared.ts の `exportMeta` docstring 参照。
   */
  .get('/positions/json', async (c) => {
    if (!c.env.DB || !c.env.SYMBOL_STATE) {
      return jsonPretty(
        { error: 'binding_not_configured', message: 'DB or SYMBOL_STATE binding is not configured' },
        503,
      )
    }
    try {
      return jsonPretty(buildPositionsPacket(await loadPositionsPageData(c.env)))
    } catch (err) {
      return jsonPretty({ error: 'positions_json_export_failed', message: messageOf(err) }, 500)
    }
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
      return c.html(renderLayout(c, '約定履歴', unavailable('DB not bound'), renderAnalysisSubnav('trades')))
    }
    // クエリ解釈 + journal query は /trades/json と共用 (#dashboard-json-api)。
    const q = parseTradesQuery((key) => c.req.query(key))
    const db = createDb(c.env.DB)
    // universe を並行 load して銘柄表示を「番号-会社名」(JP) に整形。
    // load 失敗時は `null` を tradesBody に渡し、symbol そのまま表示で fallback。
    const [rows, universe] = await Promise.all([
      // hasMore 判定のため 1 行余分に取る (limit + 1)。
      loadTradeJournalRows(db, { ...q, limit: q.limit + 1 }),
      loadSymbolUniverse(c.env).catch(() => null),
    ])
    const hasMore = rows.length > q.limit
    if (hasMore) rows.pop()
    return c.html(
      renderLayout(
        c,
        '約定履歴',
        tradesBody(rows, q.limit, universe, q.view, q.before, hasMore, {
          symbol: q.symbol,
          clientOrderId: q.clientOrderId,
        }),
        renderAnalysisSubnav('trades'),
      ),
    )
  })
  /**
   * trades の JSON export (#dashboard-json-api)。SSR と同じクエリ解釈 + 同じ
   * journal query を通し、rows は trade_journal の row そのまま返す。
   */
  .get('/trades/json', async (c) => {
    if (!c.env.DB) {
      return jsonPretty({ error: 'db_not_bound', message: 'DB binding is not configured' }, 503)
    }
    const q = parseTradesQuery((key) => c.req.query(key))
    try {
      const rows = await loadTradeJournalRows(createDb(c.env.DB), q)
      return jsonPretty(buildTradesPacket(rows, q))
    } catch (err) {
      return jsonPretty({ error: 'trades_json_export_failed', message: messageOf(err) }, 500)
    }
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
  /**
   * チャート銘柄タブの JSON export (#dashboard-json-api)。SSR の symbol タブと
   * 同じ loader (`loadSymbolChart` + `loadDecisionRows`) / 同じ effective rule
   * (`strategyParamsFromGlobal` → `buildSymbolRules`) を通す。
   *
   * Hono の path マッチは完全一致なので理論上 `/charts` に食われないが、route は
   * 定義順マッチのため、将来 `/charts/:sub` 系が生えた時の取り違え事故を避けて
   * `/charts` より前に定義しておく (JSON が返ることはテストで担保)。
   */
  .get('/charts/symbol/json', async (c) => {
    if (!c.env.DB) {
      return jsonPretty({ error: 'db_not_bound', message: 'DB binding is not configured' }, 503)
    }
    const symbol = c.req.query('symbol')?.toUpperCase().trim()
    if (!symbol) {
      return jsonPretty({ error: 'symbol_required', message: 'query param ?symbol=X is required' }, 400)
    }
    try {
      const [universe, global] = await Promise.all([
        loadSymbolUniverse(c.env),
        loadGlobalConfigFrom(c.env, c.get('requestId')),
      ])
      // SSR symbol タブと同じ effective rule 解決 (global → role preset →
      // override)。SSR が universe 外 symbol を default symbol に差し替えるのと
      // 違い、こちらは要求 symbol をそのまま使う (未知 symbol は空チャートで
      // 返る — API 利用者には 404 より「空データ」の方が判別しやすい)。
      const defaultEntryRule: SymbolRule = strategyParamsFromGlobal(global)
      const effectiveRules = buildSymbolRules(defaultEntryRule, universe)
      const entryRule = effectiveRules[symbol] ?? defaultEntryRule
      const rules: SymbolChartRules = {
        pullbackMax: entryRule.pullbackMax,
        pullbackMin: entryRule.pullbackMin,
        stopPct: entryRule.stopPct,
        takeProfitPct: entryRule.takeProfitPct,
        timeStopDays: entryRule.timeStopDays,
      }
      const chart = await loadSymbolChart(c.env, symbol, rules)
      // 判定履歴は SSR と同じ loader / 同じ件数 (直近 30)。load 失敗 (migration
      // 未適用等) はチャート本体を巻き込まず空配列に落とす (SSR と同挙動)。
      const decisionRows = await loadDecisionRows(createDb(c.env.DB), { symbol, limit: 30 }).catch(
        () => [],
      )
      return jsonPretty(buildSymbolChartPacket(chart, decisionRows))
    } catch (err) {
      return jsonPretty({ error: 'chart_symbol_export_failed', message: messageOf(err) }, 500)
    }
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
        // マーカー load 失敗 (一時的 D1 エラー等) は equity curve 本体を
        // 巻き込まず空配列 fallback (マーカー無しで描画)。
        const [equity, tradeMarkers] = await Promise.all([
          loadEquityCurve(c.env.DB),
          loadEquityTradeMarkers(c.env.DB).catch(() => [] as EquityTradeMarker[]),
        ])
        // QQQ ベンチマークは Yahoo fetch (network 依存) なので route 側で行い、
        // `loadEquityCurve` は D1-pure を保つ。取得失敗は null → renderer が
        // series を省略して注記だけ出す (チャート自体は壊さない fail-graceful)。
        // 取得期間の先頭は equity / マーカー両方の最古日 (BUY だけで realized
        // PnL が未確定の初期期間にもベンチマーク線を伸ばすため)。
        const firstDates = [equity[0]?.date, tradeMarkers[0]?.date].filter(
          (d): d is string => d !== undefined,
        )
        const fromDate = firstDates.length > 0 ? [...firstDates].sort()[0]! : null
        const benchmark =
          equity.length > 0 && fromDate !== null
            ? await loadBenchmarkSeries(c.env, fromDate).catch(() => null)
            : null
        const now = new Date()
        return c.html(
          renderLayout(
            c,
            'チャート',
            chartsBody({
              tab,
              equity,
              tradeMarkers,
              benchmark,
              periodReturns: computePeriodReturns(equity, now),
              monthlyReturns: computeMonthlyReturns(equity),
            }),
            renderChartsSubnav(tab),
          ),
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
      // 組み立ては /charts/symbol/json と共用の helper に寄せる (#dashboard-json-api)。
      const globalParams: StrategyParamsSnapshot = strategyParamsFromGlobal(global)
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
  /**
   * 判断トレースマトリクス export (#PR-5)。`?view=matrix` と同じ packet を
   * `dashboard_cron_matrix_export.v1` envelope で返す (AI 相談 / 外部集計用)。
   */
  .get('/cron/matrix/json', async (c) => {
    if (!c.env.DB) {
      return jsonPretty({ error: 'db_not_bound', message: 'DB binding is not configured' }, 503)
    }
    try {
      const days = 30
      const rows = await loadDecisionMatrix(c.env.DB, days)
      const matrix = buildDecisionMatrix(rows)
      return jsonPretty({
        schema: 'dashboard_cron_matrix_export.v1',
        exportedAt: new Date().toISOString(),
        days,
        rowCount: matrix.rows.length,
        matrix,
      })
    } catch (err) {
      return jsonPretty({ error: 'cron_matrix_export_failed', message: messageOf(err) }, 500)
    }
  })
  .get('/cron', async (c) => {
    // subnav の active は一覧 / マトリクスで切替 (履歴・分析 subnav #dashboard-ia)。
    const cronSubnav = renderAnalysisSubnav(c.req.query('view') === 'matrix' ? 'matrix' : 'cron')
    if (!c.env.DB) {
      return c.html(renderLayout(c, '戦略判定', unavailable('DB not bound'), cronSubnav))
    }
    const limit = clampLimit(c.req.query('limit'))
    const before = parseCursor(c.req.query('before'))
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    // trades の「判定→」から飛んでくる注文単位の絞り込み (#nav-links)。
    const clientOrderIdFilter = c.req.query('clientOrderId')?.trim() || undefined
    // 判断トレースマトリクス (#PR-5)。symbol / clientOrderId フィルタは集計に
    // 使わない (URL に付いてきても壊れない) が、一覧へ戻る pill に伝搬させる。
    if (c.req.query('view') === 'matrix') {
      try {
        const days = 30
        const [matrixRows, universe] = await Promise.all([
          loadDecisionMatrix(c.env.DB, days),
          loadSymbolUniverse(c.env).catch(() => null),
        ])
        return c.html(
          renderLayout(
            c,
            '戦略判定',
            decisionMatrixBody(
              buildDecisionMatrix(matrixRows),
              aggregateReasonTrend(matrixRows),
              universe,
              { days, limit, symbolFilter },
            ),
            cronSubnav,
          ),
        )
      } catch (err) {
        return c.html(renderLayout(c, '戦略判定', unavailable(messageOf(err)), cronSubnav))
      }
    }
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
          cronSubnav,
        ),
      )
    } catch (err) {
      // migration 未適用 / 一時的な D1 エラーで 500 にせず unavailable に落とす
      // (CodeRabbit #132)。段階的デプロイ時の自己保護。
      return c.html(renderLayout(c, '戦略判定', unavailable(messageOf(err)), cronSubnav))
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
      return c.html(renderLayout(c, 'アラート', unavailable('DB not bound'), renderAnalysisSubnav('alerts')))
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
          renderAnalysisSubnav('alerts'),
        ),
      )
    } catch (err) {
      // 0012 migration 未適用 (= notification_emit_log テーブル無し) を
      // 500 にせず unavailable に落とす。段階的デプロイ時の自己保護。
      return c.html(renderLayout(c, 'アラート', unavailable(messageOf(err)), renderAnalysisSubnav('alerts')))
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
