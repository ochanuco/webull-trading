import type { PortfolioState } from './portfolioTypes'

/**
 * The subset of {@link PortfolioStateDO} that TradingService and
 * reconcileFills need. Kept independent from {@link PositionStore} on
 * purpose — portfolio-level state is not per-symbol.
 */
export interface PortfolioStore {
  getPortfolio(): Promise<PortfolioState>
  seedDailyStartEquity(amount: number): Promise<PortfolioState>
  applyRealizedPnl(delta: number): Promise<PortfolioState>
  setTradingDisabledUntil(iso: string | null): Promise<PortfolioState>
  rollDaily(): Promise<{ before: PortfolioState; after: PortfolioState }>
  /**
   * Mutate `openExposure{Usd,Jpy}` from a terminal fill. BUY adds notional,
   * SELL subtracts (clamped >= 0). Called by reconcileFills after the
   * realized-pnl path; read by the portfolio exposure gate (#77).
   */
  applyFillExposure(args: {
    currency: 'USD' | 'JPY'
    side: 'BUY' | 'SELL'
    notional: number
  }): Promise<PortfolioState>
  /**
   * Operator override for `openExposure{Usd,Jpy}` — used by
   * `/admin/portfolio/seed-exposure` to snap to a known baseline after a
   * holdings rebuild. Either side can be omitted.
   */
  seedOpenExposure(args: { usd?: number; jpy?: number }): Promise<PortfolioState>
}
