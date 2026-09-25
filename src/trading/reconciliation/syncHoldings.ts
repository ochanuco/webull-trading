import type { WebullPositionDto } from '../../infrastructure/webull/dto'
import type { PositionStore } from '../state/PositionStore'
import type { PositionState, SymbolState } from '../state/types'

interface SyncHoldingResult {
  symbol: string
  /** DO position before the override (null if there was none). */
  before: PositionState | null
  /** DO position after the override (null if `dryRun` or `brokerQty=0`). */
  after: PositionState | null
  /** Broker-side `available_quantity`. `null` = symbol not held on broker. */
  broker_qty: number | null
  /** Broker-side `avg_cost` if parseable, else `null`. */
  broker_avg: number | null
  /** `'no_drift'`: broker qty already matches DO. `'dry_run'`: drift found but not written — see `options.dryRun`. */
  skipped?: 'no_drift' | 'dry_run'
}

interface SyncHoldingError {
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
  /** `'broker_returned_empty_diff_suspicious'`: dryRun diff that would have tripped the safe-fail guard on a live call. Never set alongside a safe-fail `errors` abort. */
  warnings?: string[]
}

export interface SyncHoldingsOptions {
  /** Restrict to a single symbol (already upper-cased by caller). */
  symbol?: string
  /** When true, compute diffs but do not write to the DO. */
  dryRun: boolean
  /** Bypasses the safe-fail guard below to allow a genuine broker-side liquidation to zero out the DO. Default `false`. */
  force?: boolean
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
 * Diffs each symbol's DO position against Webull's broker truth and
 * overwrites the DO row where they disagree. Read-only against the broker
 * (`getPositions()` only); `dryRun` computes the diff without writing.
 *
 * One broker round-trip per call, so a fetch failure or the safe-fail guard
 * applies uniformly to every symbol. Per-symbol write failures land in
 * `errors[]` instead of aborting, so one bad `overridePosition` call doesn't
 * block the rest of the universe.
 */
export async function syncHoldings(
  options: SyncHoldingsOptions,
  deps: SyncHoldingsDeps,
): Promise<SyncHoldingsSummary> {
  const target = options.symbol?.toUpperCase()
  const symbols = target
    ? [target]
    : deps.allowedSymbols.map((s) => s.toUpperCase())

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

  if (brokerFetchError !== null) {
    for (const sym of symbols) {
      errors.push({ symbol: sym, error: brokerFetchError })
    }
    return summarize(synced, errors, options.dryRun)
  }

  // Gathered before any write so the safe-fail guard below can inspect the
  // whole batch and refuse a destructive zero-out before it happens.
  interface SymbolPlan {
    sym: string
    before: PositionState | null
    brokerQty: number | null
    brokerAvg: number | null
    /** Captured at scan time so we don't refetch in the apply pass. */
    fetchError: string | null
  }
  const plans: SymbolPlan[] = []
  for (const sym of symbols) {
    const brokerPos = brokerByUpper!.get(sym)
    const brokerQty = parseBrokerQty(brokerPos)
    const brokerAvg = parseBrokerAvg(brokerPos)
    try {
      const state = await deps.positionStore.getState(sym)
      plans.push({
        sym,
        before: state.position,
        brokerQty,
        brokerAvg,
        fetchError: null,
      })
    } catch (err) {
      plans.push({
        sym,
        before: null,
        brokerQty,
        brokerAvg,
        fetchError: messageOf(err),
      })
    }
  }

  // `qty>0`, not `position!==null` — a stale `{qty:0}` DO row must not block
  // the guard from letting a genuine zero-out through.
  const hasAnyBrokerQty = plans.some(
    (p) => p.brokerQty !== null && p.brokerQty > 0,
  )
  const doHasAnyPosition = plans.some(
    (p) => p.before !== null && p.before.qty > 0,
  )
  const safeFailTriggered = !hasAnyBrokerQty && doHasAnyPosition

  if (safeFailTriggered && !options.dryRun && !options.force) {
    // One error, not per-symbol noise — the recovery action (investigate or
    // retry with force=true) is the same regardless of how many symbols drifted.
    errors.push({
      symbol: '*',
      error:
        'broker_returned_empty_but_do_has_positions: broker getPositions returned no holdings, but DO has positions. Refusing to zero-out DO. Use ?force=true to override.',
    })
    return summarize(synced, errors, options.dryRun)
  }

  for (const plan of plans) {
    const { sym, before, brokerQty, brokerAvg, fetchError } = plan
    if (fetchError !== null) {
      errors.push({ symbol: sym, error: fetchError })
      continue
    }
    try {
      const doQty = before?.qty ?? 0

      // Webull omits zero-quantity positions rather than returning qty=0,
      // so an absent row must be treated as 0 here.
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
          forced: options.force === true && safeFailTriggered,
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

  const warnings: string[] = []
  if (safeFailTriggered && options.dryRun && !options.force) {
    warnings.push('broker_returned_empty_diff_suspicious')
  }

  return summarize(synced, errors, options.dryRun, warnings)
}

function summarize(
  synced: SyncHoldingResult[],
  errors: SyncHoldingError[],
  dryRun: boolean,
  warnings: string[] = [],
): SyncHoldingsSummary {
  const noDriftCount = synced.filter((r) => r.skipped === 'no_drift').length
  const syncedCount = synced.length - noDriftCount
  const base: SyncHoldingsSummary = {
    synced,
    errors,
    summary: {
      total: synced.length + errors.length,
      synced: syncedCount,
      no_drift: noDriftCount,
      errors: errors.length,
    },
    dryRun,
  }
  return warnings.length > 0 ? { ...base, warnings } : base
}

interface ApplyOverrideArgs {
  positionStore: Pick<PositionStore, 'overridePosition'>
  symbol: string
  before: PositionState | null
  brokerQty: number
  brokerAvg: number | null
  requestId: string | null
}

/** Applies the override and returns the post-state's `position`, via `pickAvgPrice`'s fallback policy. */
async function applyOverride(args: ApplyOverrideArgs): Promise<PositionState | null> {
  const { positionStore, symbol, before, brokerQty, brokerAvg, requestId } = args

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
    // Refuses rather than writing avgPrice=0, which would corrupt
    // recordFill's realized-PnL math.
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
    // Mirrors the live error path: a dryRun preview must not claim it could
    // write avgPrice=0, so it signals "no usable avg" with null instead.
    return null
  }
  return {
    qty: brokerQty,
    avgPrice,
    openedAt: before?.openedAt ?? new Date(0).toISOString(),
  }
}

/** Broker `avg_cost` wins when usable, else the existing DO avgPrice, else `null` — never a synthetic `0` (would corrupt PnL). */
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

// `??` alone would treat an empty-string field as "set" and skip the fallback.
function isEmptyBrokerField(v: unknown): boolean {
  return v === undefined || v === null || v === ''
}

function parseBrokerAvg(pos: WebullPositionDto | undefined): number | null {
  if (pos === undefined) return null
  const raw = !isEmptyBrokerField(pos.cost_price) ? pos.cost_price : pos.avg_cost
  if (isEmptyBrokerField(raw)) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function buildReason(beforeQty: number, afterQty: number): string {
  return `holdings_sync_endpoint: DO qty=${beforeQty} → broker qty=${afterQty}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const _internal = {
  pickAvgPrice,
  parseBrokerQty,
  parseBrokerAvg,
  computePlannedAfter,
}
