export type VixRegime = 'normal' | 'warning' | 'critical'

export interface VixRegimeFilterConfig {
  /** VIX above this enters warning (size scaled by warningSizeScale). */
  warningThreshold: number
  /** VIX above this enters critical (BUY blocked, sizeScale=0). */
  criticalThreshold: number
  /** Size multiplier applied in the warning regime, 0..1. */
  warningSizeScale: number
}

export interface VixRegimeFilterDecision {
  regime: VixRegime
  /** Size multiplier: 1.0 (normal) / warningSizeScale (warning) / 0.0 (critical). */
  sizeScale: number
  /** Canonical reason string (e.g. `vix_warning: 27.30 (size x0.5)`), grepped by the dashboard/notifier. */
  reason: string
  vix: number | null
}

export const DEFAULT_VIX_REGIME_CONFIG: VixRegimeFilterConfig = {
  warningThreshold: 25.0,
  criticalThreshold: 30.0,
  warningSizeScale: 0.5,
}

/**
 * Pure — derives a regime decision from a VIX value and config. Caller does
 * the fetch and passes `null` on failure/invalid data, which fails open to
 * normal (VIX isn't essential enough to the system to block all BUYs over a
 * fetch miss). Config is sanitized field-by-field so a bad DB UPDATE (typo,
 * NaN, inverted thresholds) can't take the whole gate down.
 */
export function evaluateVixRegime(
  vix: number | null,
  config: VixRegimeFilterConfig = DEFAULT_VIX_REGIME_CONFIG,
): VixRegimeFilterDecision {
  const sane = sanitizeConfig(config)

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

// Schema CHECK constraints catch most bad config; this is a second layer so
// a value that slips through doesn't take the gate down at runtime.
function sanitizeConfig(config: VixRegimeFilterConfig): VixRegimeFilterConfig {
  const warning = isPositiveFinite(config.warningThreshold)
    ? config.warningThreshold
    : DEFAULT_VIX_REGIME_CONFIG.warningThreshold
  const critical = isPositiveFinite(config.criticalThreshold)
    ? config.criticalThreshold
    : DEFAULT_VIX_REGIME_CONFIG.criticalThreshold
  // Falling back to defaults on inversion avoids a half-applied state where
  // warning reacts but critical never does.
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
