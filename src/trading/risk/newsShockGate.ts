/**
 * Scales down or blocks BUY size when recent GDELT report volume spikes vs.
 * baseline. SELL always passes through unscaled — never blocks an exit.
 *
 * Never calls fetch: the caller does the D1 read (`newsShockDecision.ts`)
 * and passes observations in, so this stays a pure function and adds no
 * external call to the strategy tick.
 */

export type NewsShockRegime = 'normal' | 'warning' | 'critical' | 'unknown'

/** fail_open (default): unknown regime keeps sizeScale=1.0. block_buy: unknown blocks BUY too. */
type AttentionStalePolicy = 'fail_open' | 'block_buy'

export interface NewsShockGateConfig {
  warnRatio: number
  blockRatio: number
  warnSizeScale: number
  toneDropThreshold: number
  requireTone: boolean
  baselineDays: number
  minSamples: number
  windowMin: number
  maxAgeMin: number
  attentionStalePolicy: AttentionStalePolicy
}

export const DEFAULT_NEWS_SHOCK_CONFIG: NewsShockGateConfig = {
  // warnRatio/blockRatio calibrated from trailing 12mo GDELT p90/p99.
  warnRatio: 2.3,
  blockRatio: 4.4,
  warnSizeScale: 0.5,
  toneDropThreshold: 1.5,
  requireTone: true,
  baselineDays: 7,
  minSamples: 200,
  windowMin: 120,
  maxAgeMin: 90,
  attentionStalePolicy: 'fail_open',
}

/** Maps to `attention_observation` rows with metric='volume'. */
export interface NewsShockVolumeObservation {
  bucketAt: string
  value: number
}

/** Maps to `attention_observation` rows with metric='tone'. */
export interface NewsShockToneObservation {
  bucketAt: string
  value: number
}

export interface NewsShockGateInput {
  /** Should cover the trailing `baselineDays`; order doesn't matter. */
  volumeObservations: NewsShockVolumeObservation[]
  /** May be empty when `requireTone=false`. */
  toneObservations: NewsShockToneObservation[]
  asOf: string
}

export interface NewsShockGateDecision {
  regime: NewsShockRegime
  /** 1.0 (normal / unknown fail-open) / warnSizeScale (warning) / 0.0 (critical, or unknown + block_buy). */
  sizeScale: number
  /** Canonical English reason string for logs/notifications; see tests for the exact per-regime formats. */
  reason: string
  /** windowMax / baselineMedian. null when not computed (unknown regime). */
  ratio: number | null
  /** baselineTone - latestTone. null when tone wasn't computed. */
  toneDrop: number | null
  asOf: string
}

/**
 * A config with NaN / inverted thresholds / out-of-range values (e.g. a D1
 * UPDATE typo) is sanitized field-by-field back to `DEFAULT_NEWS_SHOCK_CONFIG`
 * rather than rejected outright.
 */
