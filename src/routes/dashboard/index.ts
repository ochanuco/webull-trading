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
import { loadRecentAudit, type LoadAuditOptions } from '../../infrastructure/db/configAuditLog'
import {
  loadRecentAlerts,
  type LoadAlertOptions,
} from '../../infrastructure/notification/notificationEmitLog'
import { loadVixRegimeSnapshot } from '../../infrastructure/notification/vixRegimeChange'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import { buildBuyabilityView } from '../../trading/strategy/entryDistance'
import { deriveEntryStatus } from '../../trading/strategy/entryStatus'
import { buildSymbolRules } from '../../trading/strategy/symbolRuleResolution'
import { evaluatePairRegime, type PairRegimeDecision } from '../../trading/strategy/pairRegime'
import type { SymbolRule } from '../../trading/strategy/strategies/PullbackUptrendStrategy'
import { eq } from 'drizzle-orm'
import { PortfolioStateClient } from '../../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../../trading/state/SymbolStateClient'
import { loadUsdJpyRate } from '../../infrastructure/quotes/fxRate'
import type { SymbolState } from '../../trading/state/types'
import { YahooBarClient } from '../../infrastructure/quotes/YahooBarClient'
// The dashboard owns its own form-POST handlers rather than forwarding to
// admin/seed, which is JSON-only (application/x-www-form-urlencoded can't
// reach it directly). A validation failure re-renders with the input echoed
// back, which a PRG redirect can't do.
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
// admin/webull-token is a JSON API; this HTML form + redirect lets an
// operator finish the whole flow from the browser without DevTools.
import { refreshWebullToken } from '../../infrastructure/webull/refreshWebullToken'
import { WebullAuth } from '../../infrastructure/webull/WebullAuth'
import { WebullTokenClient } from '../../infrastructure/webull/WebullTokenClient'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenState } from '../../trading/state/WebullTokenStateDO'
import { clampLimit, fmtJst, jsonPretty, messageOf, parseCursor, unavailable } from './shared'
import { type DashboardBindings, loadKillSwitchState, renderAnalysisSubnav, renderDiagSubnav, renderLayout } from './layout'
import { extractTokenFromPaste, renderWebullTokenBody } from './webullToken'
import { brokerProbeBody } from './brokerProbe'
import {
  ALL_OVERVIEW_PANELS,
  type HomeRunSignals,
  type OverviewData,
  type StopDistanceView,
  loadRecentFills,
  overviewBody,
  parseOverviewPanels,
} from './overview'
import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { buildPositionsPacket, loadLatestStrategyPrices, loadPositionsPageData } from './positions'
import { resolveStopDistance } from '../../trading/strategy/stopDistance'
import { parseEquityRange, safeLoadPortfolioSnapshots } from './portfolio'
import { buildTradesPacket, loadTradeJournalRows, parseTradesQuery, tradesBody } from './trades'
import { configBody } from './config'
import { cronBody, loadDecisionRows, loadDecisionRowsInSession, runCronJsonExport } from './cron'
import { alertsBody, clampAlertLimit, parseAlertsQuery, parseEventTypeFilter, parseSeverityFilter } from './alerts'
import { auditBody, clampAuditLimit, parseAuditDateFilter, trimQuery } from './audit'
import { type ChartsBodySymbol, type StrategyParamsSnapshot, computeZoomRange, parseChartsTab, parseIsoTimestamp, parseQualityPeriod, parseSymbolView, strategyParamsFromGlobal } from './charts/shared'
import { type SymbolChartRules, buildSymbolChartPacket, loadSymbolChart, pickDefaultSymbol } from './charts/loaders'
import { cachedDashboardJson } from './charts/dashboardBarsCache'
import { SYMBOL_CHART_CLIENT_SCRIPT, SYMBOL_CHART_CLIENT_SCRIPT_ETAG } from './charts/symbolChartScript'
import { type EquityTradeMarker, computeMonthlyReturns, computePeriodReturns, loadEquityCurve, loadEquityTradeMarkers } from './charts/equity'
import { loadBenchmarkSeries } from './charts/benchmark'
import { computeSymbolStats, computeTradeStats, filterTradePnlsByPeriod, loadSkipReasonBreakdown, loadTradePnls } from './charts/quality'
import { chartsBody, renderSymbolMainInner, renderSymbolTab } from './charts/symbol'
import { type SymbolsListFilter, findSymbolConfigForView, loadAllSymbolConfigRows, symbolFormBody, symbolMapEditorBody, symbolsListBody } from './symbols'
import { type EventsEarningsFormEcho, type EventsMacroFormEcho, eventsBody, eventsDisplayRange, loadEarningsInRange, renderEventsWithError, renderEventsWithNotice, validateEarningsForm, validateMacroForm, writeEventsAuditLog } from './events'
import { extendedHoursBody } from './extendedHours'
import { formatNyYmd } from '../../infrastructure/calendar/usMarketCalendar'
import {
  createExtendedHoursObservationDb,
  createExtendedHoursObservationRepo,
} from '../../infrastructure/db/extendedHoursObservationRepo'
import { lifecycleBody } from './lifecycle'
import { loadLifecycleReport } from '../../trading/analysis/lifecycleReport'
export { safeJsonScript } from './shared'
export { extractTokenFromPaste } from './webullToken'
export { ALL_OVERVIEW_PANELS, parseOverviewPanels } from './overview'
export { formatQuoteAsOf, pickFreshQuote } from './positions'
export { renderLastRolledCell } from './portfolio'
export { localizeReason, renderChartDecisionTrace } from './cron'
export type { DecisionRow } from './cron'
export { renderAlertFilterPills } from './alerts'
export { DEFAULT_ZOOM_WINDOW_MS, computeZoomRange, parseChartsTab, parseIsoTimestamp, parseQualityPeriod, parseSymbolView, renderZoomPresetButtons } from './charts/shared'
export type { ChartsBodySymbol, StrategyParamsSnapshot } from './charts/shared'
export { aggregateDailyCloses, anchorJstMidnight, computeChartWindowDays, computeLinearRegressionLine, computeRollingSma, densifyHorizontalLine, densifyTrendLine, deriveOpenPosition, extractSma50, fetchYahooBarsForChart, loadSymbolChart, mergeYahooAndCronPoints, pairClosedTrades, resolveFillSide, selectLatestCronSnapshot } from './charts/loaders'
export type { SymbolChartData, SymbolChartDecision, SymbolChartMarker, SymbolChartPoint, SymbolChartRules, TrendLineSegment } from './charts/loaders'
export { buildOverviewChartData, computeEquitySeries, computeMonthlyReturns, computePeriodReturns } from './charts/equity'
export type { EquityPoint } from './charts/equity'
export { toBenchmarkReturns } from './charts/benchmark'
export {
  aggregateSkipReasonRows,
  categorizeSkipReason,
  computeSymbolStats,
  computeTradeStats,
  filterTradePnlsByPeriod,
} from './charts/quality'
export type { TradePnlRow } from './charts/quality'
export { prevDailyClose, renderAllocationLine, renderBuyabilityPanel, renderConclusionValue, renderDecisionPlotCaption, renderEffectiveRuleChips, renderJudgmentSummaryGrid, renderLatestDecisionValue, renderPositionSummaryValue, renderPriceHeader, renderStrategyParamsPanel, renderSymbolPolicyLine, renderSymbolTab, renderSymbolViewSubnav } from './charts/symbol'
export { assignPairColors, computeBudgetUsage, orderRowsByPair, pairRoles, symbolMapEditorBody } from './symbols'

