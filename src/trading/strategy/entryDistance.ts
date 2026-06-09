import type { PullbackIndicators, SymbolRule } from './strategies/PullbackUptrendStrategy'

/**
 * 「入場まであとどれくらい / いつ頃」可視化のための前向き距離計算
 * (#entry-distance)。`PullbackUptrendStrategy.entryDecision` の 7 ゲート連鎖を
 * **判定ではなく距離として**評価する:
 *
 *  - 各ゲートの現在値 vs 閾値 (checklist 用)
 *  - 最初に不成立になるゲート (= cron が見送る理由 = ボトルネック)
 *  - **今 BUY が成立する最寄り価格** (= 価格依存ゲートの交差区間のうち現価格に
 *    最も近い点)。価格非依存ゲート (トレンド / ボラ / high20d) が塞いでいる間は
 *    どんな価格でも入場できないので null。
 *
 * trace (#decision-trace) は early-exit で「最初に落ちたゲートまで」しか持たず、
 * 「あと価格がどれだけ動けば入場か」を出せない。本モジュールは全ゲートを
 * 評価して前向きの距離を出す点が異なる。entryDecision とゲート式・順序・
 * 既定値を一致させること (drift したら誤った入場ラインを描く)。
 */

export type EntryGateKey =
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
  /** ゲートが比較する指標の現在値 (ゲート固有の単位)。 */
  actual: number
  /** 比較先の閾値。 */
  threshold: number
  /** 人間可読の比較演算子 (例 '>', '<=')。 */
  operator: string
  /**
   * 現在価格に依存するゲートか (= 価格が動けば成否が変わりうる)。
   * trend / volatility / high20d_valid は価格非依存 (指標自体が変わらないと不変)。
   */
  priceDependent: boolean
}

