export interface PortfolioState {
  /** Account equity captured at the start of the current trading day. */
  dailyStartEquity: number
  /** Cumulative realized PnL since `dailyStartEquity` was seeded. */
  dailyRealizedPnl: number
  /** Client order ids whose realized PnL has already been applied. */
  appliedClientOrderIds: string[]
  /** ISO timestamp until which the kill switch blocks submits, or `null` when inactive. */
  tradingDisabledUntil: string | null
  /** ISO timestamp of the last `rollDaily()`, or `null` if never rolled; used to detect a stale rollover. */
  lastRolledAt: string | null
  /** Currently-open BUY notional in USD across all symbols; read by the portfolio exposure gate. */
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
