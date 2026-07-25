/**
 * Stop 幅の単一の決定点 (#stop-rr-cap)。
 *
 * 従来は「pct stop と ATR stop の広い方」を strategy / momentum / sizing の
 * 3 箇所で個別に計算していた。ATR 連動は高ボラ銘柄のノイズ stop-out を防ぐ
 * ためのものだが、**利確側は固定 % のまま**なので、ATR が大きい銘柄ほど
 * リワード:リスクが一方的に潰れる:
 *
 *   SOXL: atr20/price = 22% → kAtr 2.0 で stop -44% に対し TP は +7% (R:R 0.16)
 *
 * そこで「stop は TP の何倍まで許すか」(`maxStopToTpRatio`) で上限を掛ける。
 * TP を基準にすることで銘柄ごとに R:R の下限が自動的に決まる (ratio 2.0 なら
 * どの銘柄でも R:R >= 0.5)。pct stop は従来どおり **floor** で、cap が pct を
 * 下回る場合は pct が勝つ (名目 stop より狭くはしない)。
 *
 * ratio <= 0 / 非有限、または takeProfitPct <= 0 のときは cap 無効 = 従来挙動。
 */
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
      // pct stop は floor。cap が pct を下回るなら pct を採る。
      distance = Math.max(cap, pctDistance)
      dominant = distance > cap ? 'pct' : 'tp-cap'
    }
  }

  const effectiveStopPct = price > 0 ? -distance / price : input.stopPct
  return { distance, effectiveStopPct, dominant }
}
