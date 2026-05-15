import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { inversePairs, symbolConfig, type SymbolConfigRow } from './schema'

export type SymbolCurrency = 'USD' | 'JPY'
export type SymbolMarket = 'US' | 'JP'

export interface SymbolConfigSnapshot {
  /** Uppercased symbols where `active = 1`. cron / risk gate はこの list だけを評価対象とする。 */
  allowedSymbols: string[]
  /**
   * Uppercased symbols where `active = 0`. Operator visibility 用 — dashboard
   * の picker / table は disabled でも表示し続ける必要がある (operator が
   * disable 経緯を判断して再有効化判断するため)。cron / risk gate からは見えない。
   */
  inactiveSymbols: string[]
  /**
   * symbol → max_notional (positive number). Symbols with `max_notional` NULL
   * are absent from the map — caller falls through to the global
   * `MAX_ORDER_NOTIONAL`. active=0 の銘柄も含む (display 用)。
   */
  symbolMaxNotional: Record<string, number>
  /** symbol → currency ('USD' / 'JPY')。Risk gate が global 通貨別 cap を引くのに使う。active=0 含む。 */
  symbolCurrency: Record<string, SymbolCurrency>
  /**
   * symbol → bucket tag。NULL bucket は map に含めない (gate 側で未分類扱い
   * = 個別銘柄判定)。相関集約 cap (#23 Lane 3) で使う。active=0 含む。
   */
  symbolBucket: Record<string, string>
  /**
   * symbol → market ('US' | 'JP')。dashboard が JP 銘柄表示を「番号-会社名」
   * に切り替える判定に使う。CHECK 制約は schema 側に無いので 'US' / 'JP'
   * 以外が混ざる場合は 'US' fallback (defensive)。active=0 含む。
   */
  symbolMarket: Record<string, SymbolMarket>
  /**
   * symbol → 人間可読な銘柄名 (symbol_config.name)。NULL / 空文字は map に
   * 含めない。dashboard が JP の `${symbol}-${name}` 表示で使う。active=0 含む。
   */
  symbolName: Record<string, string>
  /**
   * symbol → notes (symbol_config.notes)。disable 理由などを operator が memo
   * しておく自由 text。NULL / 空文字は map に含めない。dashboard が disabled
   * 銘柄の tooltip 表示に使う。active=0 / active=1 両方含む。
   */
  symbolNotes: Record<string, string>
}

/**
 * Loads the per-symbol config from D1. A single query is cheap; no cache at
 * this layer — call sites hold the snapshot for the duration of one handler.
 *
 * active=1 / active=0 の両方を取得し、`allowedSymbols` (active=1) と
 * `inactiveSymbols` (active=0) に振り分ける。cron / risk gate は
 * `allowedSymbols` のみを参照するため挙動は変えない。dashboard が
 * disabled 銘柄を grayed-out で表示するために両方を返す (operator visibility)。
 */
export async function loadSymbolConfig(
  db: DrizzleD1Database,
): Promise<SymbolConfigSnapshot> {
  const rows = await db.select().from(symbolConfig)

  const allowedSymbols: string[] = []
  const inactiveSymbols: string[] = []
  const symbolMaxNotional: Record<string, number> = {}
  const symbolCurrency: Record<string, SymbolCurrency> = {}
  const symbolBucket: Record<string, string> = {}
  const symbolMarket: Record<string, SymbolMarket> = {}
  const symbolName: Record<string, string> = {}
  const symbolNotes: Record<string, string> = {}
  for (const row of rows) {
    const symbol = row.symbol.toUpperCase()
    if (row.active) {
      allowedSymbols.push(symbol)
    } else {
      inactiveSymbols.push(symbol)
    }
    if (row.maxNotional !== null && Number.isFinite(row.maxNotional) && row.maxNotional > 0) {
      symbolMaxNotional[symbol] = row.maxNotional
    }
    symbolCurrency[symbol] = row.currency === 'JPY' ? 'JPY' : 'USD'
    // bucket を trim + lowercase で正規化しないと 'semi' / ' semi' / 'SEMI'
    // が別 bucket 扱いになって集中 cap が実質回避される (CodeRabbit #126)。
    const normalizedBucket = row.bucket?.trim().toLowerCase()
    if (normalizedBucket) {
      symbolBucket[symbol] = normalizedBucket
    }
    // schema 上 market は 'US' | 'JP' 想定だが CHECK 制約は無いので
    // 不正値は 'US' fallback (defensive)。dashboard 表示の「JP のみ
    // 番号-会社名」判定に使う。
    symbolMarket[symbol] = row.market === 'JP' ? 'JP' : 'US'
    const trimmedName = row.name?.trim()
    if (trimmedName && trimmedName.length > 0) {
      symbolName[symbol] = trimmedName
    }
    const trimmedNotes = row.notes?.trim()
    if (trimmedNotes && trimmedNotes.length > 0) {
      symbolNotes[symbol] = trimmedNotes
    }
  }
  return {
    allowedSymbols,
    inactiveSymbols,
    symbolMaxNotional,
    symbolCurrency,
    symbolBucket,
    symbolMarket,
    symbolName,
    symbolNotes,
  }
}

