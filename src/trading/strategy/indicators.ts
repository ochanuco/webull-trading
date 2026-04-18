import { countTradingDaysBetween, type TradingMarket } from '../domain/tradingCalendar'

/**
 * Daily OHLC bar. Field names match Webull's camel-cased data API payloads
 * (close / high / low / open) to keep the mapper on the client side trivial.
 */
export interface DailyBar {
  date: string
  open: number
  high: number
  low: number
  close: number
}

export interface PullbackIndicatorSnapshot {
  price: number
  sma50: number
  return50d: number
  high20d: number
  atr20: number
  baselineAtr20: number
}

/**
 * Computes the inputs PullbackUptrendStrategy needs from the last ~60 daily
 * bars. `bars` must be oldest-first. Returns `null` when the window is too
 * short — strategy stays HOLD rather than fire on half-initialized data.
 */
export function computePullbackIndicators(bars: DailyBar[]): PullbackIndicatorSnapshot | null {
  if (bars.length < 50) return null

  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const last = closes[closes.length - 1]!
  const baseline = closes[closes.length - 50]!
  if (baseline <= 0) return null

  const sma50 = average(closes.slice(-50))
  const high20d = Math.max(...highs.slice(-20))
  const return50d = (last - baseline) / baseline

  const trueRanges = computeTrueRanges(bars)
  if (trueRanges.length < 20) return null
  const atr20 = average(trueRanges.slice(-20))
  // Baseline ATR = longer-window average that `computePullbackSizing` compares
  // against to decide whether to floor the size. 60 bars ≈ ~3 months daily.
  const baselineAtr20 = average(trueRanges.slice(-Math.min(trueRanges.length, 60)))

  return { price: last, sma50, return50d, high20d, atr20, baselineAtr20 }
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

function average(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}
