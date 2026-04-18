import type { PortfolioState } from './portfolioTypes'

/**
 * The subset of {@link PortfolioStateDO} that TradingService and
 * TradeEventHandler need. Kept independent from {@link PositionStore} on
 * purpose — portfolio-level state is not per-symbol.
 */
export interface PortfolioStore {
  getPortfolio(): Promise<PortfolioState>
  seedDailyStartEquity(amount: number): Promise<PortfolioState>
  applyRealizedPnl(delta: number): Promise<PortfolioState>
  setTradingDisabledUntil(iso: string | null): Promise<PortfolioState>
}
