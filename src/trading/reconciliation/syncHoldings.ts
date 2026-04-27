import type { Env } from '../../config/env'
import type { WebullPositionDto } from '../../infrastructure/webull/dto'
import type { PositionStore } from '../state/PositionStore'
import type { PositionState, SymbolState } from '../state/types'

/**
 * Operator-driven reconcile of per-symbol DO position against broker truth.
 *
 * Backstory: PR #215 fixed the reconcile idempotency race that originally
 * corrupted DO state, and PR #221 added an in-flight SELL_QTY_EXCEED fallback
 * that re-reads broker `available_quantity` before retrying a SELL. Neither
 * touches **already-corrupted** DO rows that pre-date those fixes (e.g. the
 * SOXL row with DO qty=8 vs broker actual=4). This module is the manual one-
 * shot tool to walk the universe, compare DO `position.qty` against the
 * Webull `/openapi/account/positions` truth, and overwrite the DO row when
 * they disagree.
 *
 * Safety stance:
 *   - Read-only against the broker (`getPositions()` only — no orders).
 *   - Mutates DO state via `PositionStore.overridePosition`, which already
 *     emits a structured audit log per write. We add an outer
 *     `holdings_sync_applied` log so the caller's request id is correlated
 *     with the symbol-level diff.
 *   - `dryRun=true` returns the same diff shape but skips every override —
 *     intended for "show me what would change" before letting it loose.
 *   - `avgPrice` policy: prefer broker `avg_cost` when finite + positive,
 *     else keep the existing DO `avgPrice`. Falling through to `0` would
 *     break realized-PnL math in `recordFill` so we explicitly avoid that.
 */
export interface SyncHoldingResult {
  symbol: string
  /** DO position before the override (null if there was none). */
  before: PositionState | null
  /** DO position after the override (null if `dryRun` or `brokerQty=0`). */
  after: PositionState | null
  /** Broker-side `available_quantity`. `null` = symbol not held on broker. */
  broker_qty: number | null
  /** Broker-side `avg_cost` if parseable, else `null`. */
  broker_avg: number | null
  /**
   * Set when the row was a no-op:
   *   - `'no_drift'`: broker_qty == DO qty, nothing to do.
   *   - `'dry_run'`:  drift detected but `options.dryRun=true`, so we report
   *                   the planned `before/after` without mutating DO state.
   */
  skipped?: 'no_drift' | 'dry_run'
}

export interface SyncHoldingError {
  symbol: string
  error: string
}

export interface SyncHoldingsSummary {
  synced: SyncHoldingResult[]
  errors: SyncHoldingError[]
  summary: {
    total: number
    synced: number
    no_drift: number
    errors: number
  }
  dryRun: boolean
}

export interface SyncHoldingsOptions {
  /** Restrict to a single symbol (already upper-cased by caller). */
  symbol?: string
  /** When true, compute diffs but do not write to the DO. */
  dryRun: boolean
  /** Audit-correlation id from the route layer (`c.get('requestId')`). */
  requestId: string | null
}

export interface SyncHoldingsDeps {
  /** Universe to walk when `options.symbol` is undefined. */
  allowedSymbols: string[]
  /** Webull positions snapshot loader (read-only). */
  fetchPositions: () => Promise<WebullPositionDto[]>
  /** DO surface — `getState` + `overridePosition`. */
  positionStore: Pick<PositionStore, 'getState' | 'overridePosition'>
}

/**
 * Walk `allowedSymbols` (or the single symbol filter), pull broker positions
 * once, diff against DO state, and emit overrides where they disagree.
 *
 * One broker round-trip per call (positions endpoint is account-wide). The
 * `errors[]` channel keeps a per-symbol failure from poisoning the rest of
 * the run — a 500 from `overridePosition` on AAPL still lets MSFT proceed.
 */
export async function syncHoldings(
  options: SyncHoldingsOptions,
  deps: SyncHoldingsDeps,
): Promise<SyncHoldingsSummary> {
  const target = options.symbol?.toUpperCase()
  const symbols = target
    ? [target]
    : deps.allowedSymbols.map((s) => s.toUpperCase())

  // Single positions fetch shared across the loop. If it throws (auth /
  // network), every symbol gets the same error rather than each retrying.
  let brokerByUpper: Map<string, WebullPositionDto> | null = null
  let brokerFetchError: string | null = null
  try {
    const positions = await deps.fetchPositions()
    brokerByUpper = new Map(
      positions
        .filter((p) => typeof p.symbol === 'string' && p.symbol.length > 0)
        .map((p) => [(p.symbol as string).toUpperCase(), p]),
    )
  } catch (err) {
    brokerFetchError = `broker positions fetch failed: ${messageOf(err)}`
  }

  const synced: SyncHoldingResult[] = []
  const errors: SyncHoldingError[] = []

  for (const sym of symbols) {
    if (brokerFetchError !== null) {
      errors.push({ symbol: sym, error: brokerFetchError })
      continue
    }
    try {
      const brokerPos = brokerByUpper!.get(sym)
      const brokerQty = parseBrokerQty(brokerPos)
      const brokerAvg = parseBrokerAvg(brokerPos)
      const state = await deps.positionStore.getState(sym)
      const before = state.position
      const doQty = before?.qty ?? 0

      // No-drift fast path. We treat "broker has no row" as `brokerQty=0`
      // for comparison purposes (Webull omits zero-quantity positions). If
      // DO is already null/0, this is a true no-op.
      const effectiveBrokerQty = brokerQty ?? 0
      if (effectiveBrokerQty === doQty) {
        synced.push({
          symbol: sym,
          before,
          after: before,
          broker_qty: brokerQty,
          broker_avg: brokerAvg,
          skipped: 'no_drift',
        })
        continue
      }

      // Drift detected. dryRun returns the planned shape without writing.
      if (options.dryRun) {
        const plannedAfter = computePlannedAfter({
          brokerQty: effectiveBrokerQty,
          brokerAvg,
          before,
        })
        synced.push({
          symbol: sym,
          before,
          after: plannedAfter,
          broker_qty: brokerQty,
          broker_avg: brokerAvg,
          skipped: 'dry_run',
        })
        continue
      }

      const after = await applyOverride({
        positionStore: deps.positionStore,
        symbol: sym,
        before,
        brokerQty: effectiveBrokerQty,
        brokerAvg,
        requestId: options.requestId,
      })
      console.log(
        JSON.stringify({
          event: 'holdings_sync_applied',
          symbol: sym,
          before,
          after,
          broker_qty: brokerQty,
          broker_avg: brokerAvg,
          requestId: options.requestId,
          dryRun: false,
        }),
      )
      synced.push({
        symbol: sym,
        before,
        after,
        broker_qty: brokerQty,
        broker_avg: brokerAvg,
      })
    } catch (err) {
      errors.push({ symbol: sym, error: messageOf(err) })
    }
  }

  const noDriftCount = synced.filter((r) => r.skipped === 'no_drift').length
  const syncedCount = synced.length - noDriftCount
  return {
    synced,
    errors,
    summary: {
      total: synced.length + errors.length,
      synced: syncedCount,
      no_drift: noDriftCount,
      errors: errors.length,
    },
    dryRun: options.dryRun,
  }
}

