import { DurableObject } from 'cloudflare:workers'
import {
  addPendingSettlement,
  clearPendingOrder,
  lockPendingOrder,
  recordFill,
  recordSignal,
  rollSettlements,
  seedSettledCash,
  setCooldown,
  setQuote,
  type TransitionContext,
} from './stateTransitions'
import {
  emptySymbolState,
  type PendingOrderLock,
  type PendingSettlement,
  type QuoteSnapshot,
  type SymbolState,
} from './types'

const STATE_KEY = 'state'

/**
 * Per-symbol state held in a Durable Object. Instance id must be derived from
 * the symbol (e.g. `SYMBOL_STATE.idFromName(symbol)`) so all reads/writes for
 * the same ticker land on the same object.
 */
export class SymbolStateDO extends DurableObject<object> {
  private readonly transitionCtx: TransitionContext = { now: () => new Date() }

  async getState(symbol: string): Promise<SymbolState> {
    const state = await this.load(symbol)
    // Defensive roll-forward: if asOf day is past any pending settleDate,
    // move those amounts into settledCash immediately.
    const rolled = rollSettlements(state, this.transitionCtx.now().toISOString(), this.transitionCtx)
    if (rolled !== state) {
      await this.save(rolled)
    }
    return rolled
  }

  async lockPendingOrder(
    symbol: string,
    lock: PendingOrderLock,
  ): Promise<{ ok: boolean; state: SymbolState }> {
    const state = await this.load(symbol)
    const result = lockPendingOrder(state, lock, this.transitionCtx)
    if (result.ok) await this.save(result.state)
    return result
  }

  async clearPendingOrder(symbol: string): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = clearPendingOrder(state, this.transitionCtx)
    await this.save(next)
    return next
  }

  async recordFill(
    symbol: string,
    fill: { side: 'BUY' | 'SELL'; qty: number; price: number },
  ): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = recordFill(state, fill, this.transitionCtx)
    await this.save(next)
    return next
  }

  async setCooldown(symbol: string, untilIso: string): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = setCooldown(state, untilIso, this.transitionCtx)
    await this.save(next)
    return next
  }

  async recordSignal(symbol: string): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = recordSignal(state, this.transitionCtx)
    await this.save(next)
    return next
  }

  async setQuote(symbol: string, quote: QuoteSnapshot): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = setQuote(state, quote, this.transitionCtx)
    await this.save(next)
    return next
  }

  async addPendingSettlement(
    symbol: string,
    settlement: PendingSettlement,
  ): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = addPendingSettlement(state, settlement, this.transitionCtx)
    await this.save(next)
    return next
  }

  async seedSettledCash(symbol: string, amount: number): Promise<SymbolState> {
    const state = await this.load(symbol)
    const next = seedSettledCash(state, amount, this.transitionCtx)
    await this.save(next)
    return next
  }

  private async load(symbol: string): Promise<SymbolState> {
    const stored = await this.ctx.storage.get<SymbolState>(STATE_KEY)
    // Check symbol matches; if mismatch, overwrite with correct empty state
    if (stored !== undefined && stored.symbol === symbol) {
      return stored
    }
    // Mismatched or missing: return empty and clear storage
    const empty = emptySymbolState(symbol, this.transitionCtx.now)
    if (stored !== undefined) {
      // Clear mismatched state
      await this.ctx.storage.put(STATE_KEY, empty)
    }
    return empty
  }

  private async save(state: SymbolState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state)
  }
}