/**
 * Thin repo over `attention_observation` (news/crowd attention producer).
 * `bulkInsertIgnore` relies on `UNIQUE (source, probe_key, metric, bucket_at)`
 * + `.onConflictDoNothing()` to silently skip already-seen rows — GDELT's
 * `timespan=1d` feed returns the full day's ~96 points every tick, so this
 * is what makes ingestion idempotent.
 */
import { and, asc, eq, gte, lt, type SQL } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { attentionObservation, type AttentionObservationRow } from './schema'

export type AttentionObservationDb = DrizzleD1Database

export interface AttentionObservationRecord {
  source: string
  probeKey: string
  metric: string
  bucketAt: string
  value: number
  fetchedAt: string
  requestId?: string | null
}

export interface AttentionObservationRepo {
  /** `skipped` counts rows that already existed for that `(source, probe_key, metric, bucket_at)`. */
  bulkInsertIgnore(
    records: AttentionObservationRecord[],
  ): Promise<{ inserted: number; skipped: number }>
  /** Rows for `(source, probeKey, metric)` with `bucketAt >= sinceIso`, ordered ascending. */
  fetchRecent(filter: {
    source: string
    probeKey: string
    metric: string
    sinceIso: string
  }): Promise<AttentionObservationRow[]>
  /** Deletes rows with `bucketAt < iso`, returns the deleted count. */
  purgeOlderThan(iso: string): Promise<number>
}

/** Wraps a Worker `env.DB` into a drizzle-typed client. */
export function createAttentionObservationDb(d1: D1Database): AttentionObservationDb {
  return drizzle(d1)
}

export function createAttentionObservationRepo(
  db: AttentionObservationDb,
): AttentionObservationRepo {
  return {
    async bulkInsertIgnore(records) {
      let inserted = 0
      let skipped = 0
      if (records.length === 0) return { inserted, skipped }
      // D1 caps bound params at 100/query; bind count = columns × rows.
      // 7 columns → 14 rows/chunk is the safe max (CHUNK=50 would need 350
      // binds and fail once GDELT's ~66-point 1d timeline is ingested).
      const CHUNK = 14
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK)
        const values = chunk.map((r) => ({
          source: r.source,
          probeKey: r.probeKey,
          metric: r.metric,
          bucketAt: r.bucketAt,
          value: r.value,
          fetchedAt: r.fetchedAt,
          requestId: r.requestId ?? null,
        }))
        const result = await db
          .insert(attentionObservation)
          .values(values)
          .onConflictDoNothing({
            target: [
              attentionObservation.source,
              attentionObservation.probeKey,
              attentionObservation.metric,
              attentionObservation.bucketAt,
            ],
          })
          .returning({ id: attentionObservation.id })
        const insertedInChunk = result.length
        inserted += insertedInChunk
        skipped += chunk.length - insertedInChunk
      }
      return { inserted, skipped }
    },

    async fetchRecent(filter) {
      const conditions: SQL[] = [
        eq(attentionObservation.source, filter.source),
        eq(attentionObservation.probeKey, filter.probeKey),
        eq(attentionObservation.metric, filter.metric),
        gte(attentionObservation.bucketAt, filter.sinceIso),
      ]
      return db
        .select()
        .from(attentionObservation)
        .where(and(...conditions))
        .orderBy(asc(attentionObservation.bucketAt))
    },

    async purgeOlderThan(iso) {
      const result = await db
        .delete(attentionObservation)
        .where(lt(attentionObservation.bucketAt, iso))
        .returning({ id: attentionObservation.id })
      return result.length
    },
  }
}
