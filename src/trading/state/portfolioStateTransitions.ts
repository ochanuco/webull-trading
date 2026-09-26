import type { PortfolioState } from './portfolioTypes'

/**
 * Split from {@link PortfolioStateDO} so these are testable without a
 * Durable Object runtime — mirrors `stateTransitions.ts` for SymbolState.
 */

export interface PortfolioTransitionContext {
  now: () => Date
}

const defaultCtx: PortfolioTransitionContext = { now: () => new Date() }
const MAX_APPLIED_CLIENT_ORDER_IDS = 1000

export function seedDailyStartEquity(
  state: PortfolioState,
  amount: number,
  ctx: PortfolioTransitionContext = defaultCtx,
): PortfolioState {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid seedDailyStartEquity amount: ${amount} (must be a finite number >= 0)`)
  }
  return {
    ...state,
    dailyStartEquity: amount,
    dailyRealizedPnl: 0,
    updatedAt: ctx.now().toISOString(),
  }
}

export function applyRealizedPnl(
  state: PortfolioState,
  delta: number,
  ctx: PortfolioTransitionContext = defaultCtx,
): PortfolioState {
  if (!Number.isFinite(delta)) {
    throw new Error(`Invalid applyRealizedPnl delta: ${delta} (must be a finite number)`)
  }
  return {
    ...state,
    dailyRealizedPnl: state.dailyRealizedPnl + delta,
    updatedAt: ctx.now().toISOString(),
  }
}

export function applyRealizedPnlOnce(
  state: PortfolioState,
  clientOrderId: string,
  delta: number,
  ctx: PortfolioTransitionContext = defaultCtx,
): { state: PortfolioState; applied: boolean } {
  if (clientOrderId.trim().length === 0) {
    throw new Error('Invalid applyRealizedPnlOnce clientOrderId: must be non-empty')
  }
  if (state.appliedClientOrderIds.includes(clientOrderId)) {
    return { state, applied: false }
  }
  const next = applyRealizedPnl(state, delta, ctx)
  return {
    state: {
      ...next,
      appliedClientOrderIds: appendAppliedClientOrderId(state.appliedClientOrderIds, clientOrderId),
    },
    applied: true,
  }
}

/** While the stored timestamp is in the future, TradingService rejects every submit; `null` clears the kill switch. */
export function setTradingDisabledUntil(
  state: PortfolioState,
  iso: string | null,
  ctx: PortfolioTransitionContext = defaultCtx,
): PortfolioState {
  if (iso !== null) {
    const ms = new Date(iso).getTime()
    if (!Number.isFinite(ms)) {
      throw new Error(`Invalid setTradingDisabledUntil iso: ${iso}`)
    }
  }
  return {
    ...state,
    tradingDisabledUntil: iso,
    updatedAt: ctx.now().toISOString(),
  }
}

/**
 * Clamped to >= 0: a SELL running ahead of its BUY (e.g. a seeded position,
 * or a stale fill after `seedOpenExposure` reset the counter) must not push
 * exposure negative.
 */
export function applyFillExposure(
  state: PortfolioState,
  args: { currency: 'USD' | 'JPY'; side: 'BUY' | 'SELL'; notional: number },
  ctx: PortfolioTransitionContext = defaultCtx,
): PortfolioState {
  if (!Number.isFinite(args.notional) || args.notional < 0) {
    throw new Error(
      `Invalid applyFillExposure notional: ${args.notional} (must be a finite number >= 0)`,
    )
  }
  const delta = args.side === 'BUY' ? args.notional : -args.notional
  if (args.currency === 'USD') {
    return {
      ...state,
      openExposureUsd: Math.max(0, state.openExposureUsd + delta),
      updatedAt: ctx.now().toISOString(),
    }
  }
  return {
    ...state,
    openExposureJpy: Math.max(0, state.openExposureJpy + delta),
    updatedAt: ctx.now().toISOString(),
  }
}

/** Operator override via `/admin/portfolio/seed-exposure`; either side can be omitted to leave that counter untouched. */
export function seedOpenExposure(
  state: PortfolioState,
  args: { usd?: number; jpy?: number },
  ctx: PortfolioTransitionContext = defaultCtx,
): PortfolioState {
  const next: PortfolioState = { ...state }
  if (args.usd !== undefined) {
    if (!Number.isFinite(args.usd) || args.usd < 0) {
      throw new Error(`Invalid seedOpenExposure usd: ${args.usd} (must be a finite number >= 0)`)
    }
    next.openExposureUsd = args.usd
  }
  if (args.jpy !== undefined) {
    if (!Number.isFinite(args.jpy) || args.jpy < 0) {
      throw new Error(`Invalid seedOpenExposure jpy: ${args.jpy} (must be a finite number >= 0)`)
    }
    next.openExposureJpy = args.jpy
  }
  next.updatedAt = ctx.now().toISOString()
  return next
}

/** Returns both before/after states atomically, so a concurrent `applyRealizedPnl` can't race the rollover. */
export function rollDaily(
  state: PortfolioState,
  ctx: PortfolioTransitionContext = defaultCtx,
): { before: PortfolioState; after: PortfolioState } {
  const before = state
  const nextStart = state.dailyStartEquity + state.dailyRealizedPnl
  const nowIso = ctx.now().toISOString()
  const after: PortfolioState = {
    ...state,
    dailyStartEquity: nextStart,
    dailyRealizedPnl: 0,
    lastRolledAt: nowIso,
    updatedAt: nowIso,
  }
  return { before, after }
}

function appendAppliedClientOrderId(ids: string[], clientOrderId: string): string[] {
  return [...ids, clientOrderId].slice(-MAX_APPLIED_CLIENT_ORDER_IDS)
}
