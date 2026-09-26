/**
 * Pure functions only — no D1/fetch. `lifecycleReport.ts` gathers material
 * from D1/YahooBarClient and passes it here; same input always yields the
 * same output, so a dashboard re-render or JSON export is reproducible.
 * Never referenced by the strategy/risk/execution path.
 */
import type { DailyBar } from '../strategy/indicators'
import { formatNyYmd } from '../../infrastructure/calendar/usMarketCalendar'

export interface LifecycleFill {
  symbol: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  /** ISO UTC timestamp (`trade_journal.timestamp`). */
  at: string
  clientOrderId: string | null
  realizedPnl: number | null
  estimatedCost: number | null
}

export interface RoundTrip {
  symbol: string
  entryAt: string
  exitAt: string
  entryPrice: number
  exitPrice: number
  /** The closing SELL fill's qty. Assumed equal to entry qty — POC doesn't support partial sells. */
  qty: number
  realizedPnl: number | null
  exitClientOrderId: string | null
}

export type ExitReasonCategory =
  | 'TP'
  | 'SL'
  | 'TIME_STOP'
  | 'REGIME_FLIP'
  | 'INTRADAY_CLOSE'
  | 'REBALANCE'
  | 'OTHER'
  | 'UNKNOWN'

/** Fixed iteration order for dashboard display/aggregation. */
export const EXIT_REASON_CATEGORY_ORDER: readonly ExitReasonCategory[] = [
  'TP',
  'SL',
  'TIME_STOP',
  'REGIME_FLIP',
  'INTRADAY_CLOSE',
  'REBALANCE',
  'OTHER',
  'UNKNOWN',
]

export interface ClassifiedRoundTrip extends RoundTrip {
  exitReasonCategory: ExitReasonCategory
}

/**
 * Same logic as `routes/dashboard/charts/loaders.ts`'s `resolveFillSide`,
 * duplicated rather than imported: routes may import from trading, not the
 * reverse, and this function is too small to justify a layering exception.
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
 * Pairs closed round-trips from fills (any order, multiple symbols mixed).
 * Same assumptions as `routes/dashboard/charts/loaders.ts`'s
 * `pairClosedTrades`: first BUY while flat opens the position, next SELL
 * closes it fully, an orphan SELL is skipped, a trailing open BUY is
 * dropped. Each symbol is a separate state machine; results are returned
 * in exitAt order rather than map-insertion order.
 */
export function pairRoundTrips(fills: readonly LifecycleFill[]): RoundTrip[] {
  const bySymbol = new Map<string, LifecycleFill[]>()
  for (const f of fills) {
    const list = bySymbol.get(f.symbol)
    if (list) list.push(f)
    else bySymbol.set(f.symbol, [f])
  }
  const trips: RoundTrip[] = []
  for (const [symbol, symbolFills] of bySymbol) {
    // Re-sorts rather than trusting caller order: a row where id order and
    // timestamp order disagree would twist BUY/SELL pairing and silently
    // corrupt every downstream metric.
    symbolFills.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    let open: LifecycleFill | null = null
    for (const f of symbolFills) {
      if (f.side === 'BUY') {
        if (open === null) open = f
      } else if (open !== null) {
        trips.push({
          symbol,
          entryAt: open.at,
          exitAt: f.at,
          entryPrice: open.price,
          exitPrice: f.price,
          qty: f.qty,
          realizedPnl: f.realizedPnl,
          exitClientOrderId: f.clientOrderId,
        })
        open = null
      }
    }
  }
  trips.sort((a, b) => (a.exitAt < b.exitAt ? -1 : a.exitAt > b.exitAt ? 1 : 0))
  return trips
}

/**
 * Categorizes a raw SELL exit reason string. Patterns mirror the strings
 * the strategies and `pullbackScheduler.ts` actually emit. `null` (SELL
 * fill's client_order_id not found in strategy_decision_log — manual sell
 * or pre-migration data) maps to UNKNOWN; an unrecognized pattern (a
 * future exit route) maps to OTHER rather than being dropped from totals.
 */
