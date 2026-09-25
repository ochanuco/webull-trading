import type { PortfolioState } from '../state/portfolioTypes'

export interface DrawdownRiskScaleParams {
  /** Base risk fraction per trade (e.g. 0.004 = 0.4%). */
  baseRiskPct: number
  /** Drawdown threshold to enter "half" scale (e.g. -0.05). */
  halfThreshold: number
  /** Drawdown threshold to enter "halt" scale (e.g. -0.10). */
  haltThreshold: number
}

export interface DrawdownScaleResult {
  scale: number
  drawdown: number
  /** Human-readable step label for journalling / logs. */
  step: 'normal' | 'half' | 'halt'
}

export function computeDrawdownRiskScale(
  portfolio: Pick<PortfolioState, 'dailyStartEquity' | 'dailyRealizedPnl'>,
  params: DrawdownRiskScaleParams,
): DrawdownScaleResult {
  if (!Number.isFinite(params.baseRiskPct) || params.baseRiskPct <= 0) {
    throw new Error(`computeDrawdownRiskScale: baseRiskPct must be a positive finite number, got ${params.baseRiskPct}`)
  }
  if (!Number.isFinite(params.halfThreshold) || params.halfThreshold >= 0) {
    throw new Error(`computeDrawdownRiskScale: halfThreshold must be a negative finite number, got ${params.halfThreshold}`)
  }
  if (!Number.isFinite(params.haltThreshold) || params.haltThreshold >= 0) {
    throw new Error(`computeDrawdownRiskScale: haltThreshold must be a negative finite number, got ${params.haltThreshold}`)
  }
  if (params.haltThreshold > params.halfThreshold) {
    throw new Error(`computeDrawdownRiskScale: haltThreshold (${params.haltThreshold}) must be <= halfThreshold (${params.halfThreshold})`)
  }
  // Fail-closed: an invalid/uninitialized snapshot halts instead of
  // defaulting to normal, so Risk rejects rather than trading full size.
  if (
    !Number.isFinite(portfolio.dailyStartEquity) ||
    portfolio.dailyStartEquity <= 0 ||
    !Number.isFinite(portfolio.dailyRealizedPnl)
  ) {
    return { scale: 0, drawdown: 0, step: 'halt' }
  }
  const dailyReturn = portfolio.dailyRealizedPnl / portfolio.dailyStartEquity
  const drawdown = dailyReturn < 0 ? dailyReturn : 0
  if (drawdown >= params.halfThreshold) {
    return { scale: 1, drawdown, step: 'normal' }
  }
  if (drawdown >= params.haltThreshold) {
    return { scale: 0.5, drawdown, step: 'half' }
  }
  return { scale: 0, drawdown, step: 'halt' }
}
