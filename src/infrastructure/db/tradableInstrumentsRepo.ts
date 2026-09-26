import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { TradableInstrumentEntry } from '../webull/tradableInstruments'
import { tradableInstrument, type TradableInstrumentRow } from './schema'

/**
 * Read/write for the `tradable_instrument` allowlist. Never hard-deletes: a
 * symbol missing from a daily sweep is flipped to `currentlyTradable=false`
 * and the row kept, so `true→false` transitions stay observable instead of
 * vanishing from history.
 */

export type TradableDb = DrizzleD1Database<Record<string, never>>

export type TradableStatus =
  /** Present in the most recent sweep — order-eligible on the broker. */
  | 'tradable'
  /** Was present, missing from the most recent sweep — may be delisted. */
  | 'disappeared'
  /** Never observed in the allowlist — may be unorderable on the broker. */
  | 'unknown'

interface TradableAllowlistEntry {
  symbol: string
  status: TradableStatus
  name: string | null
  instrumentId: string | null
  lastSeenAt: string | null
}

/** symbol (uppercase) → allowlist entry. */
export type TradableAllowlist = Map<string, TradableAllowlistEntry>

function rowStatus(row: TradableInstrumentRow): TradableStatus {
  return row.currentlyTradable ? 'tradable' : 'disappeared'
}

/** Loads the full allowlist for dashboard form/list/workflow lookups. */
export async function loadTradableAllowlist(db: TradableDb): Promise<TradableAllowlist> {
  const rows = await db.select().from(tradableInstrument)
  const map: TradableAllowlist = new Map()
  for (const row of rows) {
    map.set(row.symbol.toUpperCase(), {
      symbol: row.symbol.toUpperCase(),
      status: rowStatus(row),
      name: row.name,
      instrumentId: row.instrumentId,
      lastSeenAt: row.lastSeenAt,
    })
  }
  return map
}

export function lookupTradableStatus(allowlist: TradableAllowlist, symbol: string): TradableStatus {
  return allowlist.get(symbol.trim().toUpperCase())?.status ?? 'unknown'
}

/** Live per-symbol D1 lookup for the admin form's inline status check. */
export async function getTradableStatusForSymbol(
  db: TradableDb,
  symbol: string,
): Promise<TradableStatus> {
  const sym = symbol.trim().toUpperCase()
  const rows = await db
    .select()
    .from(tradableInstrument)
    .where(eq(tradableInstrument.symbol, sym))
    .limit(1)
  const row = rows[0]
  return row ? rowStatus(row) : 'unknown'
}

export interface RefreshTradableResult {
  upserted: number
  disappeared: number
  /** Symbols newly marked disappeared, for the monitoring notifier. */
  disappearedSymbols: string[]
  /** True only when the sweep completed and disappearance was evaluated. */
  appliedDisappearance: boolean
}

// D1 caps bound params at ~100/statement; 9 columns/row → 10 rows/chunk.
const UPSERT_CHUNK = 10
// Statements per db.batch() call, to cut round-trips.
const BATCH_STMTS = 40
// Symbols per inArray() IN clause.
const IN_CHUNK = 80

/**
 * Bulk-upserts a page of symbols as `currentlyTradable=true`. `firstSeenAt`
 * is left untouched on conflict, so it keeps the original observation time.
 * Writes are chunked through `db.batch` instead of per-row awaits, since a
 * full sweep is too many rows for that to stay fast.
 *
 * `watermarkIso` is a monotonically increasing timestamp identifying this
 * sweep, stamped onto every seen row's `lastSeenAt`. A multi-chunk sweep
 * reuses the same watermark across chunks; {@link finalizeTradableDisappearance}
 * later treats any row not touched by that watermark as disappeared
 * (mark-and-sweep).
 */
