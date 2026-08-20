/**
 * 売買ライフサイクル計測 (issue #709 Phase 2) — D1 / Yahoo から素材を集めて
 * `lifecycleMetrics.ts` の pure 関数群に流し込む loader/assembler。
 *
 * 読み取り専用: strategy/risk/execution には一切書き込まない。D1 query は
 * `routes/dashboard/charts/loaders.ts` と同じ `db.prepare().bind().all()`
 * 流儀 (drizzle は使わない — 既存 dashboard loader との一貫性を優先)。
 */
import type { Env } from '../../config/env'
import type { DailyBar } from '../strategy/indicators'
import { YahooBarClient } from '../../infrastructure/quotes/YahooBarClient'
import { formatNyYmd } from '../../infrastructure/calendar/usMarketCalendar'
import {
  type DrawdownResult,
  type ExitReasonCategory,
  type ExitReasonStat,
  type LifecycleFill,
  type SkipReasonCategory,
  type SkipSignal,
  type TurnoverResult,
  EXIT_REASON_CATEGORY_ORDER,
  SKIP_REASON_CATEGORY_ORDER,
  avgNonNull,
  classifyRoundTrips,
  classifySkipReason,
  computeDrawdown,
  computeExitReasonStats,
  computeForwardReturns,
  computePreEntryRunup,
  computeSkipOutcome,
  computeTurnover,
  crossTabSlExitsWithExtendedHours,
  dedupSkipSignalsByDay,
  pairRoundTrips,
  resolveFillSide,
  sumEstimatedCost,
} from './lifecycleMetrics'

/** DI seam: 本番は `YahooBarClient`、test は差し替え可能。 */
export interface LifecycleBarClient {
  getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]>
}

export interface LoadLifecycleReportOptions {
  client?: LifecycleBarClient
  now?: () => Date
}

interface AvgWindow {
  n: number
  avg: number | null
}

interface ForwardReturnRow {
  category: ExitReasonCategory | 'ALL'
  r1: AvgWindow
  r3: AvgWindow
  r5: AvgWindow
  r10: AvgWindow
}

interface PostExitMfeRow {
  category: ExitReasonCategory | 'ALL'
  mfe10: AvgWindow
}

interface PreEntryRunupRow {
  category: ExitReasonCategory | 'ALL'
  runup5: AvgWindow
}

interface SkipOutcomeRow {
  category: SkipReasonCategory | 'ALL'
  mfe10: AvgWindow
  mae10: AvgWindow
}

export interface LifecycleReport {
  generatedAt: string
  meta: {
    note: string
    roundTripCount: number
    fillCount: number
    skipSignalCount: number
    barFetchFailedSymbols: string[]
  }
  exitReasonStats: ExitReasonStat[]
  forwardReturns: ForwardReturnRow[]
  postExitMfe: PostExitMfeRow[]
  preEntryRunup: PreEntryRunupRow[]
  skipOutcomes: SkipOutcomeRow[]
  extendedHoursSlCrosstab: Record<string, number>
  cost: { totalEstimatedCostUsd: number }
  drawdown: DrawdownResult
  turnover: TurnoverResult & { avgEquityUsd: number | null }
}

const NOTE =
  '日足は Yahoo (query1.finance.yahoo.com) 由来。直近の exit / SKIP は先の営業日 bar がまだ無いためフォワード指標の n が減る。'

/** `admin.ts` の `estimateLookbackDays` と同じ考え方 (calendar→trading day 換算 + buffer)。5y (#709 ブリーフ「上限5yで十分」) で cap。 */
const MAX_LOOKBACK_DAYS = 1825

function estimateLookbackDays(earliestIso: string | null, now: Date): number {
  if (!earliestIso) return 60
  const earliestMs = new Date(earliestIso).getTime()
  if (!Number.isFinite(earliestMs)) return 60
  const windowStartMs = earliestMs - 30 * 86_400_000
  const calendarDays = Math.max(1, Math.ceil((now.getTime() - windowStartMs) / 86_400_000))
  const tradingDaysEstimate = Math.ceil(calendarDays * (5 / 7)) + 15
  return Math.min(Math.max(tradingDaysEstimate, 30), MAX_LOOKBACK_DAYS)
}