interface ApplyOverrideArgs {
  positionStore: Pick<PositionStore, 'overridePosition'>
  symbol: string
  before: PositionState | null
  brokerQty: number
  brokerAvg: number | null
  requestId: string | null
}

/**
 * Apply the override and return the post-state's `position`. Encapsulates
 * the avg-price fallback policy: prefer broker `avg_cost`, else preserve DO
 * `avgPrice`, else (only when broker forces a `qty>0` row with no usable
 * avg) refuse — `overridePosition` rejects `avgPrice<=0` for a non-zero
 * qty, which is the right behaviour (a synthetic 0 would corrupt PnL).
 */
async function applyOverride(args: ApplyOverrideArgs): Promise<PositionState | null> {
  const { positionStore, symbol, before, brokerQty, brokerAvg, requestId } = args

  // Broker says zero (or omits the row): close the DO position.
  if (brokerQty <= 0) {
    const state = await positionStore.overridePosition(symbol, {
      qty: 0,
      avgPrice: 0,
      openedAt: null,
      reason: buildReason(before?.qty ?? 0, 0),
      requestId,
    })
    return state.position
  }

  const avgPrice = pickAvgPrice(brokerAvg, before?.avgPrice ?? null)
  if (avgPrice === null) {
    // Should be very rare: broker has shares but reports no avg_cost AND we
    // have no prior DO avgPrice to preserve. Surface as an error rather
    // than silently writing avgPrice=0 (would break recordFill PnL math).
    throw new Error(
      `cannot determine avgPrice for ${symbol}: broker avg_cost missing and no DO avgPrice to preserve`,
    )
  }
  const openedAt = before?.openedAt ?? null
  const state = await positionStore.overridePosition(symbol, {
    qty: brokerQty,
    avgPrice,
    openedAt,
    reason: buildReason(before?.qty ?? 0, brokerQty),
    requestId,
  })
  return state.position
}

function computePlannedAfter(args: {
  brokerQty: number
  brokerAvg: number | null
  before: PositionState | null
}): PositionState | null {
  const { brokerQty, brokerAvg, before } = args
  if (brokerQty <= 0) return null
  const avgPrice = pickAvgPrice(brokerAvg, before?.avgPrice ?? null)
  if (avgPrice === null) {
    // Mirror the live error path — a dryRun shouldn't pretend it can write
    // `avgPrice=0`. Returning the existing `before` keeps the diff
    // visible (qty changes) while signalling no usable avg via null.
    return null
  }
  return {
    qty: brokerQty,
    avgPrice,
    openedAt: before?.openedAt ?? new Date(0).toISOString(),
  }
}

/**
 * Choose the avgPrice to write back. Broker `avg_cost` wins when usable;
 * otherwise we fall through to the existing DO avgPrice rather than zero.
 * Returns `null` when neither source yields a positive finite number.
 */
function pickAvgPrice(brokerAvg: number | null, doAvg: number | null): number | null {
  if (brokerAvg !== null && Number.isFinite(brokerAvg) && brokerAvg > 0) return brokerAvg
  if (doAvg !== null && Number.isFinite(doAvg) && doAvg > 0) return doAvg
  return null
}

function parseBrokerQty(pos: WebullPositionDto | undefined): number | null {
  if (pos === undefined) return null
  const raw = pos.available_quantity
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function parseBrokerAvg(pos: WebullPositionDto | undefined): number | null {
  if (pos === undefined) return null
  const raw = pos.avg_cost
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function buildReason(beforeQty: number, afterQty: number): string {
  return `holdings_sync_endpoint: DO qty=${beforeQty} → broker qty=${afterQty}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Re-export for the route layer — keeps the typed `Env` import close to the
 * call site so the route doesn't need to know about the WebullClient
 * factory.
 */
export type SyncHoldingsEnv = Env

export const _internal = {
  pickAvgPrice,
  parseBrokerQty,
  parseBrokerAvg,
  computePlannedAfter,
}
