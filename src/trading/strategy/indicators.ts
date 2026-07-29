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

/** baseline ATR から除外する直近本数 (= atr20 の窓)。 */
const BASELINE_EXCLUDE_RECENT = 20
/** baseline ATR に使う最大サンプル数 (≈ 3 か月)。 */
const BASELINE_MAX_SAMPLES = 60
/** percentile モードで参照する rolling ATR の本数 (≈ 1 年)。 */
const BASELINE_PERCENTILE_SAMPLES = 250

export interface PullbackIndicatorSnapshot {
  price: number
  sma50: number
  /**
   * 騰落率トレンド filter。**issue #318 で window を 50d → 20d に短縮した**
   * 短期 swing 整合化 (20d return + 10d high + 10d hold)。
   *
   * フィールド名 (`return50d`) は historical reasons でそのまま (D1 の
   * `strategy_decision_log.indicators_json` / dashboard / 既存 schema との
   * 互換維持のため)。**実体は 20 日リターン**。renaming は #318 follow-up。
   */
  return50d: number
  /**
   * 押し目買いの reference high。**issue #318 で window を 20d → 10d に短縮**
   * (短期 swing で 10d 高値からの押し目を捉える)。
   *
   * フィールド名 (`high20d`) は dashboard / 既存 indicators_json との互換維持
   * のためそのまま。**実体は 10 日高値**。
   */
  high20d: number
  /**
   * 20 日安値 (low20d) — 戦略 ロジック上は未使用、dashboard 個別銘柄チャートで
   * 「下値支持線」として可視化するために計算 (`high20d` と対称な指標)。
   */
  low20d: number
  atr20: number
  /**
   * 長期 ATR baseline。既定は直近 60 本平均 (atr20 の窓を**含む**)。
   * `excludeRecentFromBaseline` を立てると直近 20 本を除外した平均になり
   * (#atr-baseline-window)、`atr20 / baselineAtr20` が「直近 vs それ以前」の
   * 素直な比率になる。閾値の再校正が要るので既定は従来のまま。
   */
  baselineAtr20: number
  /**
   * ブレイクアウト基準 = **当日を除く** 直近 20 営業日の終値高値 (#momentum)。
   * `high20d`(当日含む高値)を流用すると自己参照で発火不能になるため別計算。
   * モメンタム戦略のみ使用 (押し目戦略は参照しない)。bars < 21 のとき 0。
   */
  breakoutHigh20: number
}

/**
 * Computes the inputs PullbackUptrendStrategy needs from the last ~60 daily
 * bars. `bars` must be oldest-first. Returns `null` when the window is too
 * short — strategy stays HOLD rather than fire on half-initialized data.
 *
 * `intradayPrice` (optional) は cron が当日最新 1h close を渡す経路。指定が
 * あればそれを `price` として採用 (= chart 表示の candle と整合する fill 価格)。
 * NaN / Infinity / 0 / 負値 / null / undefined はすべて無視して daily close
 * (前日終値) に fallback し、既存挙動と等価になる。SMA50 / ATR / return /
 * high / low20d は引き続き daily bars から計算する (intradayPrice は影響
 * しない)。
 *
 * **issue #318**: 短期 swing 整合化のため return lookback を 20d、pullback
 * reference high lookback を 10d に短縮。フィールド名 (`return50d` /
 * `high20d`) は storage / dashboard 互換のため据え置き。
 */
/**
 * baseline ATR の作り方 (#atr-baseline-window)。
 *
 * - `overlap` (既定): 直近 60 本平均。**atr20 の窓を内包する**ため比率が鈍り、
 *   実測では `maxAtrRatio` を何に設定しても発火しなかった (= ガードが死んでいる)
 * - `exclude-recent`: 直近 20 本を除いた平均。比率は素直になるが、閾値 0.3 の差で
 *   成績が 4 倍振れる実測結果が出ており、ノイズを拾いやすい
 * - `percentile`: **その銘柄自身の atr20 分布の p80**。銘柄ごとのボラ水準
 *   (SOXL 22% vs VUG 1.7%) に依存せず「その銘柄として高ボラか」を測る。
 *   `maxAtrRatio = 1.0` が「p80 超で見送り」になる
 */
