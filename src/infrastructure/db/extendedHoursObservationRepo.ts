/**
 * Thin repo over `extended_hours_observation`. Producer-only: strategy/risk/
 * execution never read this table, only `extendedHoursScheduler` (write)
 * and the dashboard (read).
 */
import { desc, sql } from 'drizzle-orm'
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
  insertMany(records: ExtendedHoursObservationRecord[]): Promise<{ inserted: number }>
  /** Latest row per symbol for the given session date. */
  latestPerSymbol(sessionYmd: string): Promise<ExtendedHoursObservationRow[]>
  /** Most recent rows, ordered by id descending. */
  recent(limit: number): Promise<ExtendedHoursObservationRow[]>
}

/** Wraps a Worker `env.DB` into a drizzle-typed client. */
export function createExtendedHoursObservationDb(d1: D1Database): ExtendedHoursObservationDb {
  return drizzle(d1)
}

export function createExtendedHoursObservationRepo(
  db: ExtendedHoursObservationDb,
): ExtendedHoursObservationRepo {
  return {
    async insertMany(records) {
      if (records.length === 0) return { inserted: 0 }
      // D1 caps bound params at 100/query; 13 columns/row → 7 rows/chunk.
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
      // Not a two-stage SELECT (MAX(id) per symbol, then inArray(ids)):
      // that would spend one bound param per symbol and hit D1's 100-param
      // cap past 101 symbols. This subquery uses one param (`sessionYmd`)
      // regardless of symbol count.
      return db
        .select()
        .from(extendedHoursObservation)
        .where(
          sql`${extendedHoursObservation.id} IN (SELECT MAX(${extendedHoursObservation.id}) FROM ${extendedHoursObservation} WHERE ${extendedHoursObservation.sessionYmd} = ${sessionYmd} GROUP BY ${extendedHoursObservation.symbol})`,
        )
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
