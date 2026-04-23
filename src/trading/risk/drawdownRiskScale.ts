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

/**
 * Compute the risk-scale factor from the current portfolio snapshot given
 * caller-provided thresholds (loaded from D1 global_config). Pure function.
 *
 *   dd >= halfThreshold → scale 1.0 (normal)
 *   dd >= haltThreshold → scale 0.5 (half)
 *   dd <  haltThreshold → scale 0.0 (halt)
 *
 * `drawdown` is clipped at 0 from above so an intraday up-move does not
 * yield a positive "drawdown". When `dailyStartEquity <= 0` (uninitialized
 * portfolio) we **fail-closed** with scale 0 / step 'halt' — the caller
 * can reject rather than silently trade at full size.
 *
 * Invalid params (non-finite, or halt > half, or non-negative halt) throw
 * — caller must pass coherent thresholds. No silent clamping.
 */
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
  // Fail-closed: if portfolio snapshot is invalid / uninitialized, we cannot
  // evaluate drawdown and must not silently pass full-size trades. Return
  // halt so Risk can reject. (CodeRabbit #125 review: "Risk must be able to
  // reject".)
  if (
    !Number.isFinite(portfolio.dailyStartEquity) ||
    portfolio.dailyStartEquity <= 0 ||
    !Number.isFinite(portfolio.dailyRealizedPnl)
  ) {
    return { scale: 0, drawdown: 0, step: 'halt' }
  }
  const raw = portfolio.dailyRealizedPnl / portfolio.dailyStartEquity
  const drawdown = raw < 0 ? raw : 0
  if (drawdown >= params.halfThreshold) {
    return { scale: 1, drawdown, step: 'normal' }
  }
  if (drawdown >= params.haltThreshold) {
    return { scale: 0.5, drawdown, step: 'half' }
  }
  return { scale: 0, drawdown, step: 'halt' }
}
