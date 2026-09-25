import type { Env } from '../../../config/env'
import { MAX_TIME_STOP_DAYS } from '../../../infrastructure/db/schema'
import { type EvalIndicatorPoint } from '../../../trading/strategy/entryDistance'
import type { PullbackIndicators } from '../../../trading/strategy/strategies/PullbackUptrendStrategy'
import { SymbolStateClient } from '../../../trading/state/SymbolStateClient'
import { YahooBarClient } from '../../../infrastructure/quotes/YahooBarClient'
import { cachedDashboardJson } from './dashboardBarsCache'
import { type DecisionRow, cronDecisionJson, renderChartDecisionTrace } from '../cron'
import { currencyOfSymbol, exportMeta, messageOf, parseJsonObject } from '../shared'

// Prefers the most recently filled symbol over the universe's first entry:
// a trader opening this chart wants to check "did the rule interpretation
// match reality" against a symbol that actually traded.
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
  /** Links to `/dashboard/trades?clientOrderId=`; optional/null on older rows that predate the column. */
  clientOrderId?: string | null
}

/**
 * One closed BUY→SELL round-trip, drawn as a markArea. Excludes open
 * positions (BUY with no matching SELL) — shading through the chart's
 * right edge would misread as "closed here", so the position line handles
 * that case instead.
 */
export interface ClosedTradeSpan {
  openTimestamp: string
  closeTimestamp: string
  /** Realized PnL of the closing SELL; null on older fills that predate the column. */
  realizedPnl: number | null
}

// A run of consecutive BUYs (position add / split fill) doesn't move the
// span's start — the first BUY is when the position was opened, and that's
// what should be shaded. A SELL closes the span outright (POC strategy
// never partial-sells). A SELL with no preceding BUY (manual trade, data
// gap) is dropped rather than treated as a span.
export function pairClosedTrades(fills: SymbolChartMarker[]): ClosedTradeSpan[] {
  const spans: ClosedTradeSpan[] = []
  let openStart: string | null = null
  for (const m of fills) {
    if (m.side === 'BUY') {
      if (openStart === null) openStart = m.timestamp
    } else if (openStart !== null) {
      spans.push({
        openTimestamp: openStart,
        closeTimestamp: m.timestamp,
        realizedPnl: m.realizedPnl,
      })
      openStart = null
    }
  }
  return spans
}

/**
 * A cron decision event plotted on the chart, syncing it with the strategy
 * decisions table. HOLD is excluded — the price line, fill pins, and
 * position/preview lines already represent that steady state, so only
 * BUY/SELL/SKIP/REJECT/ERROR are plotted.
 */
export interface SymbolChartDecision {
  id: number
  timestamp: string // ISO UTC (eval time)
  price: number
  decision: 'BUY' | 'SELL' | 'SKIP' | 'REJECT' | 'ERROR'
  /** Raw (English) reason; localized in the tooltip. */
  reason: string | null
  /**
   * Pre-rendered ladder HTML (`renderDecisionLadder` output) that the
   * client drops straight into innerHTML on click, rather than duplicating
   * the ladder rendering logic in JS. Already `esc()`-escaped.
   */
  ladderHtml: string
}

export interface SymbolChartPosition {
  /** Latest BUY's filled_price; partial fills / position adds aren't averaged in (POC). */
  avgPrice: number
  /** Entry timestamp, formatted for JST display. */
  openedAt: string
  /**
   * Optional/nullable: sourced from either `fetchDoPosition` (real DO qty)
   * or `deriveOpenPosition` (latest BUY's qty), both of which can come back
   * without it. Consumers predating this field ignore it safely.
   */
  qty?: number | null
}

export interface SymbolChartRules {
  /** -0.03 = -3% (pullback-too-shallow threshold) */
  pullbackMax: number
  /** -0.15 = -15% (pullback-too-deep threshold) */
  pullbackMin: number
  /** -0.04 = -4% (stop-loss line) */
  stopPct: number
  /** 0.07 = +7% (take-profit line) */
  takeProfitPct: number
  /** Business days; used for the chart's SQL window, not by the chart logic itself. */
  timeStopDays: number
}

