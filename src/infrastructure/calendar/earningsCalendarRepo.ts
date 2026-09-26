/**
 * `earnings_calendar` テーブルへの薄い repo。`fetchByRange` は gate
 * (`evaluateEarningsGate`) からの日付範囲 read、`bulkUpsert` は admin seed
 * からの write (`(symbol, earnings_date)` 重複は skip、何度 seed しても安全)。
 * fetch 失敗時の fail-closed は repo 層でなく gate 層の責務。
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { earningsCalendar, type EarningsCalendarRow } from '../db/schema'

export type EarningsCalendarDb = DrizzleD1Database

export interface EarningsCalendarRepo {
  /** `[fromYmd, toYmd]` inclusive. Throws on D1 read failure — caller fail-closes. */
  fetchByRange(symbol: string, fromYmd: string, toYmd: string): Promise<EarningsCalendarRow[]>
  fetchBySymbol(symbol: string): Promise<EarningsCalendarRow[]>
  /** Existing rows are never updated — operator re-seeds via DELETE + INSERT instead. */
  bulkUpsert(records: EarningsCalendarSeedInput[]): Promise<{ inserted: number; skipped: number }>
  deleteById(id: number): Promise<boolean>
}

export interface EarningsCalendarSeedInput {
  symbol: string
  /** ISO date "YYYY-MM-DD". */
  earningsDate: string
  notes?: string | null
}

export function createEarningsCalendarDb(d1: D1Database): EarningsCalendarDb {
  return drizzle(d1)
}

export function createEarningsCalendarRepo(db: EarningsCalendarDb): EarningsCalendarRepo {
  return {
    async fetchByRange(symbol, fromYmd, toYmd) {
      const upper = symbol.toUpperCase()
      return db
        .select()
        .from(earningsCalendar)
        .where(
          and(
            eq(earningsCalendar.symbol, upper),
            gte(earningsCalendar.earningsDate, fromYmd),
            lte(earningsCalendar.earningsDate, toYmd),
          ),
        )
        .orderBy(asc(earningsCalendar.earningsDate))
    },

    async fetchBySymbol(symbol) {
      const upper = symbol.toUpperCase()
      return db
        .select()
        .from(earningsCalendar)
        .where(eq(earningsCalendar.symbol, upper))
        .orderBy(asc(earningsCalendar.earningsDate))
    },

    async bulkUpsert(records) {
      // D1 caps bound parameters at 100/query; 3 columns × 33 rows ≈ 100.
      // A prior CHUNK=50 (150 binds) failed once seeding more than 33 rows.
      let inserted = 0
      let skipped = 0
      if (records.length === 0) return { inserted, skipped }
      const CHUNK = 33
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK)
        const values = chunk.map((r) => ({
          symbol: r.symbol.toUpperCase(),
          earningsDate: r.earningsDate,
          notes: r.notes ?? null,
        }))
        const result = await db
          .insert(earningsCalendar)
          .values(values)
          .onConflictDoNothing({
            target: [earningsCalendar.symbol, earningsCalendar.earningsDate],
          })
          .returning({ id: earningsCalendar.id })
        const insertedInChunk = result.length
        inserted += insertedInChunk
        skipped += chunk.length - insertedInChunk
      }
      return { inserted, skipped }
    },

    async deleteById(id) {
      const result = await db
        .delete(earningsCalendar)
        .where(eq(earningsCalendar.id, id))
        .returning({ id: earningsCalendar.id })
      return result.length > 0
    },
  }
}
