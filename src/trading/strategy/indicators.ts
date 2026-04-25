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
  /**
   * 20 日安値 (low20d) — 戦略 ロジック上は未使用、dashboard 個別銘柄チャートで
   * 「下値支持線」として可視化するために計算 (`high20d` と対称な指標)。
   */
  low20d: number
  atr20: number
  baselineAtr20: number
}

/**
 * Computes the inputs PullbackUptrendStrategy needs from the last ~60 daily
 * bars. `bars` must be oldest-first. Returns `null` when the window is too
 * short — strategy stays HOLD rather than fire on half-initialized data.
 *
 * `intradayPrice` (optional) は cron が当日最新 1h close を渡す経路。指定が
 * あればそれを `price` として採用 (= chart 表示の candle と整合する fill 価格)。
 * NaN / Infinity / 0 / 負値 / null / undefined はすべて無視して daily close
 * (前日終値) に fallback し、既存挙動と等価になる。SMA50 / ATR / return50d /
 * high20d / low20d は引き続き daily bars から計算する (intradayPrice は影響
 * しない)。
 */
export function computePullbackIndicators(
  bars: DailyBar[],
  intradayPrice?: number | null,
): PullbackIndicatorSnapshot | null {
  if (bars.length < 50) return null

  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const last = closes[closes.length - 1]!
  const baseline = closes[closes.length - 50]!
  if (baseline <= 0) return null

  const sma50 = average(closes.slice(-50))
  const high20d = Math.max(...highs.slice(-20))
  const low20d = Math.min(...lows.slice(-20))
  const return50d = (last - baseline) / baseline

  const trueRanges = computeTrueRanges(bars)
  if (trueRanges.length < 20) return null
  const atr20 = average(trueRanges.slice(-20))
  // Baseline ATR = longer-window average that `computePullbackSizing` compares
  // against to decide whether to floor the size. 60 bars ≈ ~3 months daily.
  const baselineAtr20 = average(trueRanges.slice(-Math.min(trueRanges.length, 60)))

  // intradayPrice がきちんと正値の有限数なら採用、そうでなければ daily close。
  // `> 0` で 0 / 負値もはじき、Number.isFinite で NaN / Infinity をはじく。
  const price =
    typeof intradayPrice === 'number' && Number.isFinite(intradayPrice) && intradayPrice > 0
      ? intradayPrice
      : last

  return { price, sma50, return50d, high20d, low20d, atr20, baselineAtr20 }
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
