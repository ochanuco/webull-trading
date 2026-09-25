// Cap is expressed as a multiple of TP, not a flat pct: a flat cap would
// still let R:R drift per symbol as ATR width varies, while a TP multiple
// gives a fixed R:R floor across symbols. The cap only trims the ATR-driven
// width; it never narrows the stop below the nominal pct stop.
export interface StopDistanceInput {
  /** 基準価格。entry 時は発注価格、保有中は avgPrice。 */
  price: number
  /** 名目 stop (負値、例 -0.04)。絶対値が距離の floor になる。 */
  stopPct: number
  /** 利確幅 (正値)。cap の基準。 */
  takeProfitPct: number
  atr20: number
  kAtr: number
  /** stop 幅の上限 = |price * takeProfitPct| * これ。0 / 非有限で無効。 */
  maxStopToTpRatio: number
}

export interface StopDistanceResult {
  /** 価格単位の stop 幅 (正値)。 */
  distance: number
  /** avgPrice に対する実効 stop (負値)。 */
  effectiveStopPct: number
  /** どの制約が最終的に効いたか (ログ / reason 表示用)。 */
  dominant: 'pct' | 'atr' | 'tp-cap'
}

export function resolveStopDistance(input: StopDistanceInput): StopDistanceResult {
  const price = Number.isFinite(input.price) && input.price > 0 ? input.price : 0
  const pctDistance = Math.abs(price * input.stopPct)
  const atrDistance =
    Number.isFinite(input.atr20) && input.atr20 > 0 && Number.isFinite(input.kAtr) && input.kAtr > 0
      ? input.kAtr * input.atr20
      : 0

  let distance = Math.max(pctDistance, atrDistance)
  let dominant: StopDistanceResult['dominant'] = atrDistance > pctDistance ? 'atr' : 'pct'

  const capEnabled =
    Number.isFinite(input.maxStopToTpRatio) &&
    input.maxStopToTpRatio > 0 &&
    Number.isFinite(input.takeProfitPct) &&
    input.takeProfitPct > 0 &&
    price > 0
  if (capEnabled) {
    const cap = Math.abs(price * input.takeProfitPct) * input.maxStopToTpRatio
    if (distance > cap) {
      distance = Math.max(cap, pctDistance)
      dominant = distance > cap ? 'pct' : 'tp-cap'
    }
  }

  const effectiveStopPct = price > 0 ? -distance / price : input.stopPct
  return { distance, effectiveStopPct, dominant }
}
