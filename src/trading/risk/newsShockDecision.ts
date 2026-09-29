/**
 * Builds a news-shock decision from the latest `news_headline_eval` row: D1
 * read plus the pure evaluation in `evaluateNewsShockGate`, kept separate so
 * other callers (e.g. the daily summary) can reuse the D1 read.
 */
import {
  DEFAULT_NEWS_SHOCK_CONFIG,
  evaluateNewsShockGate,
  sanitizeNewsShockConfig,
  type NewsShockGateDecision,
  type NewsShockRegime,
} from './newsShockGate'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../infrastructure/db/newsHeadlineEvalRepo'

/** Guards against an unmigrated D1 (preview / new env) — treat as not-ready rather than throwing. */
export async function isNewsShockGateReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='news_headline_eval' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/** Severity rank for logging/display (0=normal/unknown, 1=warning, 2=critical). */
export const NEWS_SHOCK_REGIME_RANK: Record<NewsShockRegime, number> = {
  unknown: 0,
  normal: 0,
  warning: 1,
  critical: 2,
}

export function isNewsShockRegime(value: unknown): value is NewsShockRegime {
  return value === 'unknown' || value === 'normal' || value === 'warning' || value === 'critical'
}

/** `config_state_snapshot` key for the latched alert level (see `computeNextNewsShockAlertLevel`), distinct from the raw per-tick regime. */
export const NEWS_SHOCK_ALERT_LEVEL_KEY = 'news_shock_alert_level'

/**
 * Latches the notified alert level so shock hovering across the
 * warning/critical boundary fires a notification only once per episode:
 * an escalation sticks at its highest level until the regime fully recovers
 * to normal, which is the only thing that resets the latch. `unknown` is a
 * data gap rather than a market read, so it neither escalates nor resets —
 * callers are expected to skip this entirely on an unknown tick rather than
 * pass it in, but the fallback here keeps the function total.
 */
export function computeNextNewsShockAlertLevel(
  current: NewsShockRegime,
  previousLatched: NewsShockRegime | null,
): NewsShockRegime {
  if (current === 'unknown') return previousLatched ?? 'unknown'
  if (current === 'normal') return 'normal'
  if (previousLatched === null) return current
  return NEWS_SHOCK_REGIME_RANK[previousLatched] >= NEWS_SHOCK_REGIME_RANK[current] ? previousLatched : current
}

/**
 * D1-reads the newest `news_headline_eval` row at/before `now` and evaluates
 * it with `evaluateNewsShockGate`. Never calls fetch itself — collecting
 * headlines is `headlineEvalScheduler`'s job, a separate producer cron.
 * A D1 read failure is treated as no row (fail-open) rather than failing
 * the whole strategy tick.
 */
export async function loadNewsShockDecision(
  db: D1Database,
  global: {
    newsShockWarnSizeScale: number
    attentionStalePolicy: 'fail_open' | 'block_buy'
  },
  requestId: string | undefined,
  now: Date,
): Promise<NewsShockGateDecision> {
  const config = sanitizeNewsShockConfig({
    ...DEFAULT_NEWS_SHOCK_CONFIG,
    warnSizeScale: global.newsShockWarnSizeScale,
    attentionStalePolicy: global.attentionStalePolicy,
  })

  let row
  try {
    const repo = createNewsHeadlineEvalRepo(createNewsHeadlineEvalDb(db))
    row = await repo.fetchLatest({ atOrBeforeIso: now.toISOString() })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'news_shock_observation_fetch_failed',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
    row = null
  }
  return evaluateNewsShockGate({ row, now }, config)
}

/** Human-readable headline for a `news_shock_alert_level` STATE_CHANGE notification; undefined falls back to the default "state change: ..." display. */
export function buildNewsShockRegimeHeadline(
  from: NewsShockRegime,
  to: NewsShockRegime,
  decision: NewsShockGateDecision,
  mode: 'observe' | 'enforce',
): string | undefined {
  const shockText = decision.shock !== null ? `${Math.round(decision.shock * 100)}%` : '算出不能'
  if (to === 'critical') {
    return mode === 'enforce'
      ? `${shockText}：ニュース急落 — 新規買い停止`
      : `${shockText}：ニュース急落 — 観測のみ`
  }
  if (to === 'warning') {
    return mode === 'enforce'
      ? `${shockText}：ニュース悪化 — 買い数量 x${decision.sizeScale}`
      : `${shockText}：ニュース悪化 — 観測のみ`
  }
  if (to === 'normal' && (from === 'warning' || from === 'critical')) {
    return 'ニュース平常に戻りました'
  }
  // unknown→normal is data recovery, not a market signal — the caller skips
  // notifying on an unknown tick entirely, so no headline is needed here.
  return undefined
}