// Ceiling on the chart window so a large timeStopDays can't blow it up:
// MAX_TIME_STOP_DAYS=365 → 2*365+4 = 734 calendar days.
const MAX_WINDOW_DAYS = Math.ceil(MAX_TIME_STOP_DAYS * 2 + 4)

// ~2N+4 calendar days per N business days covers weekends plus a holiday
// buffer, so a run spanning New Year's or Golden Week doesn't miss its
// entry. Floored at 14 and capped at MAX_WINDOW_DAYS.
export function computeChartWindowDays(timeStopDays: number): number {
  const dynamic = Math.ceil(timeStopDays * 2 + 4)
  return Math.min(Math.max(dynamic, 14), MAX_WINDOW_DAYS)
}

// Guards payload size — each plotted point carries a pre-rendered ladder
// HTML string. Rarely hit in practice since HOLD (the bulk of eval rows)
// is excluded from the plotted set below.
export const MAX_CHART_DECISIONS = 250

const CHART_PLOTTED_DECISIONS: ReadonlySet<string> = new Set(['BUY', 'SELL', 'SKIP', 'REJECT', 'ERROR'])

interface PivotPoint {
  /** ISO UTC timestamp of the daily bar */
  timestamp: string
  price: number
  type: 'high' | 'low'
}

/**
 * `pivots[0]` is the line's left end and `end` its right end (extrapolated
 * to the chart's latest timestamp) under the current linear-regression fit.
 * `pivots[1]` is unused by `densifyTrendLine` — kept equal to `end` only so
 * this type still fits the older pivot-based shape.
 */
export interface TrendLineSegment {
  pivots: [PivotPoint, PivotPoint]
  end: { timestamp: string; price: number }
}

/** 15-minute OHLC (Yahoo intraday bars), for candlestick rendering. */
interface OhlcBar {
  timestamp: string // ISO UTC (Yahoo intraday bar-open time, second precision)
  open: number
  high: number
  low: number
  close: number
}

