/**
 * `macro_event_calendar` テーブルへの薄い repo。`fetchByDateRange` は gate
 * (`evaluateMacroEventGate`) からの日付範囲 read (時刻比較は gate 側)、
 * `bulkUpsert` は admin seed からの write (`(event_type, event_date)` 重複は
 * skip)、`fetchAll` は admin inspect 用フィルタ read。fetch 失敗時の
 * fail-closed は repo 層でなく gate 層の責務 (`earningsCalendarRepo` と同形)。
 */
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { macroEventCalendar, type MacroEventCalendarRow } from '../db/schema'

export type MacroEventCalendarDb = DrizzleD1Database

export interface MacroEventCalendarRepo {
  /** `[fromYmd, toYmd]` inclusive, ordered by event_date then event_type. Throws on D1 read failure — caller fail-closes. */
  fetchByDateRange(
    fromYmd: string,
    toYmd: string,
    eventType?: string,
  ): Promise<MacroEventCalendarRow[]>
  fetchAll(filter: {
    fromYmd?: string
    toYmd?: string
    eventType?: string
  }): Promise<MacroEventCalendarRow[]>
  /** Duplicate `(event_type, event_date)` rows are skipped, not overwritten. */
  bulkUpsert(records: MacroEventCalendarSeedInput[]): Promise<{ inserted: number; skipped: number }>
  deleteById(id: number): Promise<boolean>
}

export interface MacroEventCalendarSeedInput {
  /** Upper-cased regardless of caller casing. */
  eventType: string
  /** ISO date "YYYY-MM-DD". */
  eventDate: string
  /** "HH:MM" (24h ET); `null` means all-day. */
  eventTime: string | null
  notes?: string | null
}

export function createMacroEventCalendarDb(d1: D1Database): MacroEventCalendarDb {
  return drizzle(d1)
}

export function createMacroEventCalendarRepo(
  db: MacroEventCalendarDb,
): MacroEventCalendarRepo {
  return {
    async fetchByDateRange(fromYmd, toYmd, eventType) {
      const conditions: SQL[] = [
        gte(macroEventCalendar.eventDate, fromYmd),
        lte(macroEventCalendar.eventDate, toYmd),
      ]
      if (eventType !== undefined) {
        conditions.push(eq(macroEventCalendar.eventType, eventType.toUpperCase()))
      }
      return db
        .select()
        .from(macroEventCalendar)
        .where(and(...conditions))
        .orderBy(asc(macroEventCalendar.eventDate), asc(macroEventCalendar.eventType))
    },

    async fetchAll(filter) {
      const conditions: SQL[] = []
      if (filter.fromYmd !== undefined) {
        conditions.push(gte(macroEventCalendar.eventDate, filter.fromYmd))
      }
      if (filter.toYmd !== undefined) {
        conditions.push(lte(macroEventCalendar.eventDate, filter.toYmd))
      }
      if (filter.eventType !== undefined) {
        conditions.push(eq(macroEventCalendar.eventType, filter.eventType.toUpperCase()))
      }
      const base = db.select().from(macroEventCalendar)
      const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base
      return filtered.orderBy(asc(macroEventCalendar.eventDate), asc(macroEventCalendar.eventType))
    },

    async bulkUpsert(records) {
      // D1 caps bound parameters at 100/query; 4 columns × 25 rows = 100.
      // A prior CHUNK=50 (200 binds) failed once seeding more than 26 rows.
      let inserted = 0
      let skipped = 0
      if (records.length === 0) return { inserted, skipped }
      const CHUNK = 25
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK)
        const values = chunk.map((r) => ({
          eventType: r.eventType.toUpperCase(),
          eventDate: r.eventDate,
          eventTime: r.eventTime,
          notes: r.notes ?? null,
        }))
        const result = await db
          .insert(macroEventCalendar)
          .values(values)
          .onConflictDoNothing({
            target: [macroEventCalendar.eventType, macroEventCalendar.eventDate],
          })
          .returning({ id: macroEventCalendar.id })
        const insertedInChunk = result.length
        inserted += insertedInChunk
        skipped += chunk.length - insertedInChunk
      }
      return { inserted, skipped }
    },

    async deleteById(id) {
      const result = await db
        .delete(macroEventCalendar)
        .where(eq(macroEventCalendar.id, id))
        .returning({ id: macroEventCalendar.id })
      return result.length > 0
    },
  }
}