interface RawFillRow {
  timestamp: string
  symbol: string | null
  pre_side: string | null
  filled_price: number | null
  filled_qty: number | null
  realized_pnl: number | null
  estimated_cost: number | null
  client_order_id: string | null
}

async function loadAllFills(db: D1Database): Promise<LifecycleFill[]> {
  const result = await db
    .prepare(
      `SELECT
         ps.timestamp AS timestamp,
         ps.symbol AS symbol,
         pre.side AS pre_side,
         ps.filled_price AS filled_price,
         ps.filled_qty AS filled_qty,
         ps.realized_pnl AS realized_pnl,
         ps.estimated_cost AS estimated_cost,
         ps.client_order_id AS client_order_id
       FROM trade_journal AS ps
       LEFT JOIN trade_journal AS pre
         ON pre.client_order_id = ps.client_order_id
         AND pre.trade_event_type = 'pre_submit'
       WHERE ps.trade_event_type = 'post_submit'
         AND ps.filled_price IS NOT NULL
       ORDER BY ps.id ASC`,
    )
    .all<RawFillRow>()
  const fills: LifecycleFill[] = []
  for (const r of result.results ?? []) {
    if (!r.symbol || r.filled_price === null) continue
    fills.push({
      symbol: r.symbol.toUpperCase(),
      side: resolveFillSide(r.pre_side, r.realized_pnl),
      qty: r.filled_qty === null ? 0 : Number(r.filled_qty),
      price: Number(r.filled_price),
      at: r.timestamp,
      clientOrderId: r.client_order_id ?? null,
      realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
      estimatedCost: r.estimated_cost === null ? null : Number(r.estimated_cost),
    })
  }
  return fills
}

async function loadSellReasonByClientOrderId(db: D1Database): Promise<Map<string, string | null>> {
  const result = await db
    .prepare(
      `SELECT client_order_id, reason FROM strategy_decision_log
       WHERE decision = 'SELL' AND client_order_id IS NOT NULL`,
    )
    .all<{ client_order_id: string; reason: string | null }>()
  const map = new Map<string, string | null>()
  for (const r of result.results ?? []) {
    map.set(r.client_order_id, r.reason)
  }
  return map
}

async function loadSkipSignals(db: D1Database): Promise<SkipSignal[]> {
  const result = await db
    .prepare(
      `SELECT symbol, timestamp, reason FROM strategy_decision_log
       WHERE decision = 'SKIP'
       ORDER BY id ASC`,
    )
    .all<{ symbol: string | null; timestamp: string; reason: string | null }>()
  const out: SkipSignal[] = []
  for (const r of result.results ?? []) {
    if (!r.symbol) continue
    out.push({ symbol: r.symbol.toUpperCase(), at: r.timestamp, reason: r.reason })
  }
  return out
}

