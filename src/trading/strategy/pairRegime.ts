import type { DailyBar } from './indicators'

// Zone is decided once for the pair from the unleveraged proxy's 20d return,
// not per leg: evaluating bull/bear independently lets both legs stop out in
// the same chop band. Zone is re-walked statelessly from a neutral seed on
// every evaluation (no persisted state), so it's deterministic and fully
// reproducible from the decision log. Score stays a single point-to-point
// return rather than a slope/MA-cross/ADX blend, to avoid overfitting.
//
// `unknown` (insufficient data / stale / misconfig) fails closed on entry
// for both legs but never blocks exit.
export type PairRegimeZone = 'bull' | 'bear' | 'neutral' | 'unknown'

export interface PairRegimeThresholds {
  /** neutral → bull, proxy 20d return. Default +0.03. */
  bullEnter: number
  /** bull → neutral. Default +0.01. */
  bullExit: number
  /** neutral → bear. Default -0.04. */
  bearEnter: number
  /** bear → neutral. Default -0.015. */
  bearExit: number
}

export interface PairRegimeDecision {
  zone: PairRegimeZone
  /** Latest score (proxy 20-trading-day return); null when `zone` is `unknown`. */
  score: number | null
  proxySymbol: string
  /** Date (YYYY-MM-DD) of the last completed bar the score used; null when `zone` is `unknown`. */
  asOfDate: string | null
  /** Human-readable basis for the decision, or the `unknown` reason. */
  reason: string
}

const SCORE_LOOKBACK = 20
const WALK_WINDOW = 60

/** A last completed bar older than this many calendar days makes the decision `unknown`. */
const STALE_CALENDAR_DAYS = 5

const NY_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })

export function validatePairRegimeThresholds(t: PairRegimeThresholds): boolean {
  return (
    Number.isFinite(t.bearEnter) &&
    Number.isFinite(t.bearExit) &&
    Number.isFinite(t.bullExit) &&
    Number.isFinite(t.bullEnter) &&
    t.bearEnter < t.bearExit &&
    t.bearExit < t.bullExit &&
    t.bullExit < t.bullEnter
  )
}

// One Schmitt-trigger step: at most one zone transition per call, so a
// crash straight through bearEnter from `bull` lands on `neutral` first,
// not `bear` — the next score is what carries it into `bear`.
function stepZone(prev: PairRegimeZone, score: number, t: PairRegimeThresholds): PairRegimeZone {
  if (prev === 'bull') {
    return score < t.bullExit ? 'neutral' : 'bull'
  }
  if (prev === 'bear') {
    return score > t.bearExit ? 'neutral' : 'bear'
  }
  // prev === 'neutral' (never called with 'unknown')
  if (score >= t.bullEnter) return 'bull'
  if (score <= t.bearEnter) return 'bear'
  return 'neutral'
}

const unknown = (proxySymbol: string, reason: string): PairRegimeDecision => ({
  zone: 'unknown',
  score: null,
  proxySymbol,
  asOfDate: null,
  reason,
})

export function evaluatePairRegime(
  bars: DailyBar[],
  opts: { proxySymbol: string; thresholds: PairRegimeThresholds; now: Date },
): PairRegimeDecision {
  const { proxySymbol, thresholds, now } = opts
  if (!validatePairRegimeThresholds(thresholds)) {
    return unknown(proxySymbol, 'misconfigured thresholds (order must be bearEnter < bearExit < bullExit < bullEnter)')
  }
  const todayNy = NY_DATE_FMT.format(now)
  const completed = bars.filter((b) => b.date < todayNy && Number.isFinite(b.close) && b.close > 0)
  if (completed.length < SCORE_LOOKBACK + 1) {
    return unknown(proxySymbol, `insufficient completed bars (${completed.length} < ${SCORE_LOOKBACK + 1})`)
  }
  const last = completed[completed.length - 1]!
  const lastMs = Date.parse(`${last.date}T00:00:00.000Z`)
  if (!Number.isFinite(lastMs) || now.getTime() - lastMs > STALE_CALENDAR_DAYS * 86_400_000) {
    return unknown(proxySymbol, `stale proxy data (last completed bar ${last.date})`)
  }
  const scores: number[] = []
  for (let i = SCORE_LOOKBACK; i < completed.length; i += 1) {
    const base = completed[i - SCORE_LOOKBACK]!.close
    scores.push(completed[i]!.close / base - 1)
  }
  const walk = scores.slice(-WALK_WINDOW)
  let zone: PairRegimeZone = 'neutral'
  for (const s of walk) {
    if (!Number.isFinite(s)) {
      return unknown(proxySymbol, 'non-finite score in walk window')
    }
    zone = stepZone(zone, s, thresholds)
  }
  const latest = walk[walk.length - 1]!
  return {
    zone,
    score: latest,
    proxySymbol,
    asOfDate: last.date,
    reason: `zone=${zone} score=${(latest * 100).toFixed(2)}% (proxy ${proxySymbol}, as of ${last.date})`,
  }
}

export interface PairRegimeEntry {
  bullSymbol: string
  bearSymbol: string
  proxySymbol: string
  /** Non-null when repo validation found a misconfig; forces `zone: 'unknown'` (fail-closed). */
  invalidConfig: string | null
}

export const PAIR_REGIME_ZONE_LABELS: Record<PairRegimeZone, string> = {
  bull: '強気 (ブル側のみ)',
  bear: '弱気 (ベア側のみ)',
  neutral: '様子見 (両側不可)',
  unknown: '判定不能 (両側不可)',
}
