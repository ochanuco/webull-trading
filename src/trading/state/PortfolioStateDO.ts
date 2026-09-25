import { DurableObject } from 'cloudflare:workers'
import {
  applyFillExposure,
  applyRealizedPnlOnce,
  applyRealizedPnl,
  rollDaily,
  seedDailyStartEquity,
  seedOpenExposure,
  setTradingDisabledUntil,
  type PortfolioTransitionContext,
} from './portfolioStateTransitions'
import { emptyPortfolioState, type PortfolioState } from './portfolioTypes'

const STATE_KEY = 'portfolio'

/**
 * Callers must address this DO via `idFromName('default')` — unlike
 * {@link SymbolStateDO}, portfolio state has no per-symbol sharding.
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

  async applyFillExposure(args: {
    currency: 'USD' | 'JPY'
    side: 'BUY' | 'SELL'
    notional: number
  }): Promise<PortfolioState> {
    const state = await this.load()
    const next = applyFillExposure(state, args, this.transitionCtx)
    await this.save(next)
    return next
  }

  async seedOpenExposure(args: { usd?: number; jpy?: number }): Promise<PortfolioState> {
    const state = await this.load()
    const next = seedOpenExposure(state, args, this.transitionCtx)
    await this.save(next)
    return next
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
      // Backfilled fields are not written back here, so load() stays free of
      // storage side effects — the normalized value persists on the next
      // state-mutating call instead.
      return this.normalize(stored)
    }
    return emptyPortfolioState(this.transitionCtx.now)
  }

  private async save(state: PortfolioState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state)
  }

  private normalize(state: PortfolioState): PortfolioState {
    const raw = state as {
      appliedClientOrderIds?: unknown
      lastRolledAt?: unknown
      openExposureUsd?: unknown
      openExposureJpy?: unknown
    }
    return {
      ...state,
      appliedClientOrderIds: Array.isArray(raw.appliedClientOrderIds)
        ? state.appliedClientOrderIds
        : [],
      lastRolledAt: !('lastRolledAt' in state) || raw.lastRolledAt === undefined
        ? null
        : state.lastRolledAt,
      // Missing/non-finite reads as 0 rather than requiring an explicit
      // migration of pre-existing rows.
      openExposureUsd:
        typeof raw.openExposureUsd === 'number' && Number.isFinite(raw.openExposureUsd)
          ? raw.openExposureUsd
          : 0,
      openExposureJpy:
        typeof raw.openExposureJpy === 'number' && Number.isFinite(raw.openExposureJpy)
          ? raw.openExposureJpy
          : 0,
    }
  }
}
