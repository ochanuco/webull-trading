import type { PullbackIndicators, SymbolRule } from './strategies/PullbackUptrendStrategy'

/**
 * 入場までの前向き距離。decision trace は最初に落ちたゲートで止まるため
 * 「あと何%動けば入場か」を出せない — 本モジュールは全ゲートを評価して
 * それを出す。ゲート式・順序・既定値は entryDecision と一致させること
 * (drift すると誤った入場ラインを描く)。
 */

type EntryGateKey =
  | 'trend'
  | 'above_sma50'
  | 'overextension'
  | 'volatility'
  | 'high20d_valid'
  | 'pullback_shallow'
  | 'pullback_deep'

export interface EntryGateStatus {
  key: EntryGateKey
  labelJa: string
  passed: boolean
  actual: number
  threshold: number
  /** 比較演算子 (例 '>', '<=')。 */
  operator: string
  /** 価格が動けば結果が変わるゲートか。trend/volatility/high20d_valid は価格非依存。 */
  priceDependent: boolean
}

export interface EntryDistance {
  buyable: boolean
  gates: EntryGateStatus[]
  /** 最初に不成立のゲート。buyable なら null。 */
  bindingGate: EntryGateStatus | null
  /** BUY が成立する最寄り価格。価格非依存ゲートが塞ぐ、または交差区間が空なら null。 */
  entryPrice: number | null
  /** (entryPrice - price) / price。負 = 下落が必要。entryPrice が null なら null。 */
  priceMove: number | null
}

const GATE_LABEL_JA: Record<EntryGateKey, string> = {
  trend: 'トレンド (直近騰落率)',
  above_sma50: 'SMA50 より上',
  overextension: '過熱していない (SMA50 乖離)',
  volatility: 'ボラ過熱でない (ATR比)',
  high20d_valid: '直近高値が有効',
  pullback_shallow: '押し目が浅すぎない',
  pullback_deep: '押し目が深すぎない',
}

const NEG_INF = Number.NEGATIVE_INFINITY
const POS_INF = Number.POSITIVE_INFINITY

/** `entryDecision` と同じゲート式・順序で評価する。 */
export function computeEntryDistance(ind: PullbackIndicators, rule: SymbolRule): EntryDistance {
  const { price, sma50, return50d, high20d, atr20, baselineAtr20 } = ind
  const sma50Deviation = sma50 > 0 ? (price - sma50) / sma50 : 0
  const atrRatio = baselineAtr20 > 0 ? atr20 / baselineAtr20 : 0
  const pullback = high20d > 0 ? (price - high20d) / high20d : 0

  const gates: EntryGateStatus[] = [
    {
      key: 'trend',
      labelJa: GATE_LABEL_JA.trend,
      passed: return50d > rule.minReturn50d,
      actual: return50d,
      threshold: rule.minReturn50d,
      operator: '>',
      priceDependent: false,
    },
    {
      key: 'above_sma50',
      labelJa: GATE_LABEL_JA.above_sma50,
      passed: !rule.requireAboveSma50 || price > sma50,
      actual: price,
      threshold: sma50,
      operator: '>',
      priceDependent: rule.requireAboveSma50,
    },
    {
      key: 'overextension',
      labelJa: GATE_LABEL_JA.overextension,
      passed: sma50Deviation <= rule.maxSma50DeviationPct,
      actual: sma50Deviation,
      threshold: rule.maxSma50DeviationPct,
      operator: '<=',
      priceDependent: true,
    },
    {
      key: 'volatility',
      labelJa: GATE_LABEL_JA.volatility,
      passed: atrRatio <= rule.maxAtrRatio,
      actual: atrRatio,
      threshold: rule.maxAtrRatio,
      operator: '<=',
      priceDependent: false,
    },
    {
      key: 'high20d_valid',
      labelJa: GATE_LABEL_JA.high20d_valid,
      passed: high20d > 0,
      actual: high20d,
      threshold: 0,
      operator: '>',
      priceDependent: false,
    },
    {
      key: 'pullback_shallow',
      labelJa: GATE_LABEL_JA.pullback_shallow,
      passed: pullback <= rule.pullbackMax,
      actual: pullback,
      threshold: rule.pullbackMax,
      operator: '<=',
      priceDependent: true,
    },
    {
      key: 'pullback_deep',
      labelJa: GATE_LABEL_JA.pullback_deep,
      passed: pullback >= rule.pullbackMin,
      actual: pullback,
      threshold: rule.pullbackMin,
      operator: '>=',
      priceDependent: true,
    },
  ]

  const bindingGate = gates.find((g) => !g.passed) ?? null
  const buyable = bindingGate === null

  const entryPrice = resolveNearestEntryPrice(ind, rule, gates)
  const priceMove = entryPrice !== null && price > 0 ? (entryPrice - price) / price : null

  return { buyable, gates, bindingGate, entryPrice, priceMove }
}

