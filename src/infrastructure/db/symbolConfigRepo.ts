import { eq, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { inversePairs, symbolConfig, type SymbolConfigRow } from './schema'

export type SymbolCurrency = 'USD' | 'JPY'
export type SymbolMarket = 'US' | 'JP'

/**
 * The 6 symbol roles. Only cash_parking / core_trend / leveraged_trend are
 * active initially; low_volatility / sector_trend / inverse_hedge are
 * defined but suppress entry until a follow-up wires them up.
 */
export const SYMBOL_ROLES = [
  'cash_parking',
  'core_trend',
  'leveraged_trend',
  'low_volatility',
  'sector_trend',
  'inverse_hedge',
  // Breakout/momentum entries, decided by BreakoutMomentumStrategy (a
  // separate strategy from pullback). Still flows through Risk→Execution
  // like any other role; 1x only (not used for 3x).
  'momentum',
] as const
export type SymbolRole = (typeof SYMBOL_ROLES)[number]

/**
 * An out-of-enum role written directly to the DB normalizes to 'unknown'
 * rather than falling back to NULL's legacy-tradable behavior — that would
 * let a typo'd role trade under the default gate. Downstream treats
 * 'unknown' as entry-suppressed.
 */
export type SymbolRoleValue = SymbolRole | 'unknown'

export function isSymbolRole(value: unknown): value is SymbolRole {
  return typeof value === 'string' && (SYMBOL_ROLES as readonly string[]).includes(value)
}


export interface SymbolConfigSnapshot {
  /** `active = 1` only — the cron/risk-gate evaluation set. */
  allowedSymbols: string[]
  /**
   * `active = 0` symbols. For operator visibility: the dashboard
   * picker/table keeps showing disabled symbols so operators can judge
   * whether to re-enable them. Never read by cron/risk gate.
   */
  inactiveSymbols: string[]
  /** Missing key falls through to the global `MAX_ORDER_NOTIONAL`. Includes active=0 symbols (for display). */
  symbolMaxNotional: Record<string, number>
  /** Includes active=0 symbols; the Risk gate uses this to pick the currency-specific global cap. */
  symbolCurrency: Record<string, SymbolCurrency>
  /**
   * No DB CHECK constrains this column, so a value outside 'US'/'JP' falls
   * back to 'US' (defensive). Includes active=0 symbols.
   */
  symbolMarket: Record<string, SymbolMarket>
  /** Absent when null/empty. Used for the dashboard's JP `${symbol}-${name}` display. Includes active=0. */
  symbolName: Record<string, string>
  /** Free-text operator notes (e.g. disable reason). Absent when null/empty. Includes both active states. */
  symbolNotes: Record<string, string>
  /** Missing key falls through to `global_config.pullback_default_time_stop_days`. */
  symbolTimeStopDaysOverride: Record<string, number>
  /** Missing key falls through to `global_config.pullback_default_k_atr`. */
  symbolKAtrOverride: Record<string, number>
  /** Missing key means the symbol still uses risk-% sizing instead of fixed-% budget allocation. */
  symbolBudgetAllocPct: Record<string, number>
  /** Missing key fails closed in cron sizing (order withheld) rather than falling back to a blanket default. */
  symbolLotSize: Record<string, number>
  /** Missing key = global default stop_pct. */
  symbolStopPctOverride: Record<string, number>
  /** Missing key = global default take_profit_pct. */
  symbolTakeProfitPctOverride: Record<string, number>
  /** Only symbols with intraday_only=true are present; cron force-closes these before the US close. */
  symbolIntradayOnly: Record<string, boolean>
  /**
   * Missing key = legacy behavior. An out-of-enum DB value is included as
   * 'unknown' rather than dropped, so downstream can suppress entry
   * (fail-closed) instead of falling back to legacy-tradable.
   */
  symbolRole: Record<string, SymbolRoleValue>
  /**
   * Entry-gate overrides; a missing/out-of-range key falls through role
   * preset → global default. Pullback band: max toward 0, min toward
   * negative, both fraction [-1, 0].
   */
  symbolPullbackMaxOverride: Record<string, number>
  symbolPullbackMinOverride: Record<string, number>
  symbolMinReturn50dOverride: Record<string, number>
  symbolMaxAtrRatioOverride: Record<string, number>
  symbolMaxSma50DeviationPctOverride: Record<string, number>
  /** Both true and false are present in the map; missing = no override. */
  symbolRequireAboveSma50Override: Record<string, boolean>
  /**
   * Only symbols with entry_required=true are present. While the gate
   * isn't passed, active weight is 0 and allocation reroutes to cash
   * fallback.
   */
  symbolEntryRequired: Record<string, boolean>
  /** Only symbols with always_active=true are present (used for cash_parking). */
  symbolAlwaysActive: Record<string, boolean>
  /** Missing key = no fallback (an invalid ticker or self-reference is dropped, stays in cash). */
  symbolCashFallback: Record<string, string[]>
}

/**
 * Loads the per-symbol config from D1. A single query is cheap; no cache at
 * this layer — call sites hold the snapshot for the duration of one handler.
 * Fetches both active states and splits them into `allowedSymbols` /
 * `inactiveSymbols` so the dashboard can show disabled symbols grayed-out,
 * while cron/risk gate keep reading `allowedSymbols` only.
 */
export async function loadSymbolConfig(
  db: DrizzleD1Database,
): Promise<SymbolConfigSnapshot> {
  const rows = await db.select().from(symbolConfig)

  const allowedSymbols: string[] = []
  const inactiveSymbols: string[] = []
  const symbolMaxNotional: Record<string, number> = {}
  const symbolCurrency: Record<string, SymbolCurrency> = {}
  const symbolMarket: Record<string, SymbolMarket> = {}
  const symbolName: Record<string, string> = {}
  const symbolNotes: Record<string, string> = {}
  const symbolTimeStopDaysOverride: Record<string, number> = {}
  const symbolKAtrOverride: Record<string, number> = {}
  const symbolBudgetAllocPct: Record<string, number> = {}
  const symbolLotSize: Record<string, number> = {}
  const symbolStopPctOverride: Record<string, number> = {}
  const symbolTakeProfitPctOverride: Record<string, number> = {}
  const symbolIntradayOnly: Record<string, boolean> = {}
  const symbolRole: Record<string, SymbolRoleValue> = {}
  const symbolPullbackMaxOverride: Record<string, number> = {}
  const symbolPullbackMinOverride: Record<string, number> = {}
  const symbolMinReturn50dOverride: Record<string, number> = {}
  const symbolMaxAtrRatioOverride: Record<string, number> = {}
  const symbolMaxSma50DeviationPctOverride: Record<string, number> = {}
  const symbolRequireAboveSma50Override: Record<string, boolean> = {}
  const symbolEntryRequired: Record<string, boolean> = {}
  const symbolAlwaysActive: Record<string, boolean> = {}
  const symbolCashFallback: Record<string, string[]> = {}
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
    // No DB CHECK constrains this column, so an invalid value falls back
    // to 'US' rather than propagating.
    symbolMarket[symbol] = row.market === 'JP' ? 'JP' : 'US'
    const trimmedName = row.name?.trim()
    if (trimmedName && trimmedName.length > 0) {
      symbolName[symbol] = trimmedName
    }
    const trimmedNotes = row.notes?.trim()
    if (trimmedNotes && trimmedNotes.length > 0) {
      symbolNotes[symbol] = trimmedNotes
    }
    // DB CHECK already ranges these; Number.isFinite is a defensive second
    // check so NaN can never reach downstream.
    if (
      row.timeStopDaysOverride !== null &&
      row.timeStopDaysOverride !== undefined &&
      Number.isFinite(row.timeStopDaysOverride)
    ) {
      symbolTimeStopDaysOverride[symbol] = row.timeStopDaysOverride
    }
    if (
      row.kAtrOverride !== null &&
      row.kAtrOverride !== undefined &&
      Number.isFinite(row.kAtrOverride)
    ) {
      symbolKAtrOverride[symbol] = row.kAtrOverride
    }
    if (
      row.budgetAllocPct !== null &&
      row.budgetAllocPct !== undefined &&
      Number.isFinite(row.budgetAllocPct) &&
      row.budgetAllocPct > 0 &&
      row.budgetAllocPct <= 1
    ) {
      symbolBudgetAllocPct[symbol] = row.budgetAllocPct
    }
    // An invalid lot_size stays out of the map on purpose — sizing fails
    // closed for that symbol rather than falling back to a blanket default.
    if (
      row.lotSize !== null &&
      row.lotSize !== undefined &&
      Number.isFinite(row.lotSize) &&
      Number.isInteger(row.lotSize) &&
      row.lotSize >= 1
    ) {
      symbolLotSize[symbol] = row.lotSize
    }
    // Validated by sign and range, not just presence — a direct DB edit
    // that puts stop=0/positive or TP=0/negative still falls back to the
    // global default instead of reaching Risk (defense in depth alongside
    // the admin-parse validation).
    if (
      row.stopPctOverride !== null &&
      row.stopPctOverride !== undefined &&
      Number.isFinite(row.stopPctOverride) &&
      row.stopPctOverride < 0 &&
      row.stopPctOverride >= -1
    ) {
      symbolStopPctOverride[symbol] = row.stopPctOverride
    }
    if (
      row.takeProfitPctOverride !== null &&
      row.takeProfitPctOverride !== undefined &&
      Number.isFinite(row.takeProfitPctOverride) &&
      row.takeProfitPctOverride > 0 &&
      row.takeProfitPctOverride <= 1
    ) {
      symbolTakeProfitPctOverride[symbol] = row.takeProfitPctOverride
    }
    if (row.intradayOnly === true) {
      symbolIntradayOnly[symbol] = true
    }
    if (row.role !== null && row.role !== undefined) {
      const trimmedRole = row.role.trim()
      if (trimmedRole.length > 0) {
        symbolRole[symbol] = isSymbolRole(trimmedRole) ? trimmedRole : 'unknown'
      }
    }
    // A max < min band inconsistency isn't rejected here — it only ever
    // resolves to "entry never passes," which is the fail-closed side
    // anyway. Cross-checked instead at admin-parse input time.
    if (
      row.pullbackMaxOverride !== null &&
      row.pullbackMaxOverride !== undefined &&
      Number.isFinite(row.pullbackMaxOverride) &&
      row.pullbackMaxOverride >= -1 &&
      row.pullbackMaxOverride <= 0
    ) {
      symbolPullbackMaxOverride[symbol] = row.pullbackMaxOverride
    }
    if (
      row.pullbackMinOverride !== null &&
      row.pullbackMinOverride !== undefined &&
      Number.isFinite(row.pullbackMinOverride) &&
      row.pullbackMinOverride >= -1 &&
      row.pullbackMinOverride <= 0
    ) {
      symbolPullbackMinOverride[symbol] = row.pullbackMinOverride
    }
    if (
      row.minReturn50dOverride !== null &&
      row.minReturn50dOverride !== undefined &&
      Number.isFinite(row.minReturn50dOverride) &&
      row.minReturn50dOverride >= -1 &&
      row.minReturn50dOverride <= 10
    ) {
      symbolMinReturn50dOverride[symbol] = row.minReturn50dOverride
    }
    if (
      row.maxAtrRatioOverride !== null &&
      row.maxAtrRatioOverride !== undefined &&
      Number.isFinite(row.maxAtrRatioOverride) &&
      row.maxAtrRatioOverride > 0 &&
      row.maxAtrRatioOverride <= 10
    ) {
      symbolMaxAtrRatioOverride[symbol] = row.maxAtrRatioOverride
    }
    if (
      row.maxSma50DeviationPctOverride !== null &&
      row.maxSma50DeviationPctOverride !== undefined &&
      Number.isFinite(row.maxSma50DeviationPctOverride) &&
      row.maxSma50DeviationPctOverride > 0 &&
      row.maxSma50DeviationPctOverride <= 10
    ) {
      symbolMaxSma50DeviationPctOverride[symbol] = row.maxSma50DeviationPctOverride
    }
    if (row.requireAboveSma50Override === true || row.requireAboveSma50Override === false) {
      symbolRequireAboveSma50Override[symbol] = row.requireAboveSma50Override
    }
    if (row.entryRequired === true) {
      symbolEntryRequired[symbol] = true
    }
    if (row.alwaysActive === true) {
      symbolAlwaysActive[symbol] = true
    }
    // Each fallback element is validated (ticker syntax, no self-reference);
    // an invalid element is dropped rather than kept, since leaving that
    // share in cash is safer than routing it to a bad target.
    const fallbacks = parseCashFallbacksJson(row.cashFallbackSymbols, symbol)
    if (fallbacks.length > 0) {
      symbolCashFallback[symbol] = fallbacks
    }
  }
  return {
    allowedSymbols,
    inactiveSymbols,
    symbolMaxNotional,
    symbolCurrency,
    symbolMarket,
    symbolName,
    symbolNotes,
    symbolTimeStopDaysOverride,
    symbolKAtrOverride,
    symbolBudgetAllocPct,
    symbolLotSize,
    symbolStopPctOverride,
    symbolTakeProfitPctOverride,
    symbolIntradayOnly,
    symbolRole,
    symbolPullbackMaxOverride,
    symbolPullbackMinOverride,
    symbolMinReturn50dOverride,
    symbolMaxAtrRatioOverride,
    symbolMaxSma50DeviationPctOverride,
    symbolRequireAboveSma50Override,
    symbolEntryRequired,
    symbolAlwaysActive,
    symbolCashFallback,
  }
}

