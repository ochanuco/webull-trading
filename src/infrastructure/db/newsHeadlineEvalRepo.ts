/**
 * Thin repo over `news_headline_eval`. Producer-only, like
 * `attentionObservationRepo` / `extendedHoursObservationRepo`: nothing in
 * strategy/risk/execution reads this table.
 */
import { desc, lte } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { newsHeadlineEval, type NewsHeadlineEvalRow } from './schema'

export type NewsHeadlineEvalDb = DrizzleD1Database

export interface NewsHeadlineEvalRecord {
  evaluatedAt: string
  source: string
  query: string
  headlineCount: number
  headlinesJson: string
  status: string
  error?: string | null
  model?: string | null
  shock?: number | null
  direction?: string | null
  directionConfidence?: number | null
  severity?: number | null
  severityConfidence?: number | null
  scope?: string | null
  scopeConfidence?: number | null
  answersJson?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  latencyMs?: number | null
  requestId?: string | null
}

export interface NewsHeadlineEvalRepo {
  /** `inserted=false` means a row for this `(source, evaluatedAt)` slot already existed. */
  insertIgnore(record: NewsHeadlineEvalRecord): Promise<{ inserted: boolean }>
  /** Newest row at/before `atOrBeforeIso` across all sources, or null if none — the point-in-time read for strategy_decision_log. */
  fetchLatest(filter: { atOrBeforeIso: string }): Promise<NewsHeadlineEvalRow | null>
}

export function createNewsHeadlineEvalDb(d1: D1Database): NewsHeadlineEvalDb {
  return drizzle(d1)
}

export function createNewsHeadlineEvalRepo(db: NewsHeadlineEvalDb): NewsHeadlineEvalRepo {
  return {
    async insertIgnore(record) {
      const result = await db
        .insert(newsHeadlineEval)
        .values({
          evaluatedAt: record.evaluatedAt,
          source: record.source,
          query: record.query,
          headlineCount: record.headlineCount,
          headlinesJson: record.headlinesJson,
          status: record.status,
          error: record.error ?? null,
          model: record.model ?? null,
          shock: record.shock ?? null,
          direction: record.direction ?? null,
          directionConfidence: record.directionConfidence ?? null,
          severity: record.severity ?? null,
          severityConfidence: record.severityConfidence ?? null,
          scope: record.scope ?? null,
          scopeConfidence: record.scopeConfidence ?? null,
          answersJson: record.answersJson ?? null,
          inputTokens: record.inputTokens ?? null,
          outputTokens: record.outputTokens ?? null,
          latencyMs: record.latencyMs ?? null,
          requestId: record.requestId ?? null,
        })
        .onConflictDoNothing({
          target: [newsHeadlineEval.source, newsHeadlineEval.evaluatedAt],
        })
        .returning({ id: newsHeadlineEval.id })
      return { inserted: result.length > 0 }
    },

    async fetchLatest(filter) {
      const rows = await db
        .select()
        .from(newsHeadlineEval)
        .where(lte(newsHeadlineEval.evaluatedAt, filter.atOrBeforeIso))
        .orderBy(desc(newsHeadlineEval.evaluatedAt))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
