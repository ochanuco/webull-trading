import type { PortfolioState } from './portfolioTypes'

/**
 * Kept separate from {@link PositionStore}: portfolio state is account-wide,
 * not per-symbol, so merging the two would force every symbol-scoped caller
 * to also depend on the account-wide DO.
 */
export interface PortfolioStore {
  getPortfolio(): Promise<PortfolioState>
  seedDailyStartEquity(amount: number): Promise<PortfolioState>
  applyRealizedPnl(delta: number): Promise<PortfolioState>
  setTradingDisabledUntil(iso: string | null): Promise<PortfolioState>
  rollDaily(): Promise<{ before: PortfolioState; after: PortfolioState }>
  /** Mutates `openExposure{Usd,Jpy}`; see `portfolioStateTransitions.applyFillExposure` for the BUY/SELL/clamp rule. */
  applyFillExposure(args: {
    currency: 'USD' | 'JPY'
    side: 'BUY' | 'SELL'
    notional: number
  }): Promise<PortfolioState>
  /** Operator override used by `/admin/portfolio/seed-exposure` to reset a baseline; either side can be omitted. */
  seedOpenExposure(args: { usd?: number; jpy?: number }): Promise<PortfolioState>
}
