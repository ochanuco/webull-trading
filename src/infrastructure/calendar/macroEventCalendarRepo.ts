/**
 * `macro_event_calendar` テーブルへの薄い repo (issue #196 2/3)。
 *
 * - `fetchByDateRange` は gate (`evaluateMacroEventGate`) からの read。range
 *   指定で返すので、gate 側が ±N 時間窓に対応する **日付** 範囲 (ET base) を
 *   計算して渡す。時刻 fine-grained 比較は gate 側で行う。
 * - `bulkUpsert` は admin endpoint (POC では手動 seed) からの write。同一
 *   `(event_type, event_date)` は `INSERT OR IGNORE` 相当で skip。
 * - `fetchAll` は admin の `?type` / `?from` / `?to` filter 付き inspect 用。
 *
 * 結果の dummy 化は repo 層では行わない。gate 層が「fetch 失敗 → fail-closed
 * (entry block)」を担う (POC fail-closed 原則 — `earningsCalendarRepo` と同形)。
 */
import { and, asc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { macroEventCalendar, type MacroEventCalendarRow } from '../db/schema'

export type MacroEventCalendarDb = DrizzleD1Database

export interface MacroEventCalendarRepo {
  /**
   * `[fromYmd, toYmd]` 両端を含む範囲で event を返す (event_date asc → 同日内
   * は event_type asc)。`eventType` を渡すとさらに絞り込み。throws on D1 read
   * failure — caller がここで fail-closed する。
   */
  fetchByDateRange(
    fromYmd: string,
    toYmd: string,
    eventType?: string,
  ): Promise<MacroEventCalendarRow[]>
  /** admin inspect 用。`type` / `from` / `to` 全てが optional。 */
  fetchAll(filter: {
    fromYmd?: string
    toYmd?: string
    eventType?: string
  }): Promise<MacroEventCalendarRow[]>
  /**
   * Upsert (実体は drizzle `.onConflictDoNothing()`)。chunk insert で D1 の
   * subrequest 制限を避ける (`earningsCalendarRepo` と同パターン、CodeRabbit
   * #196 review)。重複 skip 数を返す。
   */
  bulkUpsert(records: MacroEventCalendarSeedInput[]): Promise<{ inserted: number; skipped: number }>
  /** id 指定で 1 row 削除。存在しない id は false を返す。 */
  deleteById(id: number): Promise<boolean>
}

export interface MacroEventCalendarSeedInput {
  /** Event 種別。caller が upper-case 化済み前提だが repo 側でも upper-case 化。 */
  eventType: string
  /** ISO date "YYYY-MM-DD"。caller が round-trip validation 済みである前提。 */
  eventDate: string
  /**
   * 発表時刻 "HH:MM" (24h ET)。`null` で全日凍結扱い。caller が validation 済み。
   */
  eventTime: string | null
  notes?: string | null
}

/** Wraps a Worker `env.DB` into a drizzle-typed client (other repos と同形式)。 */
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
      // CodeRabbit #196 review: 1 row 1 INSERT は D1 subrequest を浪費するため
      // chunk multi-row INSERT (`.values([...])`) にまとめる。`.onConflictDoNothing()`
      // で UNIQUE (event_type, event_date) 違反 row のみ skip。
      //
      // CHUNK は D1 の bound parameter 上限 (1 クエリ 100 個) から逆算する。
      // multi-row INSERT の bind 数は `列数 × 行数` なので、4 列 → 100 / 4 = 25 行。
      // 以前の 50 は 200 bind になり、26 件以上を一度に seed すると失敗していた。
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
