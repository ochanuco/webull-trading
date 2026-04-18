import { DurableObject } from 'cloudflare:workers'
import {
  applyRealizedPnl,
  seedDailyStartEquity,
  setTradingDisabledUntil,
  type PortfolioTransitionContext,
} from './portfolioStateTransitions'
import { emptyPortfolioState, type PortfolioState } from './portfolioTypes'

const STATE_KEY = 'portfolio'

/**
 * Account-level (singleton) state held in a Durable Object. Use a fixed id
 * (e.g. `PORTFOLIO_STATE.idFromName('default')`) so every caller lands on the
 * same instance — there is no per-symbol sharding here.
 */
export class PortfolioStateDO extends DurableObject<object> {
  private readonly transitionCtx: PortfolioTransitionContext = { now: () => new Date() }

  async getPortfolio(): Promise<PortfolioState> {
    return this.load()
  }

  async seedDailyStartEquity(amount: number): Promise<PortfolioState> {
    const state = await this.load()
    const next = seedDailyStartEquity(state, amount, this.transitionCtx)
    await this.save(next)
    return next
  }

  async applyRealizedPnl(delta: number): Promise<PortfolioState> {
    const state = await this.load()
    const next = applyRealizedPnl(state, delta, this.transitionCtx)
    await this.save(next)
    return next
  }

  async setTradingDisabledUntil(iso: string | null): Promise<PortfolioState> {
    const state = await this.load()
    const next = setTradingDisabledUntil(state, iso, this.transitionCtx)
    await this.save(next)
    return next
  }

  private async load(): Promise<PortfolioState> {
    const stored = await this.ctx.storage.get<PortfolioState>(STATE_KEY)
    if (stored !== undefined) {
      return stored
    }
    return emptyPortfolioState(this.transitionCtx.now)
  }

  private async save(state: PortfolioState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state)
  }
}
