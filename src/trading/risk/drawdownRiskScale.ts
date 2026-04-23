import type { PortfolioState } from '../state/portfolioTypes'

/** Default base risk fraction per trade. Matches pullbackSizing default. */
export const BASE_RISK_PER_TRADE_PCT = 0.004

/**
 * Thresholds for daily drawdown → risk scaling. Keyed on `realizedPnl /
 * dailyStartEquity` (negative values = drawdown).
 *
 *   dd >= -0.05  → scale 1.0 (normal operation)
 *   dd >= -0.10  → scale 0.5 (losing half-day, halve exposure)
 *   dd <  -0.10  → scale 0.0 (kill for the day — drawdown_kill pre-flight
 *                             already covers the -2% floor case; this is
 *                             the belt-and-suspenders step above that)
 *
 * Intentionally 3-level step rather than continuous — step is robust to
 * intraday noise (one bad tick won't shift size continuously) and obvious
 * to the operator when inspecting logs.
 */
export interface DrawdownScaleResult {
  scale: number
  drawdown: number
  /** Human-readable step label for journalling / logs. */
  step: 'normal' | 'half' | 'halt'
}

/**
 * Compute the risk-scale factor from the current portfolio snapshot. Pure
 * function — no DO call, testable in isolation.
 *
 * `drawdown` is clipped at 0 from above so an intraday up-move doesn't
 * produce a positive "drawdown". When `dailyStartEquity <= 0` (uninitialized
 * portfolio), returns scale 1.0 with drawdown 0 — fail-open because the
 * broader drawdown_kill path in runStrategyCron already refuses to
 * evaluate that case.
 */
export function computeDrawdownRiskScale(portfolio: Pick<PortfolioState, 'dailyStartEquity' | 'dailyRealizedPnl'>): DrawdownScaleResult {
  if (
    !Number.isFinite(portfolio.dailyStartEquity) ||
    portfolio.dailyStartEquity <= 0 ||
    !Number.isFinite(portfolio.dailyRealizedPnl)
  ) {
    return { scale: 1, drawdown: 0, step: 'normal' }
  }
  const raw = portfolio.dailyRealizedPnl / portfolio.dailyStartEquity
  const drawdown = raw < 0 ? raw : 0
  if (drawdown >= -0.05) {
    return { scale: 1, drawdown, step: 'normal' }
  }
  if (drawdown >= -0.10) {
    return { scale: 0.5, drawdown, step: 'half' }
  }
  return { scale: 0, drawdown, step: 'halt' }
}