async function loadAvgEquityUsd(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT AVG(daily_start_equity_usd) AS avg_equity FROM portfolio_equity_snapshot
       WHERE daily_start_equity_usd IS NOT NULL`,
    )
    .first<{ avg_equity: number | null }>()
  const v = row?.avg_equity
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v)
}

/**
 * `${symbol}|${NY YYYY-MM-DD}` → 最終観測 status。テーブル全体を id 昇順で
 * 舐めて上書きすれば「その日最後の観測」が残る (#709 Phase 1 の producer は
 * 5 分 cron で複数回書く)。Phase 2 時点でテーブルは小さい想定 (観測データ
 * まだ少ない、#709 ブリーフ) なのでフィルタ無しの全件走査で十分。
 */
async function loadExtendedHoursStatusBySymbolNyDay(db: D1Database): Promise<Map<string, string>> {
  const result = await db
    .prepare(
      `SELECT symbol, session_ymd, status FROM extended_hours_observation
       ORDER BY id ASC`,
    )
    .all<{ symbol: string; session_ymd: string; status: string }>()
  const map = new Map<string, string>()
  for (const r of result.results ?? []) {
    map.set(`${r.symbol.toUpperCase()}|${r.session_ymd}`, r.status)
  }
  return map
}

/** カテゴリ別 + 'ALL' の forward return 行を組み立てる。 */
function buildForwardReturnRows(
  entries: ReadonlyArray<{ category: ExitReasonCategory; forward: ReturnType<typeof computeForwardReturns> }>,
): ForwardReturnRow[] {
  const rows: ForwardReturnRow[] = []
  const build = (category: ExitReasonCategory | 'ALL', list: typeof entries): ForwardReturnRow => ({
    category,
    r1: avgNonNull(list.map((e) => e.forward.r1)),
    r3: avgNonNull(list.map((e) => e.forward.r3)),
    r5: avgNonNull(list.map((e) => e.forward.r5)),
    r10: avgNonNull(list.map((e) => e.forward.r10)),
  })
  if (entries.length > 0) rows.push(build('ALL', entries))
  for (const category of EXIT_REASON_CATEGORY_ORDER) {
    const list = entries.filter((e) => e.category === category)
    if (list.length === 0) continue
    rows.push(build(category, list))
  }
  return rows
}

function buildPostExitMfeRows(
  entries: ReadonlyArray<{ category: ExitReasonCategory; mfe10: number | null }>,
): PostExitMfeRow[] {
  const rows: PostExitMfeRow[] = []
  if (entries.length > 0) {
    rows.push({ category: 'ALL', mfe10: avgNonNull(entries.map((e) => e.mfe10)) })
  }
  for (const category of EXIT_REASON_CATEGORY_ORDER) {
    const list = entries.filter((e) => e.category === category)
    if (list.length === 0) continue
    rows.push({ category, mfe10: avgNonNull(list.map((e) => e.mfe10)) })
  }
  return rows
}

function buildPreEntryRunupRows(
  entries: ReadonlyArray<{ category: ExitReasonCategory; runup: number | null }>,
): PreEntryRunupRow[] {
  const rows: PreEntryRunupRow[] = []
  if (entries.length > 0) {
    rows.push({ category: 'ALL', runup5: avgNonNull(entries.map((e) => e.runup)) })
  }
  for (const category of EXIT_REASON_CATEGORY_ORDER) {
    const list = entries.filter((e) => e.category === category)
    if (list.length === 0) continue
    rows.push({ category, runup5: avgNonNull(list.map((e) => e.runup)) })
  }
  return rows
}

function buildSkipOutcomeRows(
  entries: ReadonlyArray<{ category: SkipReasonCategory; mfe10: number | null; mae10: number | null }>,
): SkipOutcomeRow[] {
  const rows: SkipOutcomeRow[] = []
  if (entries.length > 0) {
    rows.push({
      category: 'ALL',
      mfe10: avgNonNull(entries.map((e) => e.mfe10)),
      mae10: avgNonNull(entries.map((e) => e.mae10)),
    })
  }
  for (const category of SKIP_REASON_CATEGORY_ORDER) {
    const list = entries.filter((e) => e.category === category)
    if (list.length === 0) continue
    rows.push({
      category,
      mfe10: avgNonNull(list.map((e) => e.mfe10)),
      mae10: avgNonNull(list.map((e) => e.mae10)),
    })
  }
  return rows
}

/**
 * 過去 decision / fill から売買ライフサイクルレポートを組み立てる。
 *
 * fetch 方針: symbol ごとに Yahoo daily bars を 1 回だけ取得する。個別 symbol
 * の fetch 失敗はその symbol が絡む round trip / skip のフォワード系だけ null
 * に落とし (`meta.barFetchFailedSymbols` に記録)、レポート全体は throw しない。
 */
export async function loadLifecycleReport(
  env: Env,
  options: LoadLifecycleReportOptions = {},
): Promise<LifecycleReport> {
  const db = env.DB
  if (!db) throw new Error('DB binding not available')
  const now = (options.now ?? (() => new Date()))()
  const client = options.client ?? new YahooBarClient()

  const [fills, sellReasonByClientOrderId, rawSkipSignals, avgEquityUsd, extendedHoursStatus] =
    await Promise.all([
      loadAllFills(db),
      loadSellReasonByClientOrderId(db),
      loadSkipSignals(db),
      loadAvgEquityUsd(db),
      loadExtendedHoursStatusBySymbolNyDay(db),
    ])

  const trips = pairRoundTrips(fills)
  const classifiedTrips = classifyRoundTrips(trips, sellReasonByClientOrderId)
  const skipSignals = dedupSkipSignalsByDay(rawSkipSignals)

  // fetch 対象 symbol: round trip (entry/exit 両方) + SKIP。
  const symbols = new Set<string>()
  for (const t of trips) symbols.add(t.symbol)
  for (const s of skipSignals) symbols.add(s.symbol)

  const earliestIso =
    [...trips.map((t) => t.entryAt), ...skipSignals.map((s) => s.at)].sort()[0] ?? null
  const lookbackDays = estimateLookbackDays(earliestIso, now)

  const barsBySymbol = new Map<string, DailyBar[]>()
  const barFetchFailedSymbols: string[] = []
  await Promise.all(
    [...symbols].map(async (symbol) => {
      try {
        const bars = await client.getDailyBars(symbol, lookbackDays)
        barsBySymbol.set(symbol, bars)
      } catch {
        barFetchFailedSymbols.push(symbol)
      }
    }),
  )
  barFetchFailedSymbols.sort()

  const forwardEntries: Array<{ category: ExitReasonCategory; forward: ReturnType<typeof computeForwardReturns> }> =
    []
  const mfeEntries: Array<{ category: ExitReasonCategory; mfe10: number | null }> = []
  const runupEntries: Array<{ category: ExitReasonCategory; runup: number | null }> = []
  for (const trip of classifiedTrips) {
    const bars = barsBySymbol.get(trip.symbol)
    const forward = bars ? computeForwardReturns(trip, bars) : { r1: null, r3: null, r5: null, r10: null, postExitMfe10: null }
    forwardEntries.push({ category: trip.exitReasonCategory, forward })
    mfeEntries.push({ category: trip.exitReasonCategory, mfe10: forward.postExitMfe10 })
    const runup = bars ? computePreEntryRunup(trip, bars) : null
    runupEntries.push({ category: trip.exitReasonCategory, runup })
  }

  const skipOutcomeEntries: Array<{ category: SkipReasonCategory; mfe10: number | null; mae10: number | null }> = []
  for (const skip of skipSignals) {
    const bars = barsBySymbol.get(skip.symbol)
    const outcome = bars ? computeSkipOutcome(skip, bars) : { mfe10: null, mae10: null }
    skipOutcomeEntries.push({ category: classifySkipReason(skip.reason), mfe10: outcome.mfe10, mae10: outcome.mae10 })
  }

  const slExits = classifiedTrips
    .filter((t) => t.exitReasonCategory === 'SL')
    .map((t) => ({ symbol: t.symbol, exitAt: t.exitAt }))
  const extendedHoursSlCrosstab = crossTabSlExitsWithExtendedHours(slExits, extendedHoursStatus)

  return {
    generatedAt: now.toISOString(),
    meta: {
      note: NOTE,
      roundTripCount: trips.length,
      fillCount: fills.length,
      skipSignalCount: skipSignals.length,
      barFetchFailedSymbols,
    },
    exitReasonStats: computeExitReasonStats(classifiedTrips),
    forwardReturns: buildForwardReturnRows(forwardEntries),
    postExitMfe: buildPostExitMfeRows(mfeEntries),
    preEntryRunup: buildPreEntryRunupRows(runupEntries),
    skipOutcomes: buildSkipOutcomeRows(skipOutcomeEntries),
    extendedHoursSlCrosstab,
    cost: { totalEstimatedCostUsd: sumEstimatedCost(fills) },
    drawdown: computeDrawdown(trips),
    turnover: { ...computeTurnover(fills, avgEquityUsd), avgEquityUsd },
  }
}
