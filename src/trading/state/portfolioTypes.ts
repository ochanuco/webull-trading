export interface PortfolioState {
  /** Account equity captured at the start of the current trading day. */
  dailyStartEquity: number
  /** Cumulative realized PnL since `dailyStartEquity` was seeded. */
  dailyRealizedPnl: number
  /** Client order ids whose realized PnL has already been applied. */
  appliedClientOrderIds: string[]
  /** ISO timestamp until which the kill switch blocks submits, or `null` when inactive. */
  tradingDisabledUntil: string | null
  /**
   * ISO timestamp of the last `rollDaily()` execution, or `null` when the
   * portfolio has never been rolled. Used by the EOD auto-rollover cron and
   * the runStrategyCron pre-flight to detect stale rollovers (issue #140).
   */
  lastRolledAt: string | null
  /**
   * Currently-open BUY notional in USD across all symbols. BUY fills add to
   * this, SELL fills subtract. Clamped to >= 0 to avoid drift when SELLs
   * run ahead of their BUYs (e.g. seeded position). Read by the portfolio
   * exposure gate against `global_config.total_capital_usd *
   * max_portfolio_exposure_pct` (#77).
   */
  openExposureUsd: number
  /** JPY counterpart of {@link openExposureUsd}. Independent budget. */
  openExposureJpy: number
  updatedAt: string
}

export function emptyPortfolioState(now: () => Date = () => new Date()): PortfolioState {
  return {
    dailyStartEquity: 0,
    dailyRealizedPnl: 0,
    appliedClientOrderIds: [],
    tradingDisabledUntil: null,
    lastRolledAt: null,
    openExposureUsd: 0,
    openExposureJpy: 0,
    updatedAt: now().toISOString(),
  }
}