/**
 * symbol_config 1 行を返す。CRUD UI (#292) の before/after snapshot に使う。
 * 未存在は `null`。
 */
export async function findSymbolConfig(
  db: DrizzleD1Database,
  symbol: string,
): Promise<SymbolConfigRow | null> {
  const rows = await db.select().from(symbolConfig).where(eq(symbolConfig.symbol, symbol)).limit(1)
  return rows[0] ?? null
}

export interface SymbolConfigWriteInput {
  symbol: string
  name: string | null
  market: SymbolMarket
  currency: SymbolCurrency
  active: boolean
  maxNotional: number | null
  bucket: string | null
  notes: string | null
}

/**
 * CRUD UI (#292) で symbol_config に新規 INSERT する。symbol 既存なら null を
 * 返し caller が 409 を返す。INSERT 後の最新行を返す。
 */
export async function insertSymbolConfig(
  db: DrizzleD1Database,
  input: SymbolConfigWriteInput,
  nowIso: string,
): Promise<SymbolConfigRow | null> {
  const existing = await findSymbolConfig(db, input.symbol)
  if (existing !== null) return null
  await db.insert(symbolConfig).values({
    symbol: input.symbol,
    name: input.name,
    market: input.market,
    currency: input.currency,
    active: input.active,
    maxNotional: input.maxNotional,
    bucket: input.bucket,
    notes: input.notes,
    updatedAt: nowIso,
  })
  return await findSymbolConfig(db, input.symbol)
}

/**
 * CRUD UI (#292) で symbol_config を全列 update する。存在しなければ null を
 * 返し caller が 404 を返す。symbol 自体は path から固定で来るので変更不可。
 */
export async function updateSymbolConfig(
  db: DrizzleD1Database,
  input: SymbolConfigWriteInput,
  nowIso: string,
): Promise<SymbolConfigRow | null> {
  const existing = await findSymbolConfig(db, input.symbol)
  if (existing === null) return null
  await db
    .update(symbolConfig)
    .set({
      name: input.name,
      market: input.market,
      currency: input.currency,
      active: input.active,
      maxNotional: input.maxNotional,
      bucket: input.bucket,
      notes: input.notes,
      updatedAt: nowIso,
    })
    .where(eq(symbolConfig.symbol, input.symbol))
  return await findSymbolConfig(db, input.symbol)
}

/**
 * Flip `active` 1↔0 atomically (read-modify-write). Not found → null。
 */
export async function toggleSymbolActive(
  db: DrizzleD1Database,
  symbol: string,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  // Snapshot before.active BEFORE running update — some fake DBs share the
  // row reference so re-fetching could surface the post-update value (and
  // recordChange would then skip the audit row as a "no-op").
  const beforeSnapshot: SymbolConfigRow = { ...before }
  const nextActive = !before.active
  await db
    .update(symbolConfig)
    .set({ active: nextActive, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

/**
 * Soft delete (active=false)。hard delete は FK 影響回避のため避ける。
 * 既に active=false なら no-op (before==after で audit log も skip される)。
 */
export async function softDeleteSymbol(
  db: DrizzleD1Database,
  symbol: string,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  if (!before.active) {
    return { before: beforeSnapshot, after: beforeSnapshot }
  }
  await db
    .update(symbolConfig)
    .set({ active: false, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after }
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