export interface EntryDistance {
  buyable: boolean
  gates: EntryGateStatus[]
  /** 最初に不成立になったゲート (= 見送りの直接要因)。buyable なら null。 */
  bindingGate: EntryGateStatus | null
  /**
   * 今 BUY が成立する最寄り価格。価格依存ゲートの交差区間のうち現価格に最も
   * 近い点。価格非依存ゲートが塞いでいる / 価格区間が空 (構造的に同時成立不可)
   * の場合は null (= 価格を動かすだけでは入場できない)。
   */
  entryPrice: number | null
  /** 現価格→entryPrice の符号付き変化率 ((entryPrice - price) / price)。負 = 下落が必要。null = entryPrice null 時。 */
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

/**
 * 単一スナップショットの入場距離。`entryDecision` と同じゲート式・順序で評価する。
 */
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
      // requireAboveSma50=false なら常に通過 (entryDecision と同じ)
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
 * 価格依存ゲートをすべて満たす価格区間の中で、現価格に最も近い点を返す。
 * 価格非依存ゲート (トレンド / ボラ / high20d) が 1 つでも落ちていれば、価格を
 * 動かしても入場できないので null。区間が空 (band が SMA50 帯と交わらない等)
 * でも null。
 */
function resolveNearestEntryPrice(
  ind: PullbackIndicators,
  rule: SymbolRule,
  gates: EntryGateStatus[],
): number | null {
  // 価格非依存ゲートが落ちている間は、いくら価格が動いても入場不可。
  const priceIndependentBlocked = gates.some((g) => !g.priceDependent && !g.passed)
  if (priceIndependentBlocked) return null

  const { sma50, high20d } = ind
  if (high20d <= 0) return null

  // band: [high20d*(1+pullbackMin), high20d*(1+pullbackMax)]
  // pullbackMin < pullbackMax < 0 (例 -0.06 < -0.03) なので下端 < 上端。
  const bandLow = high20d * (1 + rule.pullbackMin)
  const bandHigh = high20d * (1 + rule.pullbackMax)

  // above_sma50 (require 時のみ下限): price > sma50
  const sma50Low = rule.requireAboveSma50 ? sma50 : NEG_INF
  // overextension 上限: price <= sma50*(1+maxSma50DeviationPct)
  const overextHigh = sma50 > 0 ? sma50 * (1 + rule.maxSma50DeviationPct) : POS_INF

  const low = Math.max(bandLow, sma50Low)
  const high = Math.min(bandHigh, overextHigh)
  if (low > high) return null // 同時成立する価格が存在しない (構造的にブロック)

  // 現価格に最も近い区間内の点 (= 最小の値動きで入場する価格)。
  const clamped = Math.min(Math.max(ind.price, low), high)
  return Number.isFinite(clamped) ? clamped : null
}

export interface BuyabilityDistancePoint {
  timestamp: string
  /** 現価格→最寄り入場価格の符号付き変化率。価格非依存ゲートが塞ぐ評価日は null。 */
  priceMove: number | null
  buyable: boolean
}

export type BuyabilityTrend = 'closing' | 'widening' | 'flat' | 'unknown'

export interface BuyabilityView {
  /** 最新評価の入場距離。評価ログが無ければ null。 */
  current: EntryDistance | null
  /** 直近 (日次ユニーク) の距離推移。時系列昇順。 */
  series: BuyabilityDistancePoint[]
  /** 距離が縮小 (入場に近づく) / 拡大 / 横ばい / 判定不能。 */
  trend: BuyabilityTrend
  /**
   * 参考 ETA (営業日)。直近の距離縮小ペースの線形外挿。**予測ではなく外挿の
   * 参考値**。縮小傾向が無い / 点が足りない / 価格非依存ブロック時は null。
   */
  etaTradingDays: number | null
}

/** ETA / trend 判定に使う直近評価日数 (日次ユニーク)。 */
const TREND_WINDOW = 5

export interface EvalIndicatorPoint {
  timestamp: string
  indicators: PullbackIndicators
}

/**
 * 直近の評価指標列から入場距離ビューを組み立てる。`evals` は時系列昇順
 * (日次ユニーク推奨) を想定。
 */
export function buildBuyabilityView(evals: EvalIndicatorPoint[], rule: SymbolRule): BuyabilityView {
  if (evals.length === 0) {
    return { current: null, series: [], trend: 'unknown', etaTradingDays: null }
  }
  const series: BuyabilityDistancePoint[] = evals.map((e) => {
    const d = computeEntryDistance(e.indicators, rule)
    return { timestamp: e.timestamp, priceMove: d.priceMove, buyable: d.buyable }
  })
  const current = computeEntryDistance(evals[evals.length - 1]!.indicators, rule)

  // trend / ETA は「価格距離 (priceMove) が定義される評価日」のみで判定する。
  // 価格非依存ブロック日 (priceMove=null) は対象外。
  const recent = series.slice(-TREND_WINDOW).filter((p) => p.priceMove !== null)
  const gaps = recent.map((p) => Math.abs(p.priceMove as number))
  const { trend, etaTradingDays } = estimateTrendAndEta(gaps)

  return { current, series, trend, etaTradingDays }
}

/**
 * 連続する「入場までの距離 (絶対値)」列から、縮小/拡大トレンドと参考 ETA を出す。
 * 線形最小二乗で傾きを取り、負 (縮小) なら gap/|slope| を ETA とする。
 * gap の単位は分数 (例 0.018 = 1.8%)、index は評価ステップ (≈ 1 営業日)。
 */
function estimateTrendAndEta(gaps: number[]): { trend: BuyabilityTrend; etaTradingDays: number | null } {
  if (gaps.length < 2) return { trend: 'unknown', etaTradingDays: null }
  const n = gaps.length
  // x = 0..n-1, y = gaps
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i += 1) {
    sx += i
    sy += gaps[i]!
    sxx += i * i
    sxy += i * gaps[i]!
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return { trend: 'flat', etaTradingDays: null }
  const slope = (n * sxy - sx * sy) / denom
  const lastGap = gaps[n - 1]!
  // ほぼ横ばい (1 評価あたり 0.05% 未満の変化) は flat 扱い。
  const FLAT_EPS = 0.0005
  if (Math.abs(slope) < FLAT_EPS) return { trend: 'flat', etaTradingDays: null }
  if (slope >= 0) return { trend: 'widening', etaTradingDays: null }
  // 縮小中: 現 gap を縮小ペースで割って 0 到達までのステップ数。
  const eta = lastGap / -slope
  if (!Number.isFinite(eta) || eta <= 0) return { trend: 'closing', etaTradingDays: null }
  return { trend: 'closing', etaTradingDays: eta }
}
