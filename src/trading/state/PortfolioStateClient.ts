import type { PortfolioStateDO } from './PortfolioStateDO'
import type { PortfolioStore } from './PortfolioStore'
import type { PortfolioState } from './portfolioTypes'

const SINGLETON_NAME = 'default'

/**
 * Thin adapter from {@link DurableObjectNamespace} to {@link PortfolioStore}.
 * Always routes to a single DO instance (`idFromName('default')`) because
 * portfolio state is account-wide.
 */
export class PortfolioStateClient implements PortfolioStore {
  constructor(private readonly namespace: DurableObjectNamespace<PortfolioStateDO>) {}

  private stub(): DurableObjectStub<PortfolioStateDO> {
    return this.namespace.get(this.namespace.idFromName(SINGLETON_NAME))
  }

  getPortfolio(): Promise<PortfolioState> {
    return this.stub().getPortfolio()
  }

  seedDailyStartEquity(amount: number): Promise<PortfolioState> {
    return this.stub().seedDailyStartEquity(amount)
  }

  applyRealizedPnl(delta: number): Promise<PortfolioState> {
    return this.stub().applyRealizedPnl(delta)
  }

  setTradingDisabledUntil(iso: string | null): Promise<PortfolioState> {
    return this.stub().setTradingDisabledUntil(iso)
  }
}