// overview/quality use the same review subnav as trades (one menu shape per
// screen instead of a charts-only one). The symbol tab gets none — its nav
// path is the symbol group + rail, not a subnav.
function chartsPageSubnav(tab: ReturnType<typeof parseChartsTab>): string {
  if (tab === 'overview') return renderAnalysisSubnav('equity')
  if (tab === 'quality') return renderAnalysisSubnav('quality')
  return ''
}

// There's no "acknowledged" concept yet, so the alert count for the last
// 24h stands in for "unread".
async function loadHomeRunSignals(db: D1Database): Promise<HomeRunSignals> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [cronRow, alertRows] = await Promise.all([
    db.prepare('SELECT timestamp FROM strategy_decision_log ORDER BY id DESC LIMIT 1').first<{
      timestamp: string
    }>(),
    db
      .prepare(
        "SELECT severity, COUNT(*) AS n FROM notification_emit_log WHERE timestamp >= ? AND severity IN ('critical','warning') GROUP BY severity",
      )
      .bind(since)
      .all<{ severity: string; n: number }>(),
  ])
  let alertCritical = 0
  let alertWarning = 0
  for (const r of alertRows.results ?? []) {
    if (r.severity === 'critical') alertCritical = Number(r.n) || 0
    if (r.severity === 'warning') alertWarning = Number(r.n) || 0
  }
  return { lastCronAt: cronRow?.timestamp ?? null, alertCritical, alertWarning }
}