/**
 * 価格依存ゲートを全部満たす価格区間内で、現価格に最も近い点。価格非依存
 * ゲートが1つでも落ちていれば null。交差区間が空でも null。
 */
function resolveNearestEntryPrice(
  ind: PullbackIndicators,
  rule: SymbolRule,
  gates: EntryGateStatus[],
): number | null {
  const priceIndependentBlocked = gates.some((g) => !g.priceDependent && !g.passed)
  if (priceIndependentBlocked) return null

  const { sma50, high20d } = ind
  if (high20d <= 0) return null

  // pullbackMin < pullbackMax < 0 前提 (下端 < 上端)。
  const bandLow = high20d * (1 + rule.pullbackMin)
  const bandHigh = high20d * (1 + rule.pullbackMax)

  const sma50Low = rule.requireAboveSma50 ? sma50 : NEG_INF
  const overextHigh = sma50 > 0 ? sma50 * (1 + rule.maxSma50DeviationPct) : POS_INF

  const low = Math.max(bandLow, sma50Low)
  const high = Math.min(bandHigh, overextHigh)
  if (low > high) return null

  const nearestEntryPrice = Math.min(Math.max(ind.price, low), high)
  return Number.isFinite(nearestEntryPrice) ? nearestEntryPrice : null
}

interface BuyabilityDistancePoint {
  timestamp: string
  /** 現価格→最寄り入場価格の符号付き変化率。価格非依存ゲートが塞ぐ評価日は null。 */
  priceMove: number | null
  buyable: boolean
}

type BuyabilityTrend = 'closing' | 'widening' | 'flat' | 'unknown'

export interface BuyabilityView {
  /** 最新評価。評価ログが無ければ null。 */
  current: EntryDistance | null
  /** 直近 (日次ユニーク) の距離推移、時系列昇順。 */
  series: BuyabilityDistancePoint[]
  /** 距離が縮小/拡大/横ばい/判定不能。 */
  trend: BuyabilityTrend
  /** 縮小ペースの線形外挿 ETA (営業日、予測ではない)。縮小傾向なし/点不足/ブロック時は null。 */
  etaTradingDays: number | null
  /** チャート用の価格外挿線 (予測ではない)。entryPrice が無い/点不足なら null。 */
  projection: EntryProjection | null
}

export interface EntryProjection {
  /** 直近評価の価格 (外挿の起点)。 */
  lastPrice: number
  /** 1 評価ステップ (≈ 1 営業日) あたりの価格変化 (線形フィット傾き)。 */
  slopePerStep: number
  /** 入場ライン価格 (= EntryDistance.entryPrice)。交差判定の対象。 */
  entryPrice: number
  /** 外挿の向きが entryPrice に近づいているか。 */
  approaching: boolean
  /** 外挿価格が entryPrice に到達するまでの推定ステップ (営業日)。離反 / 横ばいは null。 */
  crossingSteps: number | null
  /** 外挿線を描く長さ (ステップ)。交差ありはその近辺まで、無ければ既定ホライズン。 */
  horizonSteps: number
}

/** ETA / trend 判定に使う直近評価日数 (日次ユニーク)。 */
const TREND_WINDOW = 5

/** 外挿線を描く既定ホライズン (営業日)。交差が無くても向きを見せる長さ。 */
const MAX_PROJECTION_STEPS = 10

/**
 * y 列の最小二乗傾き (x = 0,1,2,...)。点が 2 未満 / 退化なら null。
 */