/** Used for the admin CRUD UI's before/after snapshots. */
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
  notes: string | null
  /** Null = use the global default (1-365 integer). Forces a shorter hold, e.g. for 3x leveraged ETFs. */
  timeStopDaysOverride: number | null
  /** Null = use the global default (0.5-5.0 float). Loosens the ATR stop for high-vol symbols. */
  kAtrOverride: number | null
  /** Null = risk-% sizing (fraction 0<pct<=1 for fixed-% allocation mode). */
  budgetAllocPct: number | null
  /**
   * Integer >= 1, required at admin-parse time. Null occurs only for a
   * pre-migration row; cron sizing treats null as fail-closed.
   */
  lotSize: number | null
  /** Negative fraction; null = global default. */
  stopPctOverride: number | null
  /** Positive fraction; null = global default. */
  takeProfitPctOverride: number | null
  /** Force-closes before the US close when true. Default false. */
  intradayOnly: boolean
  /** Null = legacy behavior. Admin-parse enforces the enum. */
  role: SymbolRole | null
  /** Null = role preset → global default fall-through. */
  pullbackMaxOverride: number | null
  pullbackMinOverride: number | null
  minReturn50dOverride: number | null
  maxAtrRatioOverride: number | null
  maxSma50DeviationPctOverride: number | null
  requireAboveSma50Override: boolean | null
  /** True makes passing the gate a precondition for actual allocation. Default false. */
  entryRequired: boolean
  /** True keeps target = active always (used for cash_parking). Default false. */
  alwaysActive: boolean
  /** Null = no fallback on a failed gate. */
  cashFallbackSymbols: string[] | null
}

