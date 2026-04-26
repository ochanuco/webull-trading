import { DurableObject } from 'cloudflare:workers'
import {
  applyRealizedPnlOnce,
  applyRealizedPnl,
  rollDaily,
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

  async applyRealizedPnlOnce(
    clientOrderId: string,
    delta: number,
  ): Promise<{ state: PortfolioState; applied: boolean }> {
    const state = await this.load()
    const result = applyRealizedPnlOnce(state, clientOrderId, delta, this.transitionCtx)
    if (result.applied) await this.save(result.state)
    return result
  }

  async setTradingDisabledUntil(iso: string | null): Promise<PortfolioState> {
    const state = await this.load()
    const next = setTradingDisabledUntil(state, iso, this.transitionCtx)
    await this.save(next)
    return next
  }

  async rollDaily(): Promise<{ before: PortfolioState; after: PortfolioState }> {
    const state = await this.load()
    const { before, after } = rollDaily(state, this.transitionCtx)
    await this.save(after)
    return { before, after }
  }

  private async load(): Promise<PortfolioState> {
    const stored = await this.ctx.storage.get<PortfolioState>(STATE_KEY)
    if (stored !== undefined) {
      // Backfill `lastRolledAt` for DO instances persisted before issue #140.
      // The field is added forward-compatibly: existing rows missing it read
      // back as `undefined`, which we normalize to `null`. We do not write the
      // backfilled row here — it will be persisted on the next state-mutating
      // call to keep `load()` side-effect free.
      return this.normalize(stored)
    }
    return emptyPortfolioState(this.transitionCtx.now)
  }

  private async save(state: PortfolioState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state)
  }

  private normalize(state: PortfolioState): PortfolioState {
    return {
      ...state,
      appliedClientOrderIds: Array.isArray((state as { appliedClientOrderIds?: unknown }).appliedClientOrderIds)
        ? state.appliedClientOrderIds
        : [],
      lastRolledAt: !('lastRolledAt' in state) || (state as { lastRolledAt?: unknown }).lastRolledAt === undefined
        ? null
        : state.lastRolledAt,
    }
  }
}
