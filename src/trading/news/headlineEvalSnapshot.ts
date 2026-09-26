/**
 * Point-in-time `news_headline_eval` snapshot for `strategy_decision_log`.
 * Recorded observe-only so a later Jev evaluation can compare against the
 * decision without look-ahead bias: the collector and strategy cron both
 * fire on quarter-hours, so a post-hoc time join could otherwise pick up a
 * row that didn't exist yet when the decision ran. Never gates sizing —
 * callers must not branch on the returned value.
 */
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../infrastructure/db/newsHeadlineEvalRepo'
import type { NewsHeadlineEvalRow } from '../../infrastructure/db/schema'

export type HeadlineEvalSnapshot =
  | {
      available: true
      /** Which feed produced this row (`yahoo_finance_rss` / `google_news_rss`) — the collector can fall back mid-run. */
      source: string
      evaluatedAt: string
      ageMin: number
      status: string
      shock: number | null
      direction: string | null
      directionConfidence: number | null
      severity: number | null
      severityConfidence: number | null
      scope: string | null
      scopeConfidence: number | null
      headlineCount: number
    }
  | { available: false; reason: 'no_row' | 'load_error' }

export function buildHeadlineEvalSnapshot(
  row: NewsHeadlineEvalRow | null,
  now: Date,
): HeadlineEvalSnapshot {
  if (!row) return { available: false, reason: 'no_row' }
  return {
    available: true,
    source: row.source,
    evaluatedAt: row.evaluatedAt,
    ageMin: Math.round((now.getTime() - Date.parse(row.evaluatedAt)) / 60_000),
    status: row.status,
    shock: row.shock,
    direction: row.direction,
    directionConfidence: row.directionConfidence,
    severity: row.severity,
    severityConfidence: row.severityConfidence,
    scope: row.scope,
    scopeConfidence: row.scopeConfidence,
    headlineCount: row.headlineCount,
  }
}

/** Fails open (`load_error`) on any throw — a read-only observability field must never take down the cron. */
export async function loadHeadlineEvalSnapshot(
  db: D1Database,
  now: Date,
  requestId?: string,
): Promise<HeadlineEvalSnapshot> {
  try {
    const repo = createNewsHeadlineEvalRepo(createNewsHeadlineEvalDb(db))
    const row = await repo.fetchLatest({ atOrBeforeIso: now.toISOString() })
    return buildHeadlineEvalSnapshot(row, now)
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'headline_eval_snapshot_load_failed',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return { available: false, reason: 'load_error' }
  }
}