/**
 * Inserts a new `symbol_config` row; returns null (caller returns 409) if
 * the symbol already exists. Attempts the INSERT directly and converts a
 * UNIQUE-constraint failure to `null`, rather than a pre-check + INSERT —
 * the latter is a TOCTOU race where two concurrent inserts can both pass
 * the pre-check and the second then 500s on the constraint violation.
 */
export async function insertSymbolConfig(
  db: DrizzleD1Database,
  input: SymbolConfigWriteInput,
  nowIso: string,
): Promise<SymbolConfigRow | null> {
  try {
    await db.insert(symbolConfig).values({
      symbol: input.symbol,
      name: input.name,
      market: input.market,
      currency: input.currency,
      active: input.active,
      maxNotional: input.maxNotional,
      notes: input.notes,
      timeStopDaysOverride: input.timeStopDaysOverride,
      kAtrOverride: input.kAtrOverride,
      budgetAllocPct: input.budgetAllocPct,
      lotSize: input.lotSize,
      stopPctOverride: input.stopPctOverride,
      takeProfitPctOverride: input.takeProfitPctOverride,
      intradayOnly: input.intradayOnly,
      role: input.role,
      pullbackMaxOverride: input.pullbackMaxOverride,
      pullbackMinOverride: input.pullbackMinOverride,
      minReturn50dOverride: input.minReturn50dOverride,
      maxAtrRatioOverride: input.maxAtrRatioOverride,
      maxSma50DeviationPctOverride: input.maxSma50DeviationPctOverride,
      requireAboveSma50Override: input.requireAboveSma50Override,
      entryRequired: input.entryRequired,
      alwaysActive: input.alwaysActive,
      cashFallbackSymbols: cashFallbacksToJson(input.cashFallbackSymbols),
      updatedAt: nowIso,
    })
  } catch (err) {
    if (isUniqueConstraintError(err)) return null
    throw err
  }
  return await findSymbolConfig(db, input.symbol)
}

