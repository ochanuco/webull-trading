import type { PortfolioState } from './portfolioTypes'

/**
 * Pure state transitions for {@link PortfolioStateDO}. Split from the DO class
 * so they are testable without a Durable Object runtime, mirroring the shape of
 * `stateTransitions.ts` for SymbolState.
 */

export interface PortfolioTransitionContext {
  now: () => Date
}

const defaultCtx: PortfolioTransitionContext = { now: () => new Date() }
const MAX_APPLIED_CLIENT_ORDER_IDS = 1000

/**
 * Overwrites `dailyStartEquity` with an operator- or EOD-cron-provided value
 * and resets `dailyRealizedPnl` back to 0. Called once per trading day.
 */
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

/**
 * Accumulates realized PnL for the day. Called from reconcileFills when a
 * SELL closes (or partially closes) a position.
 */
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

/**
 * Arms the kill switch by storing an ISO timestamp. While `tradingDisabledUntil`
 * is in the future, TradingService rejects every submit. Pass `null` to clear.
 */
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
 * BUY fill: add notional to the currency-specific openExposure. SELL fill:
 * subtract, but clamp to >= 0 so we never go negative even if a SELL runs
 * ahead of its BUY (e.g. position seeded out-of-band, or a stale fill
 * arrives after `seedOpenExposure` reset the counter).
 *
 * Pure: returns a new state. The portfolio exposure gate (#77) reads
 * `openExposure{Usd,Jpy}` and compares against `total_capital_* *
 * max_portfolio_exposure_pct`.
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

/**
 * Operator override: snap one or both `openExposure*` counters to a known
 * baseline. Used by `/admin/portfolio/seed-exposure` to reset after an
 * out-of-band position rebuild. Either side can be omitted to leave that
 * currency's counter untouched.
 */
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

/**
 * EOD rollover: computes `nextStart = dailyStartEquity + dailyRealizedPnl`,
 * resets `dailyRealizedPnl` to 0, and returns both the before and after states.
 * This is the atomic version that prevents races with `applyRealizedPnl`.
 */
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
