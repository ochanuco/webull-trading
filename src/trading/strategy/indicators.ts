import { countTradingDaysBetween, type TradingMarket } from '../domain/tradingCalendar'

/** Field names mirror Webull's camelCased OHLC payload so the client-side mapper stays trivial. */
export interface DailyBar {
  date: string
  open: number
  high: number
  low: number
  close: number
}

const BASELINE_EXCLUDE_RECENT = 20 // atr20's own window
const BASELINE_MAX_SAMPLES = 60 // ~3 months
const BASELINE_PERCENTILE_SAMPLES = 250 // ~1 year

export interface PullbackIndicatorSnapshot {
  price: number
  sma50: number
  /** 20-day return. Named `return50d` for storage/dashboard compat with `strategy_decision_log.indicators_json`. */
  return50d: number
  /** 10-day reference high for pullback entries. Named `high20d` for storage/dashboard compat. */
  high20d: number
  /** 20-day low. Unused by strategy logic — computed for the dashboard's support-line overlay. */
  low20d: number
  atr20: number
  /** Long-run ATR baseline; see `AtrBaselineMode` for how it's built. */
  baselineAtr20: number
  /** Prior-20-session close high, excluding today. Momentum-only; 0 when fewer than 21 bars. */
  breakoutHigh20: number
}

/**
 * How `baselineAtr20` compares recent volatility to its own history:
 * - `overlap` (default): trailing 60 bars, including atr20's own 20-bar
 *   window — the overlap damps the ratio, so no `maxAtrRatio` threshold
 *   reliably trips it. Kept as default only because switching requires
 *   re-calibrating `maxAtrRatio` and the sizing atr-floor together.
 * - `exclude-recent`: trailing 60 bars excluding the last 20 — an honest
 *   recent-vs-prior ratio, but backtests showed results swinging 4x across
 *   nearby thresholds.
 * - `percentile`: the symbol's own p80 of rolling atr20 — normalizes across
 *   symbols with very different baseline volatility (e.g. SOXL vs VUG).
 */
export type AtrBaselineMode = 'overlap' | 'exclude-recent' | 'percentile'

export interface PullbackIndicatorOptions {
  /** Defaults to 'percentile' (production default). */
  baselineMode?: AtrBaselineMode
}

function isUsableIntradayPrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Computes PullbackUptrendStrategy's inputs from the last ~60 daily bars
 * (oldest-first). Returns null when there isn't enough history to warm up.
 */
export function computePullbackIndicators(
  bars: DailyBar[],
  intradayPrice?: number | null,
  options?: PullbackIndicatorOptions,
): PullbackIndicatorSnapshot | null {
  // Warmup is gated by sma50's 50-bar requirement, not by the shorter
  // return/high lookbacks below.
  if (bars.length < 50) return null

  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const last = closes[closes.length - 1]!
  const returnLookbackClose = closes[closes.length - 20]!
  if (returnLookbackClose <= 0) return null

  const sma50 = average(closes.slice(-50))
  const pullbackReferenceHigh = Math.max(...highs.slice(-10))
  const supportLow = Math.min(...lows.slice(-20))
  // Excludes today: reusing pullbackReferenceHigh (which includes today)
  // would make the breakout self-referential and never fire.
  const breakoutReferenceHigh = Math.max(...closes.slice(-21, -1))
  const trendReturn = (last - returnLookbackClose) / returnLookbackClose

  const trueRanges = computeTrueRanges(bars)
  if (trueRanges.length < 20) return null
  const atr20 = average(trueRanges.slice(-20))
  const mode: AtrBaselineMode = options?.baselineMode ?? 'percentile'
  let baselineAtr20: number
  if (mode === 'percentile') {
    const rolling: number[] = []
    for (let end = trueRanges.length; end >= 20; end -= 1) {
      rolling.push(average(trueRanges.slice(end - 20, end)))
      if (rolling.length >= BASELINE_PERCENTILE_SAMPLES) break
    }
    baselineAtr20 = percentile(rolling, 0.8)
  } else if (mode === 'exclude-recent') {
    baselineAtr20 = average(trueRanges.slice(0, -BASELINE_EXCLUDE_RECENT).slice(-BASELINE_MAX_SAMPLES))
  } else {
    baselineAtr20 = average(trueRanges.slice(-Math.min(trueRanges.length, BASELINE_MAX_SAMPLES)))
  }

  const price = isUsableIntradayPrice(intradayPrice) ? intradayPrice : last

  return {
    price,
    sma50,
    return50d: trendReturn,
    high20d: pullbackReferenceHigh,
    low20d: supportLow,
    atr20,
    baselineAtr20,
    breakoutHigh20: breakoutReferenceHigh,
  }
}

export function computeHoldBusinessDays(
  openedAtIso: string,
  now: Date,
  market: TradingMarket,
): number {
  return countTradingDaysBetween(openedAtIso, now, market)
}

function computeTrueRanges(bars: DailyBar[]): number[] {
  const tr: number[] = []
  for (let i = 1; i < bars.length; i += 1) {
    const curr = bars[i]!
    const prev = bars[i - 1]!
    tr.push(
      Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close),
      ),
    )
  }
  return tr
}

/** Sorted, no interpolation. Empty array returns 0. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))
  return sorted[idx]!
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}
