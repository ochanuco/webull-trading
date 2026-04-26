/**
 * VIX regime filter (issue #196 3/3)。
 *
 * `^VIX` (CBOE Volatility Index) の最新値で BUY size を縮小 / 停止する
 * **size scaling 系** filter。earnings (1/3) / macro (2/3) gate と異なり
 * 「BUY を 0/1 で止める」のではなく「size を 0..1 倍にスケール」する。
 *
 * scope:
 *   - in: BUY の `intent.quantity` を倍率調整 (1.0 / 0.5 / 0.0)
 *   - out: SELL は常に通す (existing position の exit を妨げない)
 *   - out: VIX 取得失敗は **fail-open warning** で normal fallback (POC 適切 —
 *     VIX は part-of-the-system で必須ではない、fail-closed BUY 全停止は厳しすぎる)
 *
 * 規則:
 *   - VIX <= warningThreshold: regime='normal', sizeScale=1.0
 *   - warningThreshold < VIX <= criticalThreshold: regime='warning', sizeScale=warningSizeScale
 *   - VIX > criticalThreshold: regime='critical', sizeScale=0 (= BUY block)
 *   - vix === null (取得失敗): regime='normal', sizeScale=1.0 (fail-open)
 *
 * 呼び出し側 (`pullbackScheduler` 経由) は decision の `reason` を
 * `risk: vix_critical: 35.10 (block)` 形式で `strategy_decision_log.reason` に書く。
 */

export type VixRegime = 'normal' | 'warning' | 'critical'

export interface VixRegimeFilterConfig {
  /** VIX > これで warning 領域 (size を warningSizeScale 倍に縮小)。default 25。 */
  warningThreshold: number
  /** VIX > これで critical 領域 (BUY 全停止 / sizeScale=0)。default 30。 */
  criticalThreshold: number
  /** warning 領域の size 倍率。default 0.5 (= 半分)。0..1 で運用想定。 */
  warningSizeScale: number
}

export interface VixRegimeFilterDecision {
  regime: VixRegime
  /**
   * size を倍率調整。1.0 (normal) / warningSizeScale (warning, default 0.5) /
   * 0.0 (critical = block)。`pullbackScheduler` BUY 段で
   * `intent.quantity = floor(intent.quantity * sizeScale)` する。
   * critical (sizeScale === 0) は BUY 全 reject、reason に critical を載せる。
   */
  sizeScale: number
  /**
   * 通知 / log 用の説明 (英文 canonical、表示層で日本語化)。形式:
   *   - `vix_normal: 18.50`
   *   - `vix_warning: 27.30 (size x0.5)`
   *   - `vix_critical: 35.10 (block)`
   *   - `vix_unavailable_fallback_normal` (取得失敗時)
   */
  reason: string
  /**
   * 評価対象の VIX 値 (取得失敗時は null)。dashboard / 通知向けの素材。
   * decision.reason に載せる以外でも UI 側で生値を使うために露出する。
   */
  vix: number | null
}

export const DEFAULT_VIX_REGIME_CONFIG: VixRegimeFilterConfig = {
  warningThreshold: 25.0,
  criticalThreshold: 30.0,
  warningSizeScale: 0.5,
}

/**
 * Pure function — VIX 値 + config から regime decision を返す。
 *
 * 呼び出し側で fetch を済ませて `vix: number | null` を渡す。`null` は
 * 「fetch 失敗 / 値が無効」を意味し、fail-open で normal 扱いになる。
 *
 * config が壊れている (NaN / 順序逆転 / sizeScale が 0..1 範囲外) 場合は
 * `DEFAULT_VIX_REGIME_CONFIG` の対応 field に倒す。「DB UPDATE typo で
 * VIX gate 経路が暴発」を避けるための defensive normalization。
 */
export function evaluateVixRegime(
  vix: number | null,
  config: VixRegimeFilterConfig = DEFAULT_VIX_REGIME_CONFIG,
): VixRegimeFilterDecision {
  const sane = sanitizeConfig(config)

  // 取得失敗 → normal fallback (fail-open warning)。VIX は part-of-the-system
  // で必須ではないので、fail-closed で全 BUY 停止は POC では厳しすぎる。
  if (vix === null || !Number.isFinite(vix) || vix <= 0) {
    return {
      regime: 'normal',
      sizeScale: 1.0,
      reason: 'vix_unavailable_fallback_normal',
      vix: null,
    }
  }

  if (vix > sane.criticalThreshold) {
    return {
      regime: 'critical',
      sizeScale: 0,
      reason: `vix_critical: ${vix.toFixed(2)} (block)`,
      vix,
    }
  }
  if (vix > sane.warningThreshold) {
    return {
      regime: 'warning',
      sizeScale: sane.warningSizeScale,
      reason: `vix_warning: ${vix.toFixed(2)} (size x${sane.warningSizeScale})`,
      vix,
    }
  }
  return {
    regime: 'normal',
    sizeScale: 1.0,
    reason: `vix_normal: ${vix.toFixed(2)}`,
    vix,
  }
}

/**
 * config を default に倒して安全圏に正規化する。狙い: DB の UPDATE で
 * 入った typo (e.g. warningThreshold=NaN, sizeScale=2.5) で VIX 経路が
 * 暴発しないようにする。schema CHECK 制約で大半は弾けるが、layered
 * defense として scheduler 寄りでも一段噛ませる。
 */
function sanitizeConfig(config: VixRegimeFilterConfig): VixRegimeFilterConfig {
  const warning = isPositiveFinite(config.warningThreshold)
    ? config.warningThreshold
    : DEFAULT_VIX_REGIME_CONFIG.warningThreshold
  const critical = isPositiveFinite(config.criticalThreshold)
    ? config.criticalThreshold
    : DEFAULT_VIX_REGIME_CONFIG.criticalThreshold
  // warning > critical (順序逆転) は schema CHECK で弾くが、defensive に
  // default に戻す。runtime で「warning は反応するのに critical は無反応」
  // のような中途半端な挙動になるよりも、明確に default に倒す方が運用的に
  // 分かりやすい。
  const orderedWarning =
    warning <= critical ? warning : DEFAULT_VIX_REGIME_CONFIG.warningThreshold
  const orderedCritical =
    warning <= critical ? critical : DEFAULT_VIX_REGIME_CONFIG.criticalThreshold
  const scale =
    typeof config.warningSizeScale === 'number' &&
    Number.isFinite(config.warningSizeScale) &&
    config.warningSizeScale >= 0 &&
    config.warningSizeScale <= 1
      ? config.warningSizeScale
      : DEFAULT_VIX_REGIME_CONFIG.warningSizeScale
  return {
    warningThreshold: orderedWarning,
    criticalThreshold: orderedCritical,
    warningSizeScale: scale,
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
