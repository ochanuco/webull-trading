/**
 * Scales down or blocks BUY size on a Jev-classified market-headline shock
 * (`news_headline_eval`). SELL always passes through unscaled — never
 * blocks an exit.
 *
 * Never calls fetch: the caller does the D1 read (`newsShockDecision.ts`)
 * and passes the latest row in, so this stays a pure function and adds no
 * external call to the strategy tick.
 */

export type NewsShockRegime = 'normal' | 'warning' | 'critical' | 'unknown'

/** fail_open (default): unknown regime keeps sizeScale=1.0. block_buy: unknown blocks BUY too. */
type AttentionStalePolicy = 'fail_open' | 'block_buy'

export interface NewsShockGateConfig {
  warnSizeScale: number
  attentionStalePolicy: AttentionStalePolicy
}

export const DEFAULT_NEWS_SHOCK_CONFIG: NewsShockGateConfig = {
  warnSizeScale: 0.5,
  attentionStalePolicy: 'fail_open',
}

// Provisional thresholds, not yet exposed via global_config: there is no
// calibration data for the Jev shock-score distribution the way GDELT's
// ratio thresholds had 12mo of history behind them. Revisit once
// news_headline_eval has enough history to calibrate against.
const CRITICAL_SHOCK_THRESHOLD = 0.8
const WARNING_SHOCK_THRESHOLD = 0.5
/** Collector and strategy cron both run on 15-minute slots, so a fresh row should never be far behind. */
const STALE_MAX_AGE_MIN = 45

/** The subset of a `news_headline_eval` row this gate needs; kept separate from the D1 row type so this module has no infrastructure dependency. */
export interface NewsShockHeadlineRow {
  evaluatedAt: string
  status: string
  shock: number | null
  direction: string | null
}

export interface NewsShockGateInput {
  /** Latest news_headline_eval row at/before `now`, or null if none exists yet. */
  row: NewsShockHeadlineRow | null
  now: Date
}

export interface NewsShockGateDecision {
  regime: NewsShockRegime
  /** 1.0 (normal / unknown fail-open) / warnSizeScale (warning) / 0.0 (critical, or unknown + block_buy). */
  sizeScale: number
  /** Canonical English reason string for logs/notifications; see tests for the exact per-regime formats. */
  reason: string
  /** Jev shock score (0-1) behind this decision; null for an unknown regime. */
  shock: number | null
  /** Jev direction classification ('risk_off' / 'risk_on' / 'mixed' / 'not_market_relevant'); null for an unknown regime. */
  direction: string | null
  /** `evaluated_at` of the row this decision was computed from; null when no row was found at all. */
  rowEvaluatedAt: string | null
  asOf: string
}

/**
 * A config with NaN / out-of-range values (e.g. a D1 UPDATE typo) is
 * sanitized field-by-field back to `DEFAULT_NEWS_SHOCK_CONFIG` rather than
 * rejected outright.
 */
export function evaluateNewsShockGate(
  input: NewsShockGateInput,
  config: NewsShockGateConfig = DEFAULT_NEWS_SHOCK_CONFIG,
): NewsShockGateDecision {
  const sane = sanitizeNewsShockConfig(config)
  const asOf = input.now.toISOString()
  const row = input.row

  if (!row) {
    return unknownDecision(sane, asOf, null, 'news_shock_unavailable_no_row')
  }

  const rowMs = Date.parse(row.evaluatedAt)
  const ageMin = Number.isFinite(rowMs) ? (input.now.getTime() - rowMs) / 60_000 : Number.POSITIVE_INFINITY
  if (ageMin > STALE_MAX_AGE_MIN) {
    return unknownDecision(sane, asOf, row.evaluatedAt, `news_shock_unavailable_stale: ${formatAgeMin(ageMin)}min`)
  }
  if (row.status !== 'ok') {
    return unknownDecision(sane, asOf, row.evaluatedAt, `news_shock_unavailable_status: ${row.status}`)
  }
  if (row.shock === null) {
    return unknownDecision(sane, asOf, row.evaluatedAt, 'news_shock_unavailable_no_shock')
  }

  const ageText = formatAgeMin(ageMin)
  const directionText = row.direction ?? 'unknown'

  if (row.shock >= CRITICAL_SHOCK_THRESHOLD && row.direction === 'risk_off') {
    return {
      regime: 'critical',
      sizeScale: 0,
      reason: `news_shock_critical: shock=${row.shock.toFixed(2)} direction=${directionText} age=${ageText}m (block)`,
      shock: row.shock,
      direction: row.direction,
      rowEvaluatedAt: row.evaluatedAt,
      asOf,
    }
  }
  if (row.shock >= WARNING_SHOCK_THRESHOLD) {
    return {
      regime: 'warning',
      sizeScale: sane.warnSizeScale,
      reason: `news_shock_warning: shock=${row.shock.toFixed(2)} direction=${directionText} age=${ageText}m (size x${sane.warnSizeScale})`,
      shock: row.shock,
      direction: row.direction,
      rowEvaluatedAt: row.evaluatedAt,
      asOf,
    }
  }
  return {
    regime: 'normal',
    sizeScale: 1.0,
    reason: `news_shock_normal: shock=${row.shock.toFixed(2)} direction=${directionText} age=${ageText}m`,
    shock: row.shock,
    direction: row.direction,
    rowEvaluatedAt: row.evaluatedAt,
    asOf,
  }
}

function unknownDecision(
  sane: NewsShockGateConfig,
  asOf: string,
  rowEvaluatedAt: string | null,
  reason: string,
): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason,
    shock: null,
    direction: null,
    rowEvaluatedAt,
    asOf,
  }
}

function formatAgeMin(ageMin: number): string {
  return Number.isFinite(ageMin) ? Math.round(ageMin).toString() : 'inf'
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

export function sanitizeNewsShockConfig(config: NewsShockGateConfig): NewsShockGateConfig {
  const warnSizeScale = isUnitInterval(config.warnSizeScale)
    ? config.warnSizeScale
    : DEFAULT_NEWS_SHOCK_CONFIG.warnSizeScale
  const attentionStalePolicy: AttentionStalePolicy =
    config.attentionStalePolicy === 'block_buy' || config.attentionStalePolicy === 'fail_open'
      ? config.attentionStalePolicy
      : DEFAULT_NEWS_SHOCK_CONFIG.attentionStalePolicy
  return { warnSizeScale, attentionStalePolicy }
}