/**
 * Matched by message substring rather than an error type/code, since
 * drizzle wraps the underlying SQLite/D1 error and different drivers don't
 * agree on a stable code — but both include `UNIQUE constraint failed`.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return message.includes('UNIQUE constraint failed')
}

/** Returns null (caller returns 404) when the symbol doesn't exist. The symbol itself is immutable. */
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
      notes: input.notes,
      timeStopDaysOverride: input.timeStopDaysOverride,
      kAtrOverride: input.kAtrOverride,
      budgetAllocPct: input.budgetAllocPct,
      lotSize: input.lotSize,
      stopPctOverride: input.stopPctOverride,
      takeProfitPctOverride: input.takeProfitPctOverride,
      intradayOnly: input.intradayOnly,
      role: input.role,
      pullbackMaxOverride: input.pullbackMaxOverride,
      pullbackMinOverride: input.pullbackMinOverride,
      minReturn50dOverride: input.minReturn50dOverride,
      maxAtrRatioOverride: input.maxAtrRatioOverride,
      maxSma50DeviationPctOverride: input.maxSma50DeviationPctOverride,
      requireAboveSma50Override: input.requireAboveSma50Override,
      entryRequired: input.entryRequired,
      alwaysActive: input.alwaysActive,
      cashFallbackSymbols: cashFallbacksToJson(input.cashFallbackSymbols),
      updatedAt: nowIso,
    })
    .where(eq(symbolConfig.symbol, input.symbol))
  return await findSymbolConfig(db, input.symbol)
}