export function evaluateNewsShockGate(
  input: NewsShockGateInput,
  config: NewsShockGateConfig = DEFAULT_NEWS_SHOCK_CONFIG,
): NewsShockGateDecision {
  const sane = sanitizeNewsShockConfig(config)
  const asOf = input.asOf
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(asOfMs)) {
    // Malformed asOf from the caller — fail open rather than throwing mid-tick.
    return unavailableDecision(sane, asOf)
  }

  const volumes = filterFinite(input.volumeObservations)
  const tones = filterFinite(input.toneObservations)

  const latestBucketMs = maxBucketMs(volumes, asOfMs)
  if (latestBucketMs === null || asOfMs - latestBucketMs > sane.maxAgeMin * 60_000) {
    return unavailableDecision(sane, asOf)
  }

  const baselineSinceMs = asOfMs - sane.baselineDays * 24 * 60 * 60_000
  const baselineValues = volumes
    .filter((o) => {
      const t = Date.parse(o.bucketAt)
      return Number.isFinite(t) && t >= baselineSinceMs && t <= asOfMs
    })
    .map((o) => o.value)
  if (baselineValues.length < sane.minSamples) {
    return insufficientBaselineDecision(sane, asOf, baselineValues.length)
  }
  // Median over non-zero values only: a sparse probe is quiet (volume=0)
  // more than 80% of the time, so a median over all points is always 0 and
  // the ratio diverges. Zero windows still count on the window-max side —
  // a quiet recent window correctly ratios to 0 / 'normal'.
  const positiveBaselineValues = baselineValues.filter((v) => v > 0)
  const baselineMedian = median(positiveBaselineValues)
  if (!Number.isFinite(baselineMedian)) {
    // Only reachable when every baseline value is zero (median([]) === NaN);
    // kept as a guard rather than assumed unreachable.
    return degenerateBaselineDecision(sane, asOf)
  }

  const windowSinceMs = asOfMs - sane.windowMin * 60_000
  const windowValues = volumes
    .filter((o) => {
      const t = Date.parse(o.bucketAt)
      return Number.isFinite(t) && t >= windowSinceMs && t <= asOfMs
    })
    .map((o) => o.value)
  if (windowValues.length === 0) {
    // Only reachable with a misconfigured maxAgeMin > windowMin; defensive fail-open.
    return unavailableDecision(sane, asOf)
  }
  const windowMax = Math.max(...windowValues)
  const ratio = windowMax / baselineMedian

  const toneDrop = computeToneDrop(tones, baselineSinceMs, asOfMs)

  if (ratio > sane.blockRatio) {
    const toneOk = !sane.requireTone || (toneDrop !== null && toneDrop >= sane.toneDropThreshold)
    if (toneOk) {
      return {
        regime: 'critical',
        sizeScale: 0,
        reason: `news_shock_critical: ${ratio.toFixed(1)}x${toneDrop !== null ? ` tone-${toneDrop.toFixed(1)}` : ''} (block)`,
        ratio,
        toneDrop,
        asOf,
      }
    }
    // Ratio alone doesn't escalate to critical — a volume spike without a
    // tone drop reads as heavy positive coverage, not a shock; warning only.
    return {
      regime: 'warning',
      sizeScale: sane.warnSizeScale,
      reason: `news_shock_warning: ${ratio.toFixed(1)}x (size x${sane.warnSizeScale})`,
      ratio,
      toneDrop,
      asOf,
    }
  }
  if (ratio > sane.warnRatio) {
    return {
      regime: 'warning',
      sizeScale: sane.warnSizeScale,
      reason: `news_shock_warning: ${ratio.toFixed(1)}x (size x${sane.warnSizeScale})`,
      ratio,
      toneDrop,
      asOf,
    }
  }
  return {
    regime: 'normal',
    sizeScale: 1.0,
    reason: `news_shock_normal: ${ratio.toFixed(1)}x`,
    ratio,
    toneDrop,
    asOf,
  }
}

function unavailableDecision(sane: NewsShockGateConfig, asOf: string): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason: 'news_shock_unavailable_fallback_normal',
    ratio: null,
    toneDrop: null,
    asOf,
  }
}

function insufficientBaselineDecision(
  sane: NewsShockGateConfig,
  asOf: string,
  sampleCount: number,
): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason: `news_shock_insufficient_baseline: ${sampleCount}/${sane.minSamples}`,
    ratio: null,
    toneDrop: null,
    asOf,
  }
}

function degenerateBaselineDecision(sane: NewsShockGateConfig, asOf: string): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason: 'news_shock_degenerate_baseline: all-zero',
    ratio: null,
    toneDrop: null,
    asOf,
  }
}

function maxBucketMs(
  observations: Array<{ bucketAt: string }>,
  asOfMs: number,
): number | null {
  let max: number | null = null
  for (const o of observations) {
    const t = Date.parse(o.bucketAt)
    if (!Number.isFinite(t) || t > asOfMs) continue
    if (max === null || t > max) max = t
  }
  return max
}