function linregSlope(ys: number[]): number | null {
  const n = ys.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i += 1) {
    sx += i
    sy += ys[i]!
    sxx += i * i
    sxy += i * ys[i]!
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  return (n * sxy - sx * sy) / denom
}

/**
 * 直近 `TREND_WINDOW` 日の価格を線形フィットし、入場ライン (entryPrice) との
 * 交差ステップを出す (予測ではなく外挿)。entryPrice が無い/価格点が2未満なら null。
 */
export function buildEntryProjection(
  evals: EvalIndicatorPoint[],
  current: EntryDistance,
): EntryProjection | null {
  if (current.entryPrice === null) return null
  const prices = evals
    .slice(-TREND_WINDOW)
    .map((e) => e.indicators.price)
    .filter((p) => Number.isFinite(p))
  if (prices.length < 2) return null
  const slope = linregSlope(prices)
  const lastPrice = prices[prices.length - 1]!
  if (slope === null || !Number.isFinite(lastPrice)) return null
  const entryPrice = current.entryPrice

  let crossingSteps: number | null = null
  let approaching = false
  if (Math.abs(slope) > 1e-9) {
    const k = (entryPrice - lastPrice) / slope
    if (k > 0 && Number.isFinite(k)) {
      crossingSteps = k
      approaching = true
    }
  }
  const horizonSteps =
    crossingSteps !== null
      ? Math.min(Math.max(Math.ceil(crossingSteps), 1), MAX_PROJECTION_STEPS)
      : MAX_PROJECTION_STEPS
  return { lastPrice, slopePerStep: slope, entryPrice, approaching, crossingSteps, horizonSteps }
}

export interface EvalIndicatorPoint {
  timestamp: string
  indicators: PullbackIndicators
}

/** `evals` (時系列昇順、日次ユニーク推奨) から入場距離ビューを組み立てる。 */
export function buildBuyabilityView(evals: EvalIndicatorPoint[], rule: SymbolRule): BuyabilityView {
  if (evals.length === 0) {
    return { current: null, series: [], trend: 'unknown', etaTradingDays: null, projection: null }
  }
  const series: BuyabilityDistancePoint[] = evals.map((e) => {
    const d = computeEntryDistance(e.indicators, rule)
    return { timestamp: e.timestamp, priceMove: d.priceMove, buyable: d.buyable }
  })
  const current = computeEntryDistance(evals[evals.length - 1]!.indicators, rule)

  // priceMove が null (価格非依存ブロック) の評価日は trend/ETA の対象外。
  const recent = series.slice(-TREND_WINDOW).filter((p) => p.priceMove !== null)
  const gaps = recent.map((p) => Math.abs(p.priceMove as number))
  const { trend, etaTradingDays } = estimateTrendAndEta(gaps)
  const projection = buildEntryProjection(evals, current)

  return { current, series, trend, etaTradingDays, projection }
}

/**
 * 連続する「入場までの距離 (絶対値)」列から、縮小/拡大トレンドと参考 ETA を出す。
 * 線形最小二乗で傾きを取り、負 (縮小) なら gap/|slope| を ETA とする。
 * gap の単位は分数 (例 0.018 = 1.8%)、index は評価ステップ (≈ 1 営業日)。
 */
function estimateTrendAndEta(gaps: number[]): { trend: BuyabilityTrend; etaTradingDays: number | null } {
  if (gaps.length < 2) return { trend: 'unknown', etaTradingDays: null }
  const slope = linregSlope(gaps)
  if (slope === null) return { trend: 'flat', etaTradingDays: null }
  const lastGap = gaps[gaps.length - 1]!
  // 1 評価あたり 0.05% 未満の傾きは横ばい扱い (ノイズを widening/closing に誤分類しない)。
  const FLAT_EPS = 0.0005
  if (Math.abs(slope) < FLAT_EPS) return { trend: 'flat', etaTradingDays: null }
  if (slope >= 0) return { trend: 'widening', etaTradingDays: null }
  const eta = lastGap / -slope
  if (!Number.isFinite(eta) || eta <= 0) return { trend: 'closing', etaTradingDays: null }
  return { trend: 'closing', etaTradingDays: eta }
}
