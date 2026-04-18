export interface PortfolioState {
  /** Account equity captured at the start of the current trading day. */
  dailyStartEquity: number
  /** Cumulative realized PnL since `dailyStartEquity` was seeded. */
  dailyRealizedPnl: number
  /** ISO timestamp until which the kill switch blocks submits, or `null` when inactive. */
  tradingDisabledUntil: string | null
  updatedAt: string
}

export function emptyPortfolioState(now: () => Date = () => new Date()): PortfolioState {
  return {
    dailyStartEquity: 0,
    dailyRealizedPnl: 0,
    tradingDisabledUntil: null,
    updatedAt: now().toISOString(),
  }
}