export function classifyLiveExitReason(reason: string | null | undefined): ExitReasonCategory {
  if (!reason) return 'UNKNOWN'
  if (/^take-profit/.test(reason)) return 'TP'
  if (/^stop-loss/.test(reason)) return 'SL'
  if (/^time-stop/.test(reason)) return 'TIME_STOP'
  if (reason.includes('pair regime flip')) return 'REGIME_FLIP'
  if (reason.includes('intraday-only')) return 'INTRADAY_CLOSE'
  if (reason.includes('cash allocation rebalance')) return 'REBALANCE'
  return 'OTHER'
}

/** `reasonByClientOrderId` is the loader's pre-built `clientOrderId → reason` lookup from strategy_decision_log's SELL rows. */
export function classifyRoundTrips(
  trips: readonly RoundTrip[],
  reasonByClientOrderId: ReadonlyMap<string, string | null>,
): ClassifiedRoundTrip[] {
  return trips.map((t) => ({
    ...t,
    exitReasonCategory: classifyLiveExitReason(
      t.exitClientOrderId ? (reasonByClientOrderId.get(t.exitClientOrderId) ?? null) : null,
    ),
  }))
}

export interface ExitReasonStat {
  category: ExitReasonCategory
  count: number
  wins: number
  losses: number
  /** 0..1 */
  winRate: number
  avgWin: number
  avgLoss: number
  /** Expected P&L per trade, averaged over all trades including break-even. */
  expectancy: number
}

/**
 * Win rate / avg win / avg loss / expectancy per exit-reason category.
 * Trips with `realizedPnl === null` (legacy data gap) are excluded. Same
 * formulas as `routes/dashboard/charts/quality.ts`'s `computeTradeStats`,
 * duplicated rather than imported for the same layering reason as `resolveFillSide`.
 */
export function computeExitReasonStats(trips: readonly ClassifiedRoundTrip[]): ExitReasonStat[] {
  const byCategory = new Map<ExitReasonCategory, number[]>()
  for (const t of trips) {
    if (t.realizedPnl === null || !Number.isFinite(t.realizedPnl)) continue
    const list = byCategory.get(t.exitReasonCategory)
    if (list) list.push(t.realizedPnl)
    else byCategory.set(t.exitReasonCategory, [t.realizedPnl])
  }
  const out: ExitReasonStat[] = []
  for (const category of EXIT_REASON_CATEGORY_ORDER) {
    const pnls = byCategory.get(category)
    if (!pnls || pnls.length === 0) continue
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
    out.push({
      category,
      count: pnls.length,
      wins,
      losses,
      winRate: decisive > 0 ? wins / decisive : 0,
      avgWin: wins > 0 ? sumWin / wins : 0,
      avgLoss: losses > 0 ? sumLoss / losses : 0,
      expectancy: total / pnls.length,
    })
  }
  return out
}

/** "2026-06-05T14:05:00.000Z" → "2026-06-05"。不正な ISO は空文字。 */
function utcDateOnly(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  return iso.slice(0, 10)
}

/** Index of the first bar on or after `dateIso`'s UTC date, or null if no such bar has been fetched yet. */
function findBarIndexOnOrAfter(bars: readonly DailyBar[], dateIso: string): number | null {
  const date = utcDateOnly(dateIso)
  if (!date) return null
  const idx = bars.findIndex((b) => date <= b.date)
  return idx === -1 ? null : idx
}

export interface ForwardReturns {
  r1: number | null
  r3: number | null
  r5: number | null
  r10: number | null
  /** Max upside (high vs. base close) within 10 business days post-exit. */
  postExitMfe10: number | null
}

/**
 * 1/3/5/10-business-day returns and post-exit MFE, based off the exit-date
 * bar's close. r1/r3/r5/r10 are null when that offset's bar isn't
 * available yet. postExitMfe10 is null only when the exit bar itself is
 * missing — otherwise it's a running max over whatever bars are available
 * (up to 10), since a running max stays meaningful with a partial window
 * unlike a fixed-offset return.
 */