export type AtrBaselineMode = 'overlap' | 'exclude-recent' | 'percentile'

export interface PullbackIndicatorOptions {
  /** baseline の作り方。未指定は 'percentile' (本番既定)。 */
  baselineMode?: AtrBaselineMode
}

export function computePullbackIndicators(
  bars: DailyBar[],
  intradayPrice?: number | null,
  options?: PullbackIndicatorOptions,
): PullbackIndicatorSnapshot | null {
  // SMA50 が 50 bars を必要とするので最小要件は 50。return/high の lookback が
  // 短くなっても warmup 要件は SMA50 に律速されたまま。
  if (bars.length < 50) return null

  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const last = closes[closes.length - 1]!
  // #318: return lookback は 20 営業日。`closes[-20]` を baseline に使う。
  const baseline = closes[closes.length - 20]!
  if (baseline <= 0) return null

  const sma50 = average(closes.slice(-50))
  // #318: pullback の reference high は 10 営業日。entry condition が
  // 「price <= high10d * (1 + pullbackMax)」になり、押し目判定が短期化する。
  const high20d = Math.max(...highs.slice(-10))
  const low20d = Math.min(...lows.slice(-20))
  // ブレイクアウト基準 (#momentum): 当日を除く直近 20 営業日の終値高値。
  // closes は >=50 本あるので slice(-21,-1) は常に 20 本。
  const breakoutHigh20 = Math.max(...closes.slice(-21, -1))
  // #318: return lookback 20 営業日に対応。`(last - closes[-20]) / closes[-20]`。
  const return50d = (last - baseline) / baseline

  const trueRanges = computeTrueRanges(bars)
  if (trueRanges.length < 20) return null
  const atr20 = average(trueRanges.slice(-20))
  // Baseline ATR (#atr-baseline-window)。60 本平均の中に atr20 の窓が丸ごと
  // 入っているので、直近ボラが跳ねると baseline も一緒に上がり比率が鈍る
  // (窓が重なる限り比率は理論上 3 倍で頭打ち)。`excludeRecentFromBaseline` で
  // 直近 20 本を除外した「直近 vs それ以前」の比率に切り替えられる。
  //
  // **既定は従来のまま**: 過熱ガード (maxAtrRatio 1.5) と sizing の atr-floor
  // (0.5) は重複窓前提で校正されており、除外に切り替えると押し目 entry が
  // ほぼ全滅する (テスト fixture で BUY 64 ケースが blocked になった)。
  // 切り替えは backtest で閾値を測り直してから。
  // bars >= 50 を上で保証しているので TR は 49 本以上あり、直近 20 本を除いても
  // 29 本以上残る (= サンプル不足の分岐は起き得ない)。
  const mode: AtrBaselineMode = options?.baselineMode ?? 'percentile'
  let baselineAtr20: number
  if (mode === 'percentile') {
    // その銘柄自身の atr20 分布の p80。rolling ATR を trailing 窓で作って
    // 分位点を取る (窓が足りなければ取れる分だけ)。
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

  // intradayPrice がきちんと正値の有限数なら採用、そうでなければ daily close。
  // `> 0` で 0 / 負値もはじき、Number.isFinite で NaN / Infinity をはじく。
  const price =
    typeof intradayPrice === 'number' && Number.isFinite(intradayPrice) && intradayPrice > 0
      ? intradayPrice
      : last

  return { price, sma50, return50d, high20d, low20d, atr20, baselineAtr20, breakoutHigh20 }
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

/** 昇順ソート後の線形補間なし分位点。空配列は 0。 */
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
