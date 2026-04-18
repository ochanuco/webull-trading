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
 * Accumulates realized PnL for the day. Called from TradeEventHandler when a
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