/**
 * Deactivates a symbol after the broker permanently rejects orders for it
 * (e.g. TICKER_IS_DENY). Appends `reasonNote` to any existing notes
 * (truncated to 256 chars) rather than replacing them. A no-op (`null`) if
 * already inactive, so a same-tick re-detection can't append the reason
 * twice. Re-activation is operator-only; this never re-enables a symbol.
 */
export async function deactivateSymbolForBrokerDeny(
  db: DrizzleD1Database,
  symbol: string,
  reasonNote: string,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const upper = symbol.trim().toUpperCase()
  const before = await findSymbolConfig(db, upper)
  if (before === null || !before.active) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  const existingNotes = before.notes?.trim() ?? ''
  const mergedNotes = (existingNotes.length > 0 ? `${existingNotes} / ${reasonNote}` : reasonNote).slice(0, 256)
  await db
    .update(symbolConfig)
    .set({ active: false, notes: mergedNotes, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, upper))
  const after = await findSymbolConfig(db, upper)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

/**
 * Flips `active` with a SQL-level `NOT active`, not a read-modify-write —
 * two concurrent toggles reading the same `before` and writing the same
 * value back would otherwise both land on the same flipped state instead
 * of toggling twice. The audit before/after is still read via a separate
 * SELECT-UPDATE-SELECT, so under heavy concurrency it can observe a
 * one-step-stale transition; the DB state itself stays correct either way.
 */
export async function toggleSymbolActive(
  db: DrizzleD1Database,
  symbol: string,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  await db
    .update(symbolConfig)
    .set({ active: sql`NOT ${symbolConfig.active}`, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

/** Validated parse of the cash-fallback JSON array. Any malformed input becomes an empty array (= no fallback). */
export function parseCashFallbacksJson(raw: string | null | undefined, selfSymbol: string): string[] {
  if (raw === null || raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const sym = item.trim().toUpperCase()
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) continue
    if (sym === selfSymbol.toUpperCase()) continue
    if (!out.includes(sym)) out.push(sym)
    if (out.length >= MAX_CASH_FALLBACKS) break
  }
  return out
}

/** Caps the fallback count so an even split can't dilute each share too thin. */
export const MAX_CASH_FALLBACKS = 4

function cashFallbacksToJson(targets: string[] | null): string | null {
  if (targets === null || targets.length === 0) return null
  return JSON.stringify(targets)
}

/**
 * Sets or clears a symbol's cash-fallback targets. Setting also turns on
 * `entryRequired`, so a fallback can't be configured while conditional
 * allocation stays off — that combination is a dormant setting that looks
 * configured but never fires. Clearing leaves `entryRequired` untouched,
 * since that's a separate decision. Skips the write when nothing changed,
 * so `updatedAt` doesn't advance without an audited change.
 */
export async function updateCashFallback(
  db: DrizzleD1Database,
  symbol: string,
  targets: string[] | null,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  // Both sides of a pair each holding their own fallback is a valid
  // configuration, not a mutual-exclusion bug — the allocation split
  // handles multiple targets by dividing evenly.
  const normalized = cashFallbacksToJson(targets)
  const sameTarget = (before.cashFallbackSymbols ?? null) === normalized
  const needsEntryRequired = normalized !== null && before.entryRequired !== true
  if (sameTarget && !needsEntryRequired) {
    return { before: beforeSnapshot, after: beforeSnapshot }
  }
  await db
    .update(symbolConfig)
    .set({
      cashFallbackSymbols: normalized,
      ...(normalized !== null ? { entryRequired: true } : {}),
      updatedAt: nowIso,
    })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

/**
 * Focused update of `budgetAllocPct` alone. `pct` is a fraction (0, 1] or
 * null (reverts to risk-% sizing). Skips the write when unchanged, so
 * `updatedAt` doesn't advance without an audited change.
 */
export async function updateBudgetAllocPct(
  db: DrizzleD1Database,
  symbol: string,
  pct: number | null,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  if ((before.budgetAllocPct ?? null) === (pct ?? null)) {
    return { before: beforeSnapshot, after: beforeSnapshot }
  }
  await db
    .update(symbolConfig)
    .set({ budgetAllocPct: pct, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

/**
 * Hard-deletes the row; only allowed when `active=false` (an active row
 * returns `{ rejected: 'still_active' }`, since toggle-active already
 * covers taking a symbol out of rotation). No FK is declared, so a
 * historical `trade_journal` row keeping the symbol string after deletion
 * is an accepted orphan reference, not a bug — the audit trail lives in a
 * separate table and survives regardless.
 */
export async function hardDeleteSymbol(
  db: DrizzleD1Database,
  symbol: string,
): Promise<{ before: SymbolConfigRow } | { rejected: 'still_active' } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  if (before.active) {
    return { rejected: 'still_active' }
  }
  const beforeSnapshot: SymbolConfigRow = { ...before }
  await db.delete(symbolConfig).where(eq(symbolConfig.symbol, symbol))
  return { before: beforeSnapshot }
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

/**
 * Regime-enabled (`regime_enabled=1`) pairs. A misconfigured entry (bad
 * proxy/bull symbol) is still returned, carrying `invalidConfig`, rather
 * than skipped — the scheduler needs it present so it can fail closed to
 * zone=unknown (both sides BUY-blocked) instead of silently treating it as
 * disabled.
 */
export async function loadPairRegimeConfigs(
  db: DrizzleD1Database,
): Promise<import('../../trading/strategy/pairRegime').PairRegimeEntry[]> {
  const rows = await db.select().from(inversePairs)
  const entries: import('../../trading/strategy/pairRegime').PairRegimeEntry[] = []
  for (const row of rows) {
    if (!row.regimeEnabled) continue
    const a = row.symbol.toUpperCase()
    const b = row.inverse.toUpperCase()
    const proxy = row.regimeProxySymbol?.trim().toUpperCase() ?? ''
    const bull = row.regimeBullSymbol?.trim().toUpperCase() ?? ''
    let invalidConfig: string | null = null
    if (a === b) {
      // The write path (buildInversePairWrite) rejects a self-pair, but a
      // direct DB edit can still produce one — caught here too.
      invalidConfig = `inverse pair must contain two distinct symbols (got ${a}/${b})`
    } else if (proxy.length === 0 || !/^[A-Z0-9]{1,10}$/.test(proxy)) {
      invalidConfig = `regime_proxy_symbol is missing/invalid for pair ${a}/${b}`
    } else if (bull !== a && bull !== b) {
      invalidConfig = `regime_bull_symbol must be ${a} or ${b} (got '${bull}')`
    }
    const bullSymbol = bull === b ? b : a
    const bearSymbol = bullSymbol === a ? b : a
    entries.push({ bullSymbol, bearSymbol, proxySymbol: proxy || a, invalidConfig })
  }
  return entries
}

/**
 * Builds the statements for a 1:1 inverse-pair link: only one canonical row
 * is stored, and `loadInversePairs` expands it bidirectionally. Deletes
 * every existing row touching either symbol before inserting the new one,
 * so re-pairing a symbol can't leave a stale link (e.g. SOXL↔SOXS and
 * SOXL↔TQQQ coexisting). Throws on a self-pair.
 *
 * Returns statements rather than executing them, so `createSymbolPair` can
 * batch them into the same transaction as the `symbol_config` writes.
 */
function buildInversePairWrite(
  db: DrizzleD1Database,
  a: string,
  b: string,
  nowIso: string,
) {
  const left = a.trim().toUpperCase()
  const right = b.trim().toUpperCase()
  if (left.length === 0 || right.length === 0) {
    throw new Error('inverse pair requires two non-empty symbols')
  }
  if (left === right) {
    throw new Error(`inverse pair cannot be self-referential: ${left}`)
  }
  return [
    // Deletes any existing link touching either symbol, in either stored direction.
    db
      .delete(inversePairs)
      .where(
        or(
          eq(inversePairs.symbol, left),
          eq(inversePairs.inverse, left),
          eq(inversePairs.symbol, right),
          eq(inversePairs.inverse, right),
        ),
      ),
    db.insert(inversePairs).values({ symbol: left, inverse: right, updatedAt: nowIso }),
  ] as const
}

export async function setInversePair(
  db: DrizzleD1Database,
  a: string,
  b: string,
  nowIso: string,
): Promise<void> {
  const [del, ins] = buildInversePairWrite(db, a, b, nowIso)
  await db.batch([del, ins])
}

/**
 * Deletes all `inverse_pairs` rows touching `symbol`. Called alongside
 * `symbol_config`'s hard delete so a deleted symbol doesn't leave a
 * half-pair; the counterpart's `symbol_config` row is untouched.
 */
export async function deleteInversePairsForSymbol(
  db: DrizzleD1Database,
  symbol: string,
): Promise<void> {
  const s = symbol.trim().toUpperCase()
  await db
    .delete(inversePairs)
    .where(or(eq(inversePairs.symbol, s), eq(inversePairs.inverse, s)))
}

export interface CreateSymbolPairResult {
  /** 'duplicate' on a primary UNIQUE collision, 'created' on success. */
  primary: 'created' | 'duplicate'
  /** False when the counterpart already existed (ON CONFLICT DO NOTHING). */
  counterpartCreated: boolean
}

/** Counterpart metadata sourced from a Yahoo lookup. Omitted fields inherit from primary; name defaults to null. */
export interface CounterpartMeta {
  name?: string | null
  market?: SymbolMarket
  currency?: SymbolCurrency
}

/**
 * Registers a bull/bear pair from one form submission, atomically via D1
 * batch: INSERT the primary `symbol_config` (returns 'duplicate' on
 * collision, without creating anything), INSERT-OR-IGNORE the counterpart
 * (preferring `CounterpartMeta` for name/market/currency, else inheriting
 * primary's market/currency with a null name; `maxNotional` always
 * inherits from primary), then link them via `buildInversePairWrite`.
 */
export async function createSymbolPair(
  db: DrizzleD1Database,
  primary: SymbolConfigWriteInput,
  inverseSymbol: string,
  nowIso: string,
  counterpartMeta: CounterpartMeta = {},
): Promise<CreateSymbolPairResult> {
  const primarySym = primary.symbol.trim().toUpperCase()
  const counterpartSym = inverseSymbol.trim().toUpperCase()
  if (counterpartSym.length === 0) {
    throw new Error('createSymbolPair requires a non-empty inverse symbol')
  }
  if (primarySym === counterpartSym) {
    throw new Error(`inverse pair cannot be self-referential: ${primarySym}`)
  }

  // Primary is inserted standalone first so a UNIQUE collision (duplicate)
  // short-circuits before touching the counterpart or the link.
  const inserted = await insertSymbolConfig(db, { ...primary, symbol: primarySym }, nowIso)
  if (inserted === null) {
    return { primary: 'duplicate', counterpartCreated: false }
  }

  const counterpartBefore = await findSymbolConfig(db, counterpartSym)
  const [delLink, insLink] = buildInversePairWrite(db, primarySym, counterpartSym, nowIso)

  if (counterpartBefore === null) {
    const counterpartName = counterpartMeta.name?.trim()
    const insCounterpart = db.insert(symbolConfig).values({
      symbol: counterpartSym,
      name: counterpartName && counterpartName.length > 0 ? counterpartName : null,
      market: counterpartMeta.market ?? primary.market,
      currency: counterpartMeta.currency ?? primary.currency,
      active: true,
      maxNotional: primary.maxNotional,
      notes: null,
      timeStopDaysOverride: null,
      kAtrOverride: null,
      // A regime hedge is funded from the same budget as its pair.
      budgetAllocPct: primary.budgetAllocPct,
      // An inverse pair shares the same instrument type (e.g. both 3x
      // ETFs), so lot size, stop/TP overrides, and intraday-only inherit
      // too. Edit the counterpart individually if it differs.
      lotSize: primary.lotSize,
      stopPctOverride: primary.stopPctOverride,
      takeProfitPctOverride: primary.takeProfitPctOverride,
      intradayOnly: primary.intradayOnly,
      // Role and entry-gate overrides are NOT inherited: the counterpart
      // trades the opposite direction, so the primary's entry thresholds
      // (e.g. a bull-side pullback band) don't apply to it. Starts at
      // legacy behavior (null) until set individually.
      role: null,
      pullbackMaxOverride: null,
      pullbackMinOverride: null,
      minReturn50dOverride: null,
      maxAtrRatioOverride: null,
      maxSma50DeviationPctOverride: null,
      requireAboveSma50Override: null,
      entryRequired: false,
      alwaysActive: false,
      cashFallbackSymbols: null,
      updatedAt: nowIso,
    })
    await db.batch([delLink, insCounterpart, insLink])
  } else {
    await db.batch([delLink, insLink])
  }
  return { primary: 'created', counterpartCreated: counterpartBefore === null }
}
