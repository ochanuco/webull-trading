/**
 * `earnings_calendar` テーブルへの薄い repo。issue #196 の earnings gate 専用。
 *
 * - `fetchByRange` は gate (`evaluateEarningsGate`) からの read。range 指定で
 *   返すので、gate 側が ±N 営業日窓を計算して渡す。
 * - `bulkUpsert` は admin endpoint (POC では手動 seed) からの write。同一
 *   `(symbol, earnings_date)` は `INSERT OR IGNORE` で skip — operator が
 *   何度 seed しても安全。
 * - 結果は read 時に DB から戻った row そのまま (symbol は upper-case 正規化を
 *   write 側で済ませる方針)。
 *
 * 結果の dummy 化は repo 層では行わない。gate 層が「fetch 失敗 → fail-closed
 * (entry block)」を担う (POC fail-closed 原則)。
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { earningsCalendar, type EarningsCalendarRow } from '../db/schema'

export type EarningsCalendarDb = DrizzleD1Database

export interface EarningsCalendarRepo {
  /**
   * `[fromYmd, toYmd]` 両端を含む範囲で `symbol` の earnings 日を返す
   * (date asc)。throws on D1 read failure — caller がここで fail-closed する。
   */
  fetchByRange(symbol: string, fromYmd: string, toYmd: string): Promise<EarningsCalendarRow[]>
  /** `symbol` の row 全件 (operator inspect 用)。 */
  fetchBySymbol(symbol: string): Promise<EarningsCalendarRow[]>
  /**
   * Upsert (実際は `INSERT OR IGNORE`) 配列。POC 段階では既存 row の更新は
   * 行わない (operator が DELETE → INSERT で対応する想定)。重複 skip 数を返す。
   */
  bulkUpsert(records: EarningsCalendarSeedInput[]): Promise<{ inserted: number; skipped: number }>
  /** id 指定で 1 row 削除。存在しない id は false を返す。 */
  deleteById(id: number): Promise<boolean>
}

export interface EarningsCalendarSeedInput {
  symbol: string
  /** ISO date "YYYY-MM-DD"。caller が validation 済みである前提。 */
  earningsDate: string
  notes?: string | null
}

/** Wraps a Worker `env.DB` into a drizzle-typed client (other repos と同形式)。 */
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
      let inserted = 0
      let skipped = 0
      // drizzle d1 driver の `.onConflictDoNothing()` を使う。bulk values で
      // 1 statement にまとめても良いが、UNIQUE 違反 row だけ skip して残りを
      // insert する挙動は drizzle 側で吸収してくれる。
      for (const r of records) {
        const result = await db
          .insert(earningsCalendar)
          .values({
            symbol: r.symbol.toUpperCase(),
            earningsDate: r.earningsDate,
            notes: r.notes ?? null,
          })
          .onConflictDoNothing({
            target: [earningsCalendar.symbol, earningsCalendar.earningsDate],
          })
          .returning({ id: earningsCalendar.id })
        if (result.length > 0) {
          inserted += 1
        } else {
          skipped += 1
        }
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