export async function upsertTradablePage(
  db: TradableDb,
  entries: TradableInstrumentEntry[],
  watermarkIso: string,
): Promise<number> {
  if (entries.length === 0) return 0
  // Dedup within the page — avoids firing ON CONFLICT twice for one symbol.
  const bySymbol = new Map<string, TradableInstrumentEntry>()
  for (const e of entries) bySymbol.set(e.symbol.toUpperCase(), e)
  const rows = [...bySymbol.values()].map((e) => ({
    symbol: e.symbol.toUpperCase(),
    instrumentId: e.instrumentId,
    name: e.name,
    currency: e.currency,
    exchangeCode: e.exchangeCode,
    currentlyTradable: true,
    firstSeenAt: watermarkIso,
    lastSeenAt: watermarkIso,
    updatedAt: watermarkIso,
  }))

  const stmts: BatchItem<'sqlite'>[] = []
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK)
    stmts.push(
      db
        .insert(tradableInstrument)
        .values(chunk)
        .onConflictDoUpdate({
          target: tradableInstrument.symbol,
          set: {
            instrumentId: sql`excluded.instrument_id`,
            name: sql`excluded.name`,
            currency: sql`excluded.currency`,
            exchangeCode: sql`excluded.exchange_code`,
            currentlyTradable: true,
            lastSeenAt: watermarkIso,
            updatedAt: watermarkIso,
          },
        }) as unknown as BatchItem<'sqlite'>,
    )
  }
  for (let i = 0; i < stmts.length; i += BATCH_STMTS) {
    const group = stmts.slice(i, i + BATCH_STMTS) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
    await db.batch(group)
  }
  return rows.length
}

/**
 * Sweep phase of mark-and-sweep: flips existing tradable rows not touched
 * by `watermarkIso` (`lastSeenAt < watermarkIso`) to `currentlyTradable=false`.
 * Call only after a sweep completes — a partial sweep would wrongly mark
 * not-yet-reached pages as disappeared.
 */
export async function finalizeTradableDisappearance(
  db: TradableDb,
  watermarkIso: string,
  nowIso: string,
): Promise<string[]> {
  const existing = await db.select().from(tradableInstrument)
  const disappeared = existing
    .filter((r) => r.currentlyTradable && (r.lastSeenAt ?? '') < watermarkIso)
    .map((r) => r.symbol.toUpperCase())
  for (let i = 0; i < disappeared.length; i += IN_CHUNK) {
    const chunk = disappeared.slice(i, i + IN_CHUNK)
    // Re-checks the disappearance predicate in the UPDATE itself, not just
    // symbol IN chunk — guards against a concurrent newer sweep re-upserting
    // the same symbol between this SELECT and UPDATE.
    await db
      .update(tradableInstrument)
      .set({ currentlyTradable: false, updatedAt: nowIso })
      .where(
        and(
          inArray(tradableInstrument.symbol, chunk),
          eq(tradableInstrument.currentlyTradable, true),
          lt(tradableInstrument.lastSeenAt, watermarkIso),
        ),
      )
  }
  return disappeared
}

export interface TradableAllowlistStatus {
  /** Row count (tradable + disappeared). */
  total: number
  tradableCount: number
  /** Most recent `lastSeenAt`; empty string when nothing has synced yet. */
  lastSync: string
}

/** Allowlist summary for UI polling/progress display. */
export async function getTradableAllowlistStatus(db: TradableDb): Promise<TradableAllowlistStatus> {
  const rows = await db
    .select({ currentlyTradable: tradableInstrument.currentlyTradable, lastSeenAt: tradableInstrument.lastSeenAt })
    .from(tradableInstrument)
  let tradableCount = 0
  let lastSync = ''
  for (const r of rows) {
    if (r.currentlyTradable) tradableCount += 1
    if (r.lastSeenAt && r.lastSeenAt > lastSync) lastSync = r.lastSeenAt
  }
  return { total: rows.length, tradableCount, lastSync }
}

/**
 * High-level helper that applies one full fetch in a single call, for
 * callers (tests, etc.) that don't stream by page. A live sweep should call
 * `upsertTradablePage` per page instead.
 */
export async function refreshTradableInstruments(
  db: TradableDb,
  fetched: TradableInstrumentEntry[],
  opts: { complete: boolean; nowIso: string },
): Promise<RefreshTradableResult> {
  const { complete, nowIso } = opts
  const upserted = await upsertTradablePage(db, fetched, nowIso)
  const disappearedSymbols = complete
    ? await finalizeTradableDisappearance(db, nowIso, nowIso)
    : []
  return {
    upserted,
    disappeared: disappearedSymbols.length,
    disappearedSymbols,
    appliedDisappearance: complete,
  }
}