export interface SymbolChartData {
  symbol: string
  points: SymbolChartPoint[]
  markers: SymbolChartMarker[]
  /** Current holding (BUY with no matching SELL yet), or null if flat. */
  position: SymbolChartPosition | null
  rules: SymbolChartRules
  /** Linear-regression fit of the last 30 days' daily closes; null if fewer than 2 points. */
  trendLine: TrendLineSegment | null
  /** Yahoo daily OHLC for the candlestick; empty means the Yahoo fetch failed. */
  intradayBars: OhlcBar[]
  /**
   * Price of the latest cron-eval point (pre-merge, so Yahoo daily filler
   * is excluded). Used for the preview stop/TP line: `points`' own tail can
   * be a Yahoo filler point (an old daily close the strategy never actually
   * evaluated against), which would draw the preview off a price the
   * strategy didn't see. Null when strategy_decision_log has no rows.
   */
  latestCronPrice: number | null
  /** Timestamp of `latestCronPrice`; null skips the preview line entirely. */
  latestCronTimestamp: string | null
  /** Optional/additive — renderers fall back to `|| []` for fixtures predating this field. */
  decisions?: SymbolChartDecision[]
  /** Optional/additive — renderers fall back to `|| []` for fixtures predating this field. */
  evalIndicators?: EvalIndicatorPoint[]
  /** Optional/additive — renderers fall back to `|| []` for fixtures predating this field. */
  holdingSpans?: ClosedTradeSpan[]
}

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
      // strftime formats the bound side as ISO UTC ("...T...:...Z") to match
      // the stored format — SQLite's default datetime() uses a space
      // separator, which would misalign the >= comparison at the boundary.
      .prepare(
        `SELECT id, timestamp, price, decision, reason, indicators_json, trace_json
         FROM strategy_decision_log
         WHERE symbol = ?
           AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         ORDER BY id ASC`,
      )
      .bind(symbol, `-${windowDays} days`)
      .all<{
        id: number
        timestamp: string
        price: number | null
        decision: string | null
        reason: string | null
        indicators_json: string | null
        trace_json: string | null
      }>(),
    db
      // post_submit rows never carry `side` (only pre_submit does), so it's
      // joined in here; resolveFillSide falls back to inferring it from
      // realized_pnl for older fills with no matching pre_submit row.
      .prepare(
        `SELECT
           ps.timestamp AS timestamp,
           pre.side AS pre_side,
           ps.filled_price AS filled_price,
           ps.filled_qty AS filled_qty,
           ps.realized_pnl AS realized_pnl,
           ps.client_order_id AS client_order_id
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
        client_order_id: string | null
      }>(),
    fetchDoPosition(env, symbol),
  ])
  const logs = logsResult.results ?? []
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
  const decisions: SymbolChartDecision[] = logs
    .filter(
      (r) =>
        r.price !== null &&
        Number.isFinite(Number(r.price)) &&
        CHART_PLOTTED_DECISIONS.has((r.decision ?? '').toUpperCase()),
    )
    .map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      price: Number(r.price),
      decision: (r.decision ?? '').toUpperCase() as SymbolChartDecision['decision'],
      reason: r.reason,
      ladderHtml: renderChartDecisionTrace(r.trace_json, r.decision ?? '', r.reason, currencyOfSymbol(symbol)),
    }))
    .slice(-MAX_CHART_DECISIONS)

  // sma50/high20d/return50d are daily indicators, so this collapses the
  // 5-minute cron's intraday duplicates to one (the day's last) eval per
  // JST day — insertion order tracks first-seen-day order, and a later
  // same-day eval simply overwrites the map entry.
  const evalByDay = new Map<string, EvalIndicatorPoint>()
  for (const r of logs) {
    const indicators = parseFullIndicators(r.indicators_json)
    if (!indicators) continue
    const dayKey = jstDayKey(r.timestamp)
    if (!dayKey) continue
    evalByDay.set(dayKey, { timestamp: r.timestamp, indicators })
  }
  const evalIndicators: EvalIndicatorPoint[] = Array.from(evalByDay.values()).slice(
    -MAX_EVAL_INDICATOR_DAYS,
  )

  const markers: SymbolChartMarker[] = (fillsResult.results ?? [])
    .filter((r) => r.filled_price !== null)
    .map((r) => ({
      timestamp: r.timestamp,
      side: resolveFillSide(r.pre_side, r.realized_pnl),
      price: Number(r.filled_price),
      qty: r.filled_qty === null ? null : Number(r.filled_qty),
      realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
      clientOrderId: r.client_order_id ?? null,
    }))
  // undefined (no binding, or the DO call failed) falls back to deriving
  // position from fills rather than reporting "no position".
  const position = doPosition !== undefined ? doPosition : deriveOpenPosition(markers)

  // Independent fetches (each keyed only on symbol), run in parallel.
  // cronLastTs depends only on `points` (already in hand), so it's
  // computed before either fetch resolves.
  //
  // Both go through the dashboard-only cache (`cachedDashboardJson`) —
  // display cadence, not cron's own Yahoo calls, so this can't affect
  // trading data freshness.
  const cronLastTs = points.length > 0 ? points[points.length - 1]!.timestamp : null
  const [yahooBarsRaw, intradayFetch] = await Promise.all([
    // A failed fetch degrades to cron-eval points only (shorter price line,
    // not fatal) — see the empty-array catch below.
    cachedDashboardJson('dailyBars60', { symbol }, () => fetchYahooBarsForChart(symbol, 60), {
      // Not cached when empty, so an outage can recover within the next
      // request rather than being pinned for a full TTL.
      shouldCache: (v) => v.length > 0,
    }),
    // Strategy cron still evaluates on 60m bars (pullbackScheduler); this
    // 15m fetch is display-only. RangeError signals a caller-contract bug
    // and is re-thrown; any other failure (network, etc.) degrades to an
    // empty array so the candlestick is simply skipped.
    (async (): Promise<Array<{ timestamp: string; open: number; high: number; low: number; close: number }>> => {
      try {
        return await cachedDashboardJson(
          'intraday15m',
          { symbol },
          () => new YahooBarClient().getIntradayBars(symbol, '15m'),
          { shouldCache: (v) => v.length > 0 },
        )
      } catch (err) {
        if (err instanceof RangeError) throw err
        return []
      }
    })(),
  ])
  const yahooBars =
    cronLastTs == null ? yahooBarsRaw : yahooBarsRaw.filter((b) => b.timestamp <= cronLastTs)

  // Snapshotted pre-merge — see SymbolChartData.latestCronPrice for why.
  const { latestCronPrice, latestCronTimestamp } = selectLatestCronSnapshot(points)

  const mergedPoints = mergeYahooAndCronPoints(yahooBars, points)
  const lastTimestamp =
    mergedPoints.length > 0 ? mergedPoints[mergedPoints.length - 1]!.timestamp : null

  // 30 calendar days keeps the fit inside one regime. Prefers Yahoo daily
  // closes when there are at least 5; below that, falls back to cron-eval
  // closes (still all it has, even under 30 days — computeLinearRegressionLine
  // returns null itself below 2 points).
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
  // Drops bars newer than the last cron eval, so the candlestick can't show
  // a bar past what the chart's other series (price/decision points) cover.
  const intradayBars: OhlcBar[] = (
    cronLastTs == null ? intradayFetch : intradayFetch.filter((b) => b.timestamp <= cronLastTs)
  ).map((b) => ({
    timestamp: b.timestamp,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }))
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
    decisions,
    evalIndicators,
    // markers is already id-ASC (time-ascending) from the SQL, which is
    // what pairClosedTrades requires to pair BUY/SELL correctly.
    holdingSpans: pairClosedTrades(markers),
  }
}

// Must be called with pre-merge (strategy_decision_log-only) points — see
// SymbolChartData.latestCronPrice for why. Passing merged points still
// works but silently picks up a Yahoo filler point instead.
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

export function mergeYahooAndCronPoints(
  yahooBars: Array<{ jstDate: string; close: number; sma50?: number | null; timestamp: string }>,
  cronPoints: SymbolChartPoint[],
): SymbolChartPoint[] {
  // An invalid cron timestamp would break the ECharts time axis and the
  // chart's own last-point lookup (lastTimestamp = mergedPoints[-1]).
  const validCronPoints = cronPoints.filter((p) =>
    Number.isFinite(new Date(p.timestamp).getTime()),
  )
  const yahooSmaByJstDate = new Map<string, number | null>(
    yahooBars.map((b) => [b.jstDate, b.sma50 ?? null]),
  )
  const cronJstDates = new Set(
    validCronPoints.map((p) =>
      new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    ),
  )
  // Backfills sma50 from the Yahoo bar of the same JST day when the cron
  // row's own indicators_json.sma50 is null (older rows), so the line
  // doesn't break; a cron row that already has sma50 keeps its own value.
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

// RangeError (invalid lookback) is a caller bug and is re-thrown; any other
// failure (network, parse, transient) degrades to an empty array.
export async function fetchYahooBarsForChart(
  symbol: string,
  lookback: number,
): Promise<Array<{ jstDate: string; open: number; high: number; low: number; close: number; sma50: number | null; timestamp: string }>> {
  // Rejected here rather than left to getDailyBars(lookback+warmup): once
  // warmup is added, lookback=0 or a small negative becomes a positive
  // inner value and slides past that validation (e.g. slice(-0) === slice(0)
  // returns the whole warmup range instead of erroring).
  if (!Number.isInteger(lookback) || lookback <= 0) {
    throw new RangeError(
      `fetchYahooBarsForChart: lookback must be a positive integer, got ${lookback}`,
    )
  }
  const client = new YahooBarClient()
  try {
    // Fetches 50 extra days so SMA50 is populated from the first displayed
    // day, then slices back down to `lookback` below.
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
      timestamp: anchorJstMidnight(b.date),
    }))
    return enriched.length > lookback ? enriched.slice(-lookback) : enriched
  } catch (err) {
    // A RangeError here means the caller's lookback was invalid, which is
    // a bug at the call site — rethrown rather than silently degraded.
    if (err instanceof RangeError) throw err
    return []
  }
}

/**
 * Simple moving average; `out[i]` is null while i < window-1. Assumes NaN/Infinity-free input.
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

export function anchorJstMidnight(date: string): string {
  return new Date(`${date}T00:00:00+09:00`).toISOString()
}

// Dedupes cron-eval prices (which just replay the Yahoo daily close every
// 5 minutes) down to one close per JST day — the last eval of the day wins.
export function aggregateDailyCloses(
  points: SymbolChartPoint[],
): Array<{ jstDate: string; close: number; timestamp: string }> {
  const byDay = new Map<string, { jstDate: string; close: number; timestamp: string }>()
  for (const p of points) {
    if (p.price == null || !Number.isFinite(p.price)) continue
    const ms = new Date(p.timestamp).getTime()
    if (!Number.isFinite(ms)) continue
    const jstDate = new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
    byDay.set(jstDate, { jstDate, close: p.price, timestamp: p.timestamp })
  }
  return [...byDay.values()].sort((a, b) => (a.jstDate < b.jstDate ? -1 : 1))
}

/**
 * Ordinary-least-squares fit of `close` over time, reusing
 * `TrendLineSegment`'s shape so `densifyTrendLine` can read it unchanged:
 * `pivots[0]` is the line's start, `pivots[1]` just duplicates `end`
 * (unused by densify, kept only so the type still holds two pivots).
 *
 * No regime filter: a regression takes the centroid of all samples, so
 * there's no "pivot from a different regime" to exclude — the ~30-day
 * window callers pass in is what keeps it inside one regime.
 */
export function computeLinearRegressionLine(
  samples: ReadonlyArray<{ timestamp: string; close: number }>,
  endTimestamp: string,
): TrendLineSegment | null {
  const points: Array<{ t: number; y: number; timestamp: string }> = []
  for (const s of samples) {
    const t = new Date(s.timestamp).getTime()
    const y = s.close
    if (!Number.isFinite(t)) continue
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    points.push({ t, y, timestamp: s.timestamp })
  }
  if (points.length < 2) return null
  points.sort((a, b) => a.t - b.t)
  if (points[0]!.t === points[points.length - 1]!.t) return null

  const tEnd = new Date(endTimestamp).getTime()
  if (!Number.isFinite(tEnd)) return null

  // t is normalized to an offset from the earliest sample so the OLS sums
  // don't lose precision to the epoch-ms magnitude (~1.7e12); slope is
  // unaffected by the shift.
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

  const startT = points[0]!.t
  const startY = intercept + slope * (startT - t0)
  const endY = intercept + slope * (tEnd - t0)
  if (!Number.isFinite(startY) || !Number.isFinite(endY)) return null

  const startPoint: PivotPoint = {
    timestamp: points[0]!.timestamp,
    price: startY,
    type: 'low', // unused by rendering; arbitrary, kept only to satisfy the type
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
 * Expands a 2-point line into a dense `[[t, y], ...]` path. ECharts'
 * dataZoom drops a line series entirely once either of its 2 points falls
 * outside the zoomed range — `filterMode: 'weakFilter'` alone didn't fix
 * every case seen in the field. Giving the series a point at every
 * intradayBars timestamp (~1500 over 60 days) guarantees several points
 * stay inside any zoom window, independent of filterMode.
 *
 * Points outside [p1, end] are linearly extrapolated at the same slope, so
 * the line doesn't visually stop short of the chart edge.
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
  // Same timestamp on both points leaves the slope undefined.
  if (t1 === t2) return [[t1, y1], [t2, y2]]
  const slope = (y2 - y1) / (t2 - t1)
  const tsSet = new Set<number>()
  for (const s of sampleTimestamps) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (Number.isFinite(t)) tsSet.add(t)
  }
  // Always include the line's own 2 points, so the exact pivot/end y is preserved.
  tsSet.add(t1)
  tsSet.add(t2)
  const sorted = Array.from(tsSet).sort((a, b) => a - b)
  // No samples (e.g. Yahoo intraday fetch failed) falls back to the 2 raw points.
  if (sorted.length < 2) return [[t1, y1], [t2, y2]]
  const out: Array<[number, number]> = []
  for (const t of sorted) {
    const y = y1 + slope * (t - t1)
    if (Number.isFinite(y)) out.push([t, y])
  }
  if (out.length < 2) return [[t1, y1], [t2, y2]]
  return out
}

/**
 * Same densify-for-dataZoom fix as `densifyTrendLine`, specialized to
 * slope=0, for horizontal lines (avg cost, stop, take-profit).
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
  // fromTs >= toTs (e.g. openedAt after the latest timestamp, right after
  // cron starts) — callers already clamp against this, but fall back to
  // the 2 raw endpoints defensively rather than produce an empty series.
  if (a >= b) return [[a, yValue], [b, yValue]]
  const tsSet = new Set<number>()
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

// Falls back to inferring side from realized_pnl (set only on exits, by
// reconcileFills) when there's no joined pre_submit row to read it from.
export function resolveFillSide(
  preSide: string | null,
  realizedPnl: number | null,
): 'BUY' | 'SELL' {
  if (preSide === 'BUY' || preSide === 'SELL') return preSide
  if (realizedPnl !== null && Number.isFinite(realizedPnl)) return 'SELL'
  return 'BUY'
}

// undefined (no binding, or the DO call failed) signals "fall back to
// deriveOpenPosition"; null means the DO explicitly reports no position.
export async function fetchDoPosition(
  env: Env,
  symbol: string,
): Promise<SymbolChartPosition | null | undefined> {
  if (!env.SYMBOL_STATE) return undefined
  try {
    const state = await new SymbolStateClient(env.SYMBOL_STATE).getState(symbol)
    if (!state.position) return null
    return {
      avgPrice: state.position.avgPrice,
      openedAt: state.position.openedAt,
      qty: state.position.qty,
    }
  } catch {
    return undefined
  }
}

// Latest BUY not yet closed by a later SELL is the open position. Partial
// fills / position adds aren't tracked (POC) — only the latest BUY counts.
export function deriveOpenPosition(markers: SymbolChartMarker[]): SymbolChartPosition | null {
  let latestBuy: SymbolChartMarker | null = null
  for (const m of markers) {
    if (m.side === 'BUY') latestBuy = m
    else if (m.side === 'SELL') latestBuy = null
  }
  return latestBuy
    ? { avgPrice: latestBuy.price, openedAt: latestBuy.timestamp, qty: latestBuy.qty }
    : null
}

export function extractSma50(indicatorsJson: string | null): number | null {
  return parseIndicators(indicatorsJson).sma50
}

interface ExtractedIndicators {
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

// low20d was added after sma50/high20d, so older rows' indicators_json
// simply lack it — null rather than an error, ages out as cron re-runs.
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

// Entry-distance calc needs all 6 fields; any one missing/non-finite drops
// the whole eval day from consideration rather than computing with a gap.
function parseFullIndicators(indicatorsJson: string | null): PullbackIndicators | null {
  if (!indicatorsJson) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(indicatorsJson) as Record<string, unknown>
  } catch {
    return null
  }
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const price = num(obj.price)
  const sma50 = num(obj.sma50)
  const return50d = num(obj.return50d)
  const high20d = num(obj.high20d)
  const atr20 = num(obj.atr20)
  const baselineAtr20 = num(obj.baselineAtr20)
  if (
    price === null ||
    sma50 === null ||
    return50d === null ||
    high20d === null ||
    atr20 === null ||
    baselineAtr20 === null
  ) {
    return null
  }
  return { price, sma50, return50d, high20d, atr20, baselineAtr20 }
}

const MAX_EVAL_INDICATOR_DAYS = 20

const JST_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function jstDayKey(iso: string): string | null {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return JST_DAY_FMT.format(new Date(t))
}

/**
 * Machine-readable form of the same data the SSR symbol tab renders. Drops
 * `decisions[].ladderHtml` (pre-rendered display HTML, no use to a
 * consumer) and parses `decisionHistory[].trace` into an object so callers
 * don't have to re-parse the raw JSON string themselves.
 */
export function buildSymbolChartPacket(chart: SymbolChartData, decisionRows: DecisionRow[]) {
  return {
    ...exportMeta('dashboard_chart_symbol_export.v1'),
    symbol: chart.symbol,
    rules: chart.rules,
    points: chart.points,
    markers: chart.markers,
    position: chart.position,
    trendLine: chart.trendLine,
    intradayBars: chart.intradayBars,
    latestCronPrice: chart.latestCronPrice,
    latestCronTimestamp: chart.latestCronTimestamp,
    evalIndicators: chart.evalIndicators ?? [],
    chartDecisions: (chart.decisions ?? []).map(({ ladderHtml: _ladderHtml, ...rest }) => rest),
    decisionHistory: decisionRows.map((r) => ({
      ...cronDecisionJson(r),
      requestId: r.requestId,
      trace: parseJsonObject(r.traceJson ?? null),
    })),
  }
}
