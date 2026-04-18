import type {
  PendingOrderLock,
  PendingSettlement,
  PositionState,
  SymbolState,
} from './types'

/**
 * Pure state transitions applied by {@link SymbolStateDO}. Exposed separately
 * so they are testable without a Durable Object runtime. Every function takes
 * the current state and returns a new state — no mutation, no I/O.
 */

export interface TransitionContext {
  now: () => Date
}

const defaultCtx: TransitionContext = { now: () => new Date() }

export function lockPendingOrder(
  state: SymbolState,
  lock: PendingOrderLock,
  ctx: TransitionContext = defaultCtx,
): { ok: boolean; state: SymbolState } {
  // Validate lock.expiresAt before accepting the lock (fail-closed)
  const lockExpiresAtMs = new Date(lock.expiresAt).getTime()
  if (!Number.isFinite(lockExpiresAtMs)) {
    // Invalid expiresAt (NaN) - reject the lock
    return { ok: false, state }
  }

  if (state.pendingOrder !== null && !isExpired(state.pendingOrder.expiresAt, ctx.now)) {
    return { ok: false, state }
  }
  return {
    ok: true,
    state: { ...state, pendingOrder: lock, updatedAt: ctx.now().toISOString() },
  }
}

export function clearPendingOrder(
  state: SymbolState,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  return { ...state, pendingOrder: null, updatedAt: ctx.now().toISOString() }
}

export function recordFill(
  state: SymbolState,
  fill: { side: 'BUY' | 'SELL'; qty: number; price: number },
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  // Validate fill inputs before applying
  if (!Number.isFinite(fill.qty) || fill.qty <= 0) {
    throw new Error(`Invalid fill.qty: ${fill.qty} (must be a finite number > 0)`)
  }
  if (!Number.isFinite(fill.price) || fill.price <= 0) {
    throw new Error(`Invalid fill.price: ${fill.price} (must be a finite number > 0)`)
  }

  const position = applyFillToPosition(state.position, fill, ctx.now)
  return {
    ...state,
    position,
    pendingOrder: null,
    lastExecutedPrice: fill.price,
    updatedAt: ctx.now().toISOString(),
  }
}

export function setCooldown(
  state: SymbolState,
  untilIso: string,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  return { ...state, cooldownUntil: untilIso, updatedAt: ctx.now().toISOString() }
}

export function recordSignal(
  state: SymbolState,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  const iso = ctx.now().toISOString()
  return { ...state, lastSignalAt: iso, updatedAt: iso }
}

export function addPendingSettlement(
  state: SymbolState,
  settlement: PendingSettlement,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  // Validate settlement inputs before adding
  if (!Number.isFinite(settlement.amount) || settlement.amount <= 0) {
    throw new Error(`Invalid settlement.amount: ${settlement.amount} (must be a finite number > 0)`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settlement.settleDate)) {
    throw new Error(`Invalid settlement.settleDate: ${settlement.settleDate} (must match YYYY-MM-DD pattern)`)
  }
  return {
    ...state,
    pendingSettlement: [...state.pendingSettlement, settlement],
    updatedAt: ctx.now().toISOString(),
  }
}

/**
 * Any pendingSettlement whose settleDate is on or before `asOf` moves its
 * amount into `settledCash` and is removed from the queue. Used both
 * proactively (T+1 EOD roll) and defensively on read.
 */
export function rollSettlements(
  state: SymbolState,
  asOfIso: string,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  const asOfDay = asOfIso.slice(0, 10)
  let settledCash = state.settledCash
  const remaining: PendingSettlement[] = []
  for (const s of state.pendingSettlement) {
    if (s.settleDate <= asOfDay) {
      settledCash += s.amount
    } else {
      remaining.push(s)
    }
  }
  if (remaining.length === state.pendingSettlement.length) {
    return state
  }
  return {
    ...state,
    settledCash,
    pendingSettlement: remaining,
    updatedAt: ctx.now().toISOString(),
  }
}

function applyFillToPosition(
  position: PositionState | null,
  fill: { side: 'BUY' | 'SELL'; qty: number; price: number },
  now: () => Date,
): PositionState | null {
  if (fill.side === 'BUY') {
    if (position === null) {
      return { qty: fill.qty, avgPrice: fill.price, openedAt: now().toISOString() }
    }
    const totalQty = position.qty + fill.qty
    if (totalQty <= 0) return null
    const avgPrice = (position.qty * position.avgPrice + fill.qty * fill.price) / totalQty
    return { qty: totalQty, avgPrice, openedAt: position.openedAt }
  }
  // SELL
  if (position === null) {
    throw new Error('Cannot SELL without an open position (short not supported)')
  }
  const remaining = position.qty - fill.qty
  if (remaining < 0) {
    throw new Error(`SELL overfill: position.qty=${position.qty}, fill.qty=${fill.qty}`)
  }
  if (remaining === 0) return null
  return { ...position, qty: remaining }
}

function isExpired(expiresAtIso: string, now: () => Date): boolean {
  return new Date(expiresAtIso).getTime() <= now().getTime()
}