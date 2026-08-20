/**
 * `extended_hours_observation` テーブルへの薄い repo (issue #709 Phase 1)。
 *
 * `extendedHoursScheduler` (producer) からの write と、dashboard 表示用の
 * read のみ持つ。`attentionObservationRepo` と同じく、このテーブル自体は
 * strategy/risk/execution から read されない (producer-only、参考観測)。
 */
import { desc, eq, inArray, max } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { extendedHoursObservation, type ExtendedHoursObservationRow } from './schema'

export type ExtendedHoursObservationDb = DrizzleD1Database

export interface ExtendedHoursObservationRecord {
  symbol: string
  capturedAt: string
  sessionYmd: string
  status: string
  preMarketLast?: number | null
  preMarketLow?: number | null
  prevClose?: number | null
  gapPct?: number | null
  direction15mPct?: number | null
  toStopPct?: number | null
  lastBarAt?: string | null
  freshnessSec?: number | null
  requestId?: string | null
}

export interface ExtendedHoursObservationRepo {
  /**
   * tick ごとに銘柄数分 insert する (append-only、chunk insert)。
   */
  insertMany(records: ExtendedHoursObservationRecord[]): Promise<{ inserted: number }>
  /** 当日 (`sessionYmd`) の銘柄ごと最新行を返す。 */
  latestPerSymbol(sessionYmd: string): Promise<ExtendedHoursObservationRow[]>
  /** 直近 N 件 (id desc)。 */
  recent(limit: number): Promise<ExtendedHoursObservationRow[]>
}

/** Wraps a Worker `env.DB` into a drizzle-typed client (他 repo と同形式)。 */
export function createExtendedHoursObservationDb(d1: D1Database): ExtendedHoursObservationDb {
  return drizzle(d1)
}

export function createExtendedHoursObservationRepo(
  db: ExtendedHoursObservationDb,
): ExtendedHoursObservationRepo {
  return {
    async insertMany(records) {
      if (records.length === 0) return { inserted: 0 }
      // D1 の bound parameter 上限 (1 クエリ 100 個) を踏まえた chunk サイズ。
      // 列数 13 (attentionObservationRepo と同じ理由で計算): 100 / 13 = 7 行/chunk。
      const CHUNK = 7
      let inserted = 0
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK)
        const values = chunk.map((r) => ({
          symbol: r.symbol,
          capturedAt: r.capturedAt,
          sessionYmd: r.sessionYmd,
          status: r.status,
          preMarketLast: r.preMarketLast ?? null,
          preMarketLow: r.preMarketLow ?? null,
          prevClose: r.prevClose ?? null,
          gapPct: r.gapPct ?? null,
          direction15mPct: r.direction15mPct ?? null,
          toStopPct: r.toStopPct ?? null,
          lastBarAt: r.lastBarAt ?? null,
          freshnessSec: r.freshnessSec ?? null,
          requestId: r.requestId ?? null,
        }))
        await db.insert(extendedHoursObservation).values(values)
        inserted += chunk.length
      }
      return { inserted }
    },

    async latestPerSymbol(sessionYmd) {
      // symbol ごとの最新 id を 2 段階で求める (attentionObservation の冪等
      // unique index と違いこのテーブルは append-only なので MAX(id) 抽出)。
      // 1) symbol ごとの MAX(id)、2) その id 集合で本体行を取得。
      const maxIdRows = await db
        .select({ maxId: max(extendedHoursObservation.id) })
        .from(extendedHoursObservation)
        .where(eq(extendedHoursObservation.sessionYmd, sessionYmd))
        .groupBy(extendedHoursObservation.symbol)
      const ids = maxIdRows
        .map((r) => r.maxId)
        .filter((id): id is number => typeof id === 'number')
      if (ids.length === 0) return []
      return db
        .select()
        .from(extendedHoursObservation)
        .where(inArray(extendedHoursObservation.id, ids))
        .orderBy(extendedHoursObservation.symbol)
    },

    async recent(limit) {
      return db
        .select()
        .from(extendedHoursObservation)
        .orderBy(desc(extendedHoursObservation.id))
        .limit(limit)
    },
  }
}