export function computeForwardReturns(
  trip: { exitAt: string },
  bars: readonly DailyBar[],
): ForwardReturns {
  const idx = findBarIndexOnOrAfter(bars, trip.exitAt)
  if (idx === null) return { r1: null, r3: null, r5: null, r10: null, postExitMfe10: null }
  const base = bars[idx]!.close
  const ret = (n: number): number | null => {
    const bar = bars[idx + n]
    return bar && base !== 0 && Number.isFinite(base) ? (bar.close - base) / base : null
  }
  let mfe: number | null = null
  for (let n = 1; n <= 10; n += 1) {
    const bar = bars[idx + n]
    if (!bar) break
    if (base === 0 || !Number.isFinite(base)) break
    const upside = (bar.high - base) / base
    if (mfe === null || upside > mfe) mfe = upside
  }
  return { r1: ret(1), r3: ret(3), r5: ret(5), r10: ret(10), postExitMfe10: mfe }
}

/** Return from 5 bars before entry to the entry bar's close. Null if the entry bar or its 5 prior bars aren't available. */
export function computePreEntryRunup(
  trip: { entryAt: string },
  bars: readonly DailyBar[],
): number | null {
  const idx = findBarIndexOnOrAfter(bars, trip.entryAt)
  if (idx === null || idx < 5) return null
  const base = bars[idx - 5]!.close
  if (base === 0 || !Number.isFinite(base)) return null
  return (bars[idx]!.close - base) / base
}

export interface SkipSignal {
  symbol: string
  /** ISO UTC timestamp (`strategy_decision_log.timestamp`). */
  at: string
  reason: string | null
}

export type SkipReasonCategory = 'HALT' | 'SIZING' | 'RISK' | 'OTHER'

export const SKIP_REASON_CATEGORY_ORDER: readonly SkipReasonCategory[] = [
  'HALT',
  'SIZING',
  'RISK',
  'OTHER',
]

/**
 * Coarser than `routes/dashboard/charts/quality.ts`'s `categorizeSkipReason`
 * (7 UI-colored categories) — this report cares about what happened after a
 * skip, not the skip breakdown itself, so halt/sizing/risk/other is enough.
 * Duplicated rather than imported for the same layering reason as `resolveFillSide`.
 */
export function classifySkipReason(reason: string | null | undefined): SkipReasonCategory {
  if (!reason) return 'OTHER'
  if (/^(?:portfolio_halted|drawdown_kill):/.test(reason)) return 'HALT'
  if (/^sizing rejected:/.test(reason)) return 'SIZING'
  if (/^risk:/.test(reason) || /^pair_regime:/.test(reason)) return 'RISK'
  return 'OTHER'
}

