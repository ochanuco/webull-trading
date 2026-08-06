import type {
  PendingOrderLock,
  PendingSettlement,
  PositionState,
  QuoteSnapshot,
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
const MAX_APPLIED_CLIENT_ORDER_IDS = 1000

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
  const iso = ctx.now().toISOString()
  // 保有を閉じた SELL (position が null に落ちた) のときだけ lastExitAt /
  // lastExitPrice を同時に刻む。#reentry の価格ガードが基準にする「前回手仕舞い
  // 価格」と「そこからの経過営業日」を明示フィールドとして永続化する
  // (state.position===null な間 lastExecutedPrice=直近 SELL 価格、という推論には
  // 依存しない。#660)。部分 SELL / BUY では更新しない (position !== null)。
  const closedByExit = fill.side === 'SELL' && position === null
  return {
    ...state,
    position,
    pendingOrder: null,
    lastExecutedPrice: fill.price,
    ...(closedByExit ? { lastExitAt: iso, lastExitPrice: fill.price } : {}),
    updatedAt: iso,
  }
}

export function recordFillOnce(
  state: SymbolState,
  clientOrderId: string,
  fill: { side: 'BUY' | 'SELL'; qty: number; price: number },
  ctx: TransitionContext = defaultCtx,
): { state: SymbolState; applied: boolean } {
  if (clientOrderId.trim().length === 0) {
    throw new Error('Invalid recordFillOnce clientOrderId: must be non-empty')
  }
  if (state.appliedClientOrderIds.includes(clientOrderId)) {
    return { state, applied: false }
  }
  const next = recordFill(state, fill, ctx)
  return {
    state: {
      ...next,
      appliedClientOrderIds: appendAppliedClientOrderId(state.appliedClientOrderIds, clientOrderId),
    },
    applied: true,
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

export function setQuote(
  state: SymbolState,
  quote: QuoteSnapshot,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  // Validate quote.price before accepting it (fail-closed)
  if (!Number.isFinite(quote.price) || quote.price <= 0) {
    throw new Error(`Invalid quote.price: ${quote.price} (must be a finite number > 0)`)
  }
  return { ...state, lastQuote: quote, updatedAt: ctx.now().toISOString() }
}

export function isQuoteStale(
  quote: QuoteSnapshot | null,
  asOfIso: string,
  maxAgeMs: number,
): boolean {
  if (!quote) return true
  const diffMs = new Date(asOfIso).getTime() - new Date(quote.fetchedAt).getTime()
  return !Number.isFinite(diffMs) || diffMs <= 0 || diffMs > maxAgeMs
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
 * Operator-driven position override. Used to manually reconcile a corrupted
 * `position` against the real broker holding (e.g. after a reconcile-race
 * double-apply that drifted DO qty above broker truth). Not part of the
 * regular BUY/SELL fill flow — `recordFill` should be the only writer for
 * organic state changes.
 *
 *   - `qty <= 0` (or null caller intent) → close the position entirely.
 *     Internally accepted only when the operator explicitly opts in via
 *     `qty=0` so we never silently swallow a typo as "close".
 *   - `qty > 0` → write `{ qty, avgPrice, openedAt: openedAt ?? now() }`.
 *
 * Fail-closed on bad inputs (NaN / negative / zero avgPrice when qty>0)
 * because operators paste these values from a CLI; rejecting upfront avoids
 * a malformed position propagating into the strategy loop.
 *
 * `lastExitPrice` / `lastExitAt` / `lastExecutedPrice` are **intentionally
 * left untouched** here — an override via sync-holdings (broker-side
 * liquidation, manual lot reconciliation) must not contaminate the
 * re-entry guard's reference price by fabricating an exit that never
 * happened through `recordFill` (#660).
 */
export function overridePosition(
  state: SymbolState,
  args: { qty: number; avgPrice: number; openedAt: string | null },
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  if (!Number.isFinite(args.qty) || args.qty < 0) {
    throw new Error(
      `overridePosition: invalid qty=${args.qty} (must be a finite number >= 0)`,
    )
  }
  const iso = ctx.now().toISOString()
  if (args.qty === 0) {
    // Operator-explicit close. avgPrice / openedAt are ignored on close so a
    // mistyped price field doesn't accidentally seed a fresh position.
    return { ...state, position: null, updatedAt: iso }
  }
  if (!Number.isFinite(args.avgPrice) || args.avgPrice <= 0) {
    throw new Error(
      `overridePosition: invalid avgPrice=${args.avgPrice} (must be a finite number > 0 when qty>0)`,
    )
  }
  if (args.openedAt !== null) {
    const t = new Date(args.openedAt).getTime()
    if (!Number.isFinite(t)) {
      throw new Error(
        `overridePosition: invalid openedAt=${args.openedAt} (must be ISO 8601 timestamp or null)`,
      )
    }
  }
  return {
    ...state,
    position: {
      qty: args.qty,
      avgPrice: args.avgPrice,
      openedAt: args.openedAt ?? iso,
    },
    updatedAt: iso,
  }
}

/**
 * Overwrites `settledCash` with an operator-provided value. POC seed path —
 * used once during initial setup or after a manual reconciliation with the
 * broker. Not part of the regular fill/roll flow.
 */
export function seedSettledCash(
  state: SymbolState,
  amount: number,
  ctx: TransitionContext = defaultCtx,
): SymbolState {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid seedSettledCash amount: ${amount} (must be a finite number >= 0)`)
  }
  return { ...state, settledCash: amount, updatedAt: ctx.now().toISOString() }
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

function appendAppliedClientOrderId(ids: string[], clientOrderId: string): string[] {
  return [...ids, clientOrderId].slice(-MAX_APPLIED_CLIENT_ORDER_IDS)
}

function isExpired(expiresAtIso: string, now: () => Date): boolean {
  return new Date(expiresAtIso).getTime() <= now().getTime()
}