async function loadActivityStats(
  db: D1Database,
): Promise<{ wins: number; losses: number; errors: number }> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN error_class IS NOT NULL THEN 1 ELSE 0 END) AS errors
       FROM trade_journal WHERE timestamp >= ?`,
    )
    .bind(since)
    .first<{ wins: number | null; losses: number | null; errors: number | null }>()
  return {
    wins: Number(row?.wins ?? 0) || 0,
    losses: Number(row?.losses ?? 0) || 0,
    errors: Number(row?.errors ?? 0) || 0,
  }
}

// A symbol absent from the result (no decision log row yet) is the
// caller's cue to fall back to a percentage-based stop.
async function loadLatestAtr20(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out
  const rows = await db
    .prepare(
      `SELECT symbol, indicators_json FROM strategy_decision_log
       WHERE id IN (SELECT MAX(id) FROM strategy_decision_log GROUP BY symbol)`,
    )
    .all<{ symbol: string | null; indicators_json: string | null }>()
  for (const r of rows.results ?? []) {
    if (!r.symbol || !r.indicators_json) continue
    try {
      const parsed = JSON.parse(r.indicators_json) as { atr20?: unknown }
      if (typeof parsed.atr20 === 'number' && Number.isFinite(parsed.atr20) && parsed.atr20 > 0) {
        out.set(r.symbol.toUpperCase(), parsed.atr20)
      }
    } catch {
      // Malformed JSON just leaves this symbol without a stop distance.
    }
  }
  return out
}

// Runs through the same resolveStopDistance cron uses, so the displayed
// distance never drifts from where the position would actually be stopped out.
function buildStopDistances(
  positions: Array<{ sym: string; state: SymbolState | null }>,
  atr20Map: Map<string, number>,
  defaultRule: SymbolRule,
  universe: SymbolUniverse,
): Map<string, StopDistanceView> {
  const rules = buildSymbolRules(defaultRule, universe)
  const out = new Map<string, StopDistanceView>()
  for (const r of positions) {
    const pos = r.state?.position
    const quote = r.state?.lastQuote?.price
    if (!pos || pos.qty <= 0 || !(pos.avgPrice > 0) || typeof quote !== 'number' || !(quote > 0)) {
      continue
    }
    const sym = r.sym.toUpperCase()
    const rule = rules[sym] ?? defaultRule
    const stop = resolveStopDistance({
      price: pos.avgPrice,
      stopPct: rule.stopPct,
      takeProfitPct: rule.takeProfitPct,
      atr20: atr20Map.get(sym) ?? 0,
      kAtr: rule.kAtr,
      maxStopToTpRatio: rule.maxStopToTpRatio,
    })
    const pnlPct = ((quote - pos.avgPrice) / pos.avgPrice) * 100
    const effectiveStopPct = stop.effectiveStopPct * 100
    out.set(sym, { pnlPct, effectiveStopPct, toStopPct: pnlPct - effectiveStopPct })
  }
  return out
}

// Server-rendered HTML via Hono, no client build step, same basic-auth
// middleware as /admin. Every page renders defensively: a missing binding
// (D1/DO) surfaces "unavailable" instead of a 500, so a partially
// configured env still yields a usable landing.
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
      const [panelsCsv, portfolio, snapshots, usdJpy, positions, strategyPriceMap, recentTrades, runSignals, activityStats, atr20Map, vixRegime, global] =
        await Promise.all([
          loadOverviewPanelsCsv(db),
          c.env.PORTFOLIO_STATE
            ? new PortfolioStateClient(c.env.PORTFOLIO_STATE).getPortfolio().catch(() => null)
            : Promise.resolve(null),
          safeLoadPortfolioSnapshots(c.env.DB, range),
          // Skipped entirely (not just discarded) when PORTFOLIO_STATE is
          // absent, since the summary band that needs it won't render either.
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
          // Both best-effort: a failure here degrades to a missing widget,
          // not a failed home page.
          loadHomeRunSignals(c.env.DB).catch(() => null),
          loadActivityStats(c.env.DB).catch(() => null),
          loadLatestAtr20(c.env.DB, allDisplaySymbols).catch(() => new Map<string, number>()),
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
        usdJpy,
        symbolStateBound: symbolClient !== null,
        positions,
        strategyPriceMap,
        recentTrades,
        runSignals,
        activityStats,
        stopDistances: buildStopDistances(positions, atr20Map, strategyParamsFromGlobal(global), universe),
        vixRegime,
        dryRun: global.dryRun,
        // Same resolveTradingEnabled the top banner uses, so this never
        // disagrees with the banner about whether trading is actually on.
        tradingEnabled: resolveTradingEnabled(global.tradingEnabled, c.env.TRADING_ENABLED),
        universe,
      }
      return c.html(renderLayout(c, 'ダッシュボード', overviewBody(data)))
    } catch (err) {
      return c.html(renderLayout(c, 'ダッシュボード', unavailable(messageOf(err))))
    }
  })
  // Holdings moved into home's "risk and holdings" section; this redirect
  // keeps old bookmarks/notification links working. JSON export stays.
  .get('/positions', (c) => c.redirect('/dashboard', 302))
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
  .get('/portfolio', (c) => c.redirect('/dashboard', 302))
  .get('/trades', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '約定履歴', unavailable('DB not bound'), renderAnalysisSubnav('trades')))
    }
    const q = parseTradesQuery((key) => c.req.query(key))
    const db = createDb(c.env.DB)
    // universe load failure falls back to `null`, which renders the raw
    // symbol instead of "番号-会社名" formatting.
    const [rows, universe] = await Promise.all([
      loadTradeJournalRows(db, { ...q, limit: q.limit + 1 }), // +1 to detect hasMore

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
  // loadLifecycleReport does a Yahoo fetch per symbol (parallel), so this
  // page carries more latency than the other JSON exports.
  .get('/lifecycle', async (c) => {
    const subnav = renderAnalysisSubnav('lifecycle')
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'ライフサイクル', unavailable('DB not bound'), subnav))
    }
    try {
      const report = await loadLifecycleReport(c.env)
      return c.html(renderLayout(c, 'ライフサイクル', lifecycleBody(report), subnav))
    } catch (err) {
      return c.html(renderLayout(c, 'ライフサイクル', unavailable(messageOf(err)), subnav))
    }
  })
  .get('/lifecycle/json', async (c) => {
    if (!c.env.DB) {
      return jsonPretty({ error: 'db_not_bound', message: 'DB binding is not configured' }, 503)
    }
    try {
      const report = await loadLifecycleReport(c.env)
      return jsonPretty(report)
    } catch (err) {
      return jsonPretty({ error: 'lifecycle_json_export_failed', message: messageOf(err) }, 500)
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
    // A structured log entry, not a config_audit_log row — this is a
    // display setting, not config worth a DB audit trail. `before` comes
    // from setOverviewPanels' own write transaction so a concurrent update
    // can't produce a mismatched before/after pair.
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
  // Extracted from renderSymbolTab's former inline <script> (~1200 lines)
  // so the browser can cache it (ETag/If-None-Match) instead of re-sending
  // the same content on every symbol switch. Content is request-independent,
  // so no DB/env access is needed here.
  .get('/static/symbol-chart.js', (c) => {
    const ifNoneMatch = c.req.header('if-none-match')
    const headers = {
      'cache-control': 'public, max-age=86400',
      etag: SYMBOL_CHART_CLIENT_SCRIPT_ETAG,
    }
    if (ifNoneMatch === SYMBOL_CHART_CLIENT_SCRIPT_ETAG) {
      return c.body(null, 304, headers)
    }
    return c.body(SYMBOL_CHART_CLIENT_SCRIPT, 200, {
      ...headers,
      'content-type': 'text/javascript; charset=utf-8',
    })
  })
  // Hono matches routes in definition order, so this must stay defined
  // before `/charts` — otherwise a future `/charts/:sub` route could shadow it.
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
      // Unlike SSR (which substitutes a default symbol for one outside the
      // universe), this uses the requested symbol as-is: an unknown symbol
      // returns an empty chart, which an API caller can distinguish more
      // easily than a 404 substituted for a different symbol.
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
      // A load failure here degrades to no decisions, not a failed chart.
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
          chartsPageSubnav(parseChartsTab(c.req.query('tab'))),
        ),
      )
    }
    try {
      const tab = parseChartsTab(c.req.query('tab'))
      // Each tab only runs the D1 queries it needs (overview: equity;
      // quality: pnls + decisions; symbol: universe + symbolChart).
      if (tab === 'overview') {
        const [equity, tradeMarkers] = await Promise.all([
          loadEquityCurve(c.env.DB),
          loadEquityTradeMarkers(c.env.DB).catch(() => [] as EquityTradeMarker[]),
        ])
        // The QQQ benchmark fetch happens here (not inside loadEquityCurve)
        // to keep that function D1-pure; a fetch failure falls back to null
        // and the renderer just omits the series rather than failing the
        // whole chart. The range starts at the earliest of equity/marker
        // dates so the benchmark line still covers the early BUY-only
        // period where realized PnL isn't settled yet.
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
            chartsPageSubnav(tab),
          ),
        )
      }
      if (tab === 'quality') {
        const period = parseQualityPeriod(c.req.query('period'))
        const [skipBreakdown, allTradeRows] = await Promise.all([
          loadSkipReasonBreakdown(c.env.DB),
          loadTradePnls(c.env.DB),
        ])
        const filteredRows = filterTradePnlsByPeriod(allTradeRows, period)
        return c.html(
          renderLayout(
            c,
            'チャート',
            chartsBody({
              tab,
              period,
              asOfJst: fmtJst(new Date()),
              hasTradeData: allTradeRows.length > 0,
              stats: computeTradeStats(filteredRows.map((r) => r.realizedPnl)),
              symbolStats: computeSymbolStats(filteredRows),
              skipBreakdown,
            }),
            chartsPageSubnav(tab),
          ),
        )
      }
      // tab === 'symbol'. ?from/?to keep the x-axis zoom range in the URL
      // so it survives a symbol switch.
      const zoomFrom = parseIsoTimestamp(c.req.query('from'))
      const zoomTo = parseIsoTimestamp(c.req.query('to'))
      const symbolParam = c.req.query('symbol')?.toUpperCase().trim() || undefined
      const symbolView = parseSymbolView(c.req.query('view'))
      const [universe, global] = await Promise.all([
        loadSymbolUniverse(c.env),
        loadGlobalConfigFrom(c.env, c.get('requestId')),
      ])
      // Inactive symbols are still valid focus targets — an operator needs
      // to see how a symbol behaved after inactivating it. Active symbols
      // just take priority when picking a default.
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
      const globalParams: StrategyParamsSnapshot = strategyParamsFromGlobal(global)
      // Must share buildSymbolRules with cron's effective-rule resolution
      // (global default -> role preset -> per-symbol override); previously
      // the params table and chart overlay stayed on the global value and
      // silently ignored a symbol's override, drifting from what cron
      // actually applied.
      const defaultEntryRule: SymbolRule = { ...globalParams }
      const effectiveRules = buildSymbolRules(defaultEntryRule, universe)
      const entryRule: SymbolRule =
        (focusSymbol ? effectiveRules[focusSymbol] : undefined) ?? defaultEntryRule
      const strategyParams: StrategyParamsSnapshot = { ...entryRule }
      const rules: SymbolChartRules = {
        pullbackMax: strategyParams.pullbackMax,
        pullbackMin: strategyParams.pullbackMin,
        stopPct: strategyParams.stopPct,
        takeProfitPct: strategyParams.takeProfitPct,
        timeStopDays: strategyParams.timeStopDays,
      }
      // symbolChart, pair-regime evaluation, and decision history are
      // mutually independent (each takes only focusSymbol/universe/global/
      // entryRule, none reads another's result), so they run in parallel.
      // The pair lookup itself is synchronous and happens outside the
      // Promise.all — only the cases that actually need a fetch
      // (no invalidConfig) go async.
      const pair =
        focusSymbol && global.pairRegimeMode !== 'off'
          ? universe.pairRegimes.find(
              (pr) => pr.bullSymbol === focusSymbol || pr.bearSymbol === focusSymbol,
            )
          : undefined
      const [symbolChart, pairRegimeDecision, decisionRows] = await Promise.all([
        focusSymbol ? loadSymbolChart(c.env, focusSymbol, rules) : Promise.resolve(null),
        // Evaluates the same pure zone function cron uses. The proxy-bars
        // fetch goes through a dashboard-only short-TTL cache
        // (cachedDashboardJson) without touching cron's own YahooBarClient call.
        pair === undefined
          ? Promise.resolve<PairRegimeDecision | null>(null)
          : pair.invalidConfig !== null
            ? Promise.resolve<PairRegimeDecision>({
                zone: 'unknown',
                score: null,
                proxySymbol: pair.proxySymbol,
                asOfDate: null,
                reason: `misconfig: ${pair.invalidConfig}`,
              })
            : cachedDashboardJson(
                'pairRegimeProxyBars80',
                { symbol: pair.proxySymbol },
                () => new YahooBarClient().getDailyBars(pair.proxySymbol, 80),
                { shouldCache: (bars) => bars.length > 0 },
              )
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
                })),
        focusSymbol && c.env.DB
          ? loadDecisionRows(createDb(c.env.DB), { symbol: focusSymbol, limit: 30 }).catch(() => [])
          : Promise.resolve([]),
      ])
      const pairRegimeView: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null =
        pair !== undefined && pairRegimeDecision !== null
          ? {
              decision: pairRegimeDecision,
              side: pair.bullSymbol === focusSymbol ? ('bull' as const) : ('bear' as const),
              mode: global.pairRegimeMode,
            }
          : null
      // Defaults to the last 7 days (counted back from the chart's last
      // point, so it doesn't break on a closed market or right after POC
      // launch) when ?from/?to aren't both valid. The full 60-day view
      // makes trend/pin/SMA50 hard to read; 7 days matches the window an
      // operator actually checks cron/pullback/recent fills against.
      const zoom = computeZoomRange(zoomFrom, zoomTo, symbolChart)
      const buyability = symbolChart?.evalIndicators?.length
        ? buildBuyabilityView(symbolChart.evalIndicators, entryRule)
        : null
      const entryStatus = buyability?.current ? deriveEntryStatus(buyability.current) : null
      const symbolBodyArgs: ChartsBodySymbol = {
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
        view: symbolView,
        symbolPolicy: focusSymbol
          ? {
              role: universe.symbolRole[focusSymbol] ?? null,
              targetWeight: universe.symbolBudgetAllocPct[focusSymbol] ?? null,
              entryRequired: universe.symbolEntryRequired[focusSymbol] === true,
              alwaysActive: universe.symbolAlwaysActive[focusSymbol] === true,
              cashFallbackSymbols: universe.symbolCashFallback[focusSymbol] ?? null,
            }
          : null,
      }
      // A client-side symbol swap: returns only #symbol-main's inner HTML,
      // assuming the layout/rail/echarts CDN/static script are already
      // loaded in the browser. Fetched on every switch, so not cached.
      if (c.req.query('partial') === '1') {
        return c.html(renderSymbolMainInner(symbolBodyArgs), 200, { 'cache-control': 'no-store' })
      }
      return c.html(
        renderLayout(
          c,
          'チャート',
          renderSymbolTab(symbolBodyArgs),
          '', // no subnav — the symbol tab's nav path is the symbol group + rail
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
    try {
      const { payload, status } = await runCronJsonExport(createDb(c.env.DB), {
        requestId: c.req.query('requestId'),
        decisionId: c.req.query('decisionId'),
      })
      return jsonPretty(payload, status)
    } catch (err) {
      return jsonPretty({ error: 'cron_json_export_failed', message: messageOf(err) }, 500)
    }
  })
  .get('/cron', async (c) => {
    const cronSubnav = renderDiagSubnav('cron')
    if (!c.env.DB) {
      return c.html(renderLayout(c, '戦略判定', unavailable('DB not bound'), cronSubnav))
    }
    const limit = clampLimit(c.req.query('limit'))
    const before = parseCursor(c.req.query('before'))
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    const clientOrderIdFilter = c.req.query('clientOrderId')?.trim() || undefined
    // Open-market rows only by default (?session=all shows the rest). Time x
    // market x holiday x DST can't be expressed as SQL, so
    // loadDecisionRowsInSession advances the cursor batch by batch until
    // enough open rows are found, keeping the page size and next cursor in
    // sync with what's actually shown.
    const sessionFilter = c.req.query('session') === 'all' ? ('all' as const) : ('open' as const)
    const db = createDb(c.env.DB)
    try {
      const queryOpts = { symbol: symbolFilter, clientOrderId: clientOrderIdFilter, before }
      const [page, universe] = await Promise.all([
        sessionFilter === 'open'
          ? loadDecisionRowsInSession(db, { ...queryOpts, limit })
          : loadDecisionRows(db, { ...queryOpts, limit: limit + 1 }).then((rows) => {
              const hasMore = rows.length > limit
              if (hasMore) rows.pop()
              return { rows, hasMore, lastScannedId: rows[rows.length - 1]?.id }
            }),
        loadSymbolUniverse(c.env).catch(() => null),
      ])
      return c.html(
        renderLayout(
          c,
          '戦略判定',
          cronBody(
            page.rows,
            limit,
            symbolFilter,
            universe,
            before,
            page.hasMore,
            clientOrderIdFilter,
            sessionFilter,
            // A full page continues seamlessly from its last displayed row.
            // A short page (scan cut off / end of table) instead continues
            // from the last row scanned — re-scanning from the displayed
            // end would just walk the same closed-market rows again into an
            // empty page.
            page.rows.length >= limit
              ? page.rows[page.rows.length - 1]!.id
              : page.lastScannedId,
          ),
          cronSubnav,
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, '戦略判定', unavailable(messageOf(err)), cronSubnav))
    }
  })
  // Renders a form + display shell only; the browser's own fetch hits
  // /admin/broker/probe directly (same origin, same Access policy, so the
  // existing Access cookie carries over without a re-prompt). The server
  // never proxies the probe call itself — no auth-header forwarding needed.
  .get('/broker-probe', async (c) => {
    const symbol = (c.req.query('symbol') ?? 'AAPL').trim().toUpperCase() || 'AAPL'
    const category = (c.req.query('category') ?? 'US_STOCK').trim().toUpperCase() || 'US_STOCK'
    // Null on missing DB/load failure — the UI still works with just held
    // symbols + the AAPL control.
    const universe = c.env.DB
      ? await loadSymbolUniverse(c.env).catch(() => null)
      : null
    return c.html(
      renderLayout(c, 'Broker 診断', brokerProbeBody({ symbol, category, universe })),
    )
  })
  .get('/alerts', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, 'アラート', unavailable('DB not bound'), renderDiagSubnav('alerts')))
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
          renderDiagSubnav('alerts'),
        ),
      )
    } catch (err) {
      return c.html(renderLayout(c, 'アラート', unavailable(messageOf(err)), renderDiagSubnav('alerts')))
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
      return c.html(renderLayout(c, '監査ログ', unavailable(messageOf(err))))
    }
  })
  // Renders list/new/edit only; writes go to /admin/symbol-config[/...] via
  // form submit and a 303 redirect back (PRG).
  .get('/symbols', async (c) => {
    if (!c.env.DB) {
      return c.html(renderLayout(c, '銘柄管理', unavailable('DB not bound')))
    }
    try {
      const [rows, inversePairs, pairRegimes, tradable] = await Promise.all([
        loadAllSymbolConfigRows(c.env.DB),
        loadInversePairs(createDb(c.env.DB)).catch(() => ({}) as Record<string, string>),
        // A load failure here still lets the list render, just without the
        // relation map / allowlist badges (empty map = every symbol unknown).
        loadPairRegimeConfigs(createDb(c.env.DB)).catch(() => []),
        loadTradableAllowlist(createDb(c.env.DB)).catch(
          () => new Map() as Awaited<ReturnType<typeof loadTradableAllowlist>>,
        ),
      ])
      // Relation map's vertical axis is committed cost (DO position qty x
      // avgPrice, the ground truth). A missing position sorts to 0 (bottom).
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
              // A missing rate falls back to an approximate 150 for
              // positioning only — the displayed native amount is unaffected.
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
  // Each canvas change (draw/erase a fallback line, edit a % input) confirms
  // and applies immediately through the admin API, then reloads — no local
  // canvas state that could drift from the DB.
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
    // A load failure falls back to null, which just hides the placeholder
    // rather than blocking the form itself.
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
  // Must be defined after /symbols/new, /symbols/map, /symbols/:symbol/edit
  // — Hono matches routes in definition order, and this catch-all would
  // otherwise shadow them.
  .get('/symbols/:symbol', (c) => {
    const symbol = (c.req.param('symbol') ?? '').trim().toUpperCase()
    if (symbol.length === 0) return c.redirect('/dashboard/symbols')
    return c.redirect(`/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(symbol)}`)
  })
  // earnings_calendar / macro_event_calendar feed the earningsGate /
  // macroEventGate risk gates, so an operator needs to manage them without
  // going through an AI-agent curl call. Shows only now-30d..now+30d — the
  // window the gates actually read; older/further rows are reachable via
  // the admin GET endpoint but omitted here to keep the list short.
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
      return c.html(renderLayout(c, 'イベント', unavailable(messageOf(err))))
    }
  })
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
    // A non-blocking warning (e.g. symbol outside the universe) trades the
    // PRG redirect for a re-render, so the operator actually sees it.
    if (validation.warning) {
      return await renderEventsWithNotice(c, {
        section: 'earnings',
        message: validation.warning,
      })
    }
    return c.redirect('/dashboard/events', 303)
  })
  // A companion POST endpoint, since an HTML form can't send DELETE.
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
  // Token plaintext never reaches the HTML (only a head/tail tokenHint);
  // Cache-Control: no-store keeps it out of browser/intermediate caches.
  .get('/webull-token', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!c.env.WEBULL_TOKEN_STATE) {
      return c.html(renderLayout(c, 'Webull token', unavailable('WEBULL_TOKEN_STATE binding is not configured')))
    }
    const store = new WebullTokenStateClient(c.env.WEBULL_TOKEN_STATE)
    // Distinguishes a DO read failure (an outage) from a genuinely empty DO
    // (never seeded) — conflating them would have an operator mistake a
    // real failure for "just needs seeding" and skip investigating it.
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
    // Accepts pasting the issue-token script's full output, not just the
    // token: strips stderr diagnostics and the wrangler suggestion line,
    // then requires exactly one line left over. More than one surviving
    // line is treated as ambiguous rather than guessed at.
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
    // Re-verifies against the broker rather than trusting the pasted value,
    // so an expired/PENDING token can't get written to the DO (TOC-TOU —
    // same reasoning as the admin endpoint).
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
    // A seedToken throw redirects to ?error= instead of a 500. A getState
    // failure just leaves the audit log's `before` as null, so it stays
    // caught-and-ignored here too.
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
    // refreshWebullToken normally catches its own errors into
    // failureReason rather than throwing; this try/catch is a backstop so a
    // genuine throw still redirects to ?error= instead of a 500, and a
    // failureReason still routes to the error banner rather than the
    // success notice below.
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
    // A skip (e.g. plenty of time left before expiry) is normal, not an error.
    const why = summary.skippedReason ?? 'no change'
    return c.redirect(`/dashboard/webull-token?notice=${encodeURIComponent(`refresh: ${why}`)}`, 303)
  })
  // Read-only view over extended_hours_observation, written by
  // extendedHoursScheduler (the producer).
  .get('/extended-hours', async (c) => {
    const subnav = renderDiagSubnav('extendedHours')
    if (!c.env.DB) {
      return c.html(renderLayout(c, '時間外参考', unavailable('DB not bound'), subnav))
    }
    try {
      const repo = createExtendedHoursObservationRepo(createExtendedHoursObservationDb(c.env.DB))
      const sessionYmd = formatNyYmd(new Date())
      const [latest, recent] = await Promise.all([
        repo.latestPerSymbol(sessionYmd),
        repo.recent(50),
      ])
      return c.html(
        renderLayout(c, '時間外参考', extendedHoursBody({ sessionYmd, latest, recent }), subnav),
      )
    } catch (err) {
      return c.html(renderLayout(c, '時間外参考', unavailable(messageOf(err)), subnav))
    }
  })