/** Keeps only the first SKIP per (symbol, UTC date), collapsing repeats from the 15-minute cron. Assumes input is timestamp-ascending. */
export function dedupSkipSignalsByDay(signals: readonly SkipSignal[]): SkipSignal[] {
  const seen = new Set<string>()
  const out: SkipSignal[] = []
  for (const s of signals) {
    const day = utcDateOnly(s.at)
    const key = `${s.symbol}|${day}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export interface SkipOutcome {
  /** Max upside (high) within 10 business days post-skip. */
  mfe10: number | null
  /** Max downside (low, negative) within 10 business days post-skip. */
  mae10: number | null
}

/** Same best-effort/partial-window behavior as `computeForwardReturns`'s postExitMfe10: null only if the SKIP-date bar itself is missing. */
export function computeSkipOutcome(skip: SkipSignal, bars: readonly DailyBar[]): SkipOutcome {
  const idx = findBarIndexOnOrAfter(bars, skip.at)
  if (idx === null) return { mfe10: null, mae10: null }
  const base = bars[idx]!.close
  if (base === 0 || !Number.isFinite(base)) return { mfe10: null, mae10: null }
  let mfe: number | null = null
  let mae: number | null = null
  for (let n = 1; n <= 10; n += 1) {
    const bar = bars[idx + n]
    if (!bar) break
    const upside = (bar.high - base) / base
    const downside = (bar.low - base) / base
    if (mfe === null || upside > mfe) mfe = upside
    if (mae === null || downside < mae) mae = downside
  }
  return { mfe10: mfe, mae10: mae }
}

/** null / non-finite を除いた平均。0 件は `{ n: 0, avg: null }`。 */
export function avgNonNull(values: ReadonlyArray<number | null>): { n: number; avg: number | null } {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v))
  if (finite.length === 0) return { n: 0, avg: null }
  const sum = finite.reduce((a, b) => a + b, 0)
  return { n: finite.length, avg: sum / finite.length }
}

export interface DrawdownResult {
  /** Max decline from peak, in USD (positive). 0 if there are no trades. */
  maxDrawdownUsd: number
  /** Cumulative peak (USD) at the point of max drawdown. */
  peakUsd: number
  /** Cumulative value (USD) at the point of max drawdown. */
  troughUsd: number
}

/** Cumulates round-trip realizedPnl in exit order and returns the max peak-to-trough decline in USD. No equity denominator here, so no percentage. */
export function computeDrawdown(trips: readonly RoundTrip[]): DrawdownResult {
  const sorted = [...trips].sort((a, b) => (a.exitAt < b.exitAt ? -1 : a.exitAt > b.exitAt ? 1 : 0))
  let cum = 0
  let peak = 0
  let maxDd = 0
  let peakAtMaxDd = 0
  let troughAtMaxDd = 0
  for (const t of sorted) {
    if (t.realizedPnl === null || !Number.isFinite(t.realizedPnl)) continue
    cum += t.realizedPnl
    if (cum > peak) peak = cum
    const dd = peak - cum
    if (dd > maxDd) {
      maxDd = dd
      peakAtMaxDd = peak
      troughAtMaxDd = cum
    }
  }
  return { maxDrawdownUsd: maxDd, peakUsd: peakAtMaxDd, troughUsd: troughAtMaxDd }
}

export interface TurnoverResult {
  buyNotionalUsd: number
  sellNotionalUsd: number
  totalNotionalUsd: number
  /** totalNotional / avgEquity. Null when avgEquity is null or <= 0. */
  turnoverRatio: number | null
}

export function computeTurnover(
  fills: readonly LifecycleFill[],
  avgEquityUsd: number | null,
): TurnoverResult {
  let buyNotionalUsd = 0
  let sellNotionalUsd = 0
  for (const f of fills) {
    // Requires both price and qty finite and > 0 — a negative*negative
    // pair would otherwise pass as a positive notional.
    if (!Number.isFinite(f.price) || f.price <= 0 || !Number.isFinite(f.qty) || f.qty <= 0) continue
    const notional = f.price * f.qty
    if (!Number.isFinite(notional) || notional <= 0) continue
    if (f.side === 'BUY') buyNotionalUsd += notional
    else sellNotionalUsd += notional
  }
  const totalNotionalUsd = buyNotionalUsd + sellNotionalUsd
  const turnoverRatio =
    avgEquityUsd !== null && Number.isFinite(avgEquityUsd) && avgEquityUsd > 0
      ? totalNotionalUsd / avgEquityUsd
      : null
  return { buyNotionalUsd, sellNotionalUsd, totalNotionalUsd, turnoverRatio }
}

/** Plain sum of `estimated_cost` (round-trip cost is stored on the SELL row). Does not recompute it. */
export function sumEstimatedCost(fills: readonly LifecycleFill[]): number {
  let sum = 0
  for (const f of fills) {
    if (f.estimatedCost !== null && Number.isFinite(f.estimatedCost)) sum += f.estimatedCost
  }
  return sum
}

/**
 * Cross-tabs stop-loss exits against same-day `extended_hours_observation.status`.
 * `statusBySymbolNyDay` is the loader's `${symbol}|${NY YYYY-MM-DD}` → status
 * lookup; a day with no observation counts as 'NO_OBSERVATION'. Converts
 * the SL exit's UTC timestamp to an NY calendar date via `formatNyYmd`,
 * since the observation producer itself keys on NY session date.
 */
export function crossTabSlExitsWithExtendedHours(
  slExits: ReadonlyArray<{ symbol: string; exitAt: string }>,
  statusBySymbolNyDay: ReadonlyMap<string, string>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const exit of slExits) {
    const t = new Date(exit.exitAt)
    const nyYmd = Number.isFinite(t.getTime()) ? formatNyYmd(t) : ''
    const key = `${exit.symbol}|${nyYmd}`
    const status = nyYmd ? (statusBySymbolNyDay.get(key) ?? 'NO_OBSERVATION') : 'NO_OBSERVATION'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}
