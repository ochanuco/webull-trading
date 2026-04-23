import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { inversePairs, symbolConfig } from './schema'

export type SymbolCurrency = 'USD' | 'JPY'

export interface SymbolConfigSnapshot {
  /** Uppercased symbols where `active = 1`. */
  allowedSymbols: string[]
  /**
   * symbol → max_notional (positive number). Symbols with `max_notional` NULL
   * are absent from the map — caller falls through to the global
   * `MAX_ORDER_NOTIONAL`.
   */
  symbolMaxNotional: Record<string, number>
  /** symbol → currency ('USD' / 'JPY')。Risk gate が global 通貨別 cap を引くのに使う。 */
  symbolCurrency: Record<string, SymbolCurrency>
  /**
   * symbol → bucket tag。NULL bucket は map に含めない (gate 側で未分類扱い
   * = 個別銘柄判定)。相関集約 cap (#23 Lane 3) で使う。
   */
  symbolBucket: Record<string, string>
}

/**
 * Loads the per-symbol config from D1. A single query is cheap; no cache at
 * this layer — call sites hold the snapshot for the duration of one handler.
 */
export async function loadSymbolConfig(
  db: DrizzleD1Database,
): Promise<SymbolConfigSnapshot> {
  const rows = await db.select().from(symbolConfig).where(eq(symbolConfig.active, true))

  const allowedSymbols: string[] = []
  const symbolMaxNotional: Record<string, number> = {}
  const symbolCurrency: Record<string, SymbolCurrency> = {}
  const symbolBucket: Record<string, string> = {}
  for (const row of rows) {
    const symbol = row.symbol.toUpperCase()
    allowedSymbols.push(symbol)
    if (row.maxNotional !== null && Number.isFinite(row.maxNotional) && row.maxNotional > 0) {
      symbolMaxNotional[symbol] = row.maxNotional
    }
    symbolCurrency[symbol] = row.currency === 'JPY' ? 'JPY' : 'USD'
    if (row.bucket && row.bucket.length > 0) {
      symbolBucket[symbol] = row.bucket
    }
  }
  return { allowedSymbols, symbolMaxNotional, symbolCurrency, symbolBucket }
}

/**
 * Returns a bidirectional inverse-pair map (SOXL→SOXS AND SOXS→SOXL even if
 * only one direction is stored). TradingService's inverse-pair gate expects
 * both directions populated.
 */
export async function loadInversePairs(
  db: DrizzleD1Database,
): Promise<Record<string, string>> {
  const rows = await db.select().from(inversePairs)
  const result: Record<string, string> = {}
  for (const row of rows) {
    const left = row.symbol.toUpperCase()
    const right = row.inverse.toUpperCase()
    if (left === right) continue
    result[left] = right
    if (result[right] === undefined) {
      result[right] = left
    }
  }
  return result
}
