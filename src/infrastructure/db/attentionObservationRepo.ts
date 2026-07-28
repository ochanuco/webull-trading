/**
 * `attention_observation` テーブルへの薄い repo (news/crowd attention producer,
 * PR 1)。
 *
 * - `bulkInsertIgnore` は producer (`newsScheduler`, 将来の crowdScheduler) から
 *   の write。CHUNK=50 の multi-row INSERT + `.onConflictDoNothing()` で D1
 *   subrequest 制限を避ける (`macroEventCalendarRepo.bulkUpsert` と同パターン)。
 *   `UNIQUE (source, probe_key, metric, bucket_at)` 違反行は静かに skip される
 *   — GDELT `timespan=1d` は毎 tick 全点 (~96) を返すので、これが冪等
 *   backfill の実体になる。
 * - `fetchRecent` は将来の risk gate (newsShockGate 等) からの read。
 * - `purgeOlderThan` は retention purge (将来 PR で 5 分毎 cron に同梱予定) 用。
 *
 * このリポジトリ自体はこの PR ではどこからも read されない (取引経路の変更
 * ゼロ — gate 本体は後続 PR)。テストと将来実装の土台として先に用意する。
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
  /**
   * Chunk insert (CHUNK=50) + `.onConflictDoNothing()`。既に存在する
   * `(source, probe_key, metric, bucket_at)` は skip としてカウントする。
   */
  bulkInsertIgnore(
    records: AttentionObservationRecord[],
  ): Promise<{ inserted: number; skipped: number }>
  /** `(source, probeKey, metric)` を絞り込み、`bucketAt >= sinceIso` を bucketAt asc で返す。 */
  fetchRecent(filter: {
    source: string
    probeKey: string
    metric: string
    sinceIso: string
  }): Promise<AttentionObservationRow[]>
  /** `bucketAt < iso` の行を削除し、削除件数を返す。 */
  purgeOlderThan(iso: string): Promise<number>
}

/** Wraps a Worker `env.DB` into a drizzle-typed client (other repos と同形式)。 */
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
      const CHUNK = 50
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