function computeToneDrop(
  tones: NewsShockToneObservation[],
  baselineSinceMs: number,
  asOfMs: number,
): number | null {
  const inRange = tones
    .map((o) => ({ t: Date.parse(o.bucketAt), value: o.value }))
    .filter((o) => Number.isFinite(o.t) && o.t >= baselineSinceMs && o.t <= asOfMs)
  if (inRange.length === 0) return null
  const baselineTone = median(inRange.map((o) => o.value))
  let latest = inRange[0]!
  for (const o of inRange) {
    if (o.t > latest.t) latest = o
  }
  if (!Number.isFinite(baselineTone)) return null
  return baselineTone - latest.value
}

function filterFinite<T extends { value: number }>(observations: T[]): T[] {
  return observations.filter((o) => Number.isFinite(o.value))
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * Exported (not just called internally) because `loadNewsShockDecision`
 * needs the sanitized `baselineDays` before it computes `sinceIso`, ahead
 * of calling `evaluateNewsShockGate` — which sanitizes again internally.
 * Calling it twice is safe: it's idempotent.
 */
export function sanitizeNewsShockConfig(config: NewsShockGateConfig): NewsShockGateConfig {
  const warnRatioRaw = isPositiveFinite(config.warnRatio)
    ? config.warnRatio
    : DEFAULT_NEWS_SHOCK_CONFIG.warnRatio
  const blockRatioRaw = isPositiveFinite(config.blockRatio)
    ? config.blockRatio
    : DEFAULT_NEWS_SHOCK_CONFIG.blockRatio
  // Inverted (warn > block) resets both to defaults rather than one — a
  // half-applied fix is harder to reason about operationally than a clean default.
  const ordered = warnRatioRaw <= blockRatioRaw
  const warnRatio = ordered ? warnRatioRaw : DEFAULT_NEWS_SHOCK_CONFIG.warnRatio
  const blockRatio = ordered ? blockRatioRaw : DEFAULT_NEWS_SHOCK_CONFIG.blockRatio
  const warnSizeScale = isUnitInterval(config.warnSizeScale)
    ? config.warnSizeScale
    : DEFAULT_NEWS_SHOCK_CONFIG.warnSizeScale
  const toneDropThreshold =
    typeof config.toneDropThreshold === 'number' && Number.isFinite(config.toneDropThreshold) && config.toneDropThreshold >= 0
      ? config.toneDropThreshold
      : DEFAULT_NEWS_SHOCK_CONFIG.toneDropThreshold
  const requireTone = typeof config.requireTone === 'boolean' ? config.requireTone : DEFAULT_NEWS_SHOCK_CONFIG.requireTone
  const baselineDays = isPositiveInt(config.baselineDays)
    ? config.baselineDays
    : DEFAULT_NEWS_SHOCK_CONFIG.baselineDays
  const minSamples = isPositiveInt(config.minSamples)
    ? config.minSamples
    : DEFAULT_NEWS_SHOCK_CONFIG.minSamples
  const windowMin = isPositiveInt(config.windowMin) ? config.windowMin : DEFAULT_NEWS_SHOCK_CONFIG.windowMin
  const maxAgeMin = isPositiveInt(config.maxAgeMin) ? config.maxAgeMin : DEFAULT_NEWS_SHOCK_CONFIG.maxAgeMin
  const attentionStalePolicy: AttentionStalePolicy =
    config.attentionStalePolicy === 'block_buy' || config.attentionStalePolicy === 'fail_open'
      ? config.attentionStalePolicy
      : DEFAULT_NEWS_SHOCK_CONFIG.attentionStalePolicy
  return {
    warnRatio,
    blockRatio,
    warnSizeScale,
    toneDropThreshold,
    requireTone,
    baselineDays,
    minSamples,
    windowMin,
    maxAgeMin,
    attentionStalePolicy,
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
