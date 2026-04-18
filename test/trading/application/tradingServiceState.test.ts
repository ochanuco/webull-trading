import { describe, expect, it, vi } from 'vitest'
import { TradingService, type TradingConfig } from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type PendingOrderLock, type SymbolState } from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'

const fixedNow = new Date('2026-04-18T10:00:00.000Z')

const baseConfig: TradingConfig = {
  dryRun: true,
  tradingEnabled: true,
  allowedSymbols: ['SOXL'],
  maxOrderNotional: 1_000,
  symbolMaxNotional: {},
  marketHoursCheck: false,
}

const buyInput = {
  symbol: 'SOXL',
  price: 9,
  quantity: 2,
  buyBelow: 10,
  sellAbove: 20,
}

function makeStore(initial?: SymbolState): PositionStore & { state: SymbolState; calls: string[] } {
  let state = initial ?? emptySymbolState('SOXL', () => fixedNow)
  const calls: string[] = []
  return {
    get state() {
      return state
    },
    calls,
    async getState() {
      calls.push('getState')
      return state
    },
    async lockPendingOrder(_symbol: string, lock: PendingOrderLock) {
      calls.push('lockPendingOrder')
      if (state.pendingOrder && new Date(state.pendingOrder.expiresAt).getTime() > fixedNow.getTime()) {
        return { ok: false, state }
      }
      state = { ...state, pendingOrder: lock }
      return { ok: true, state }
    },
    async clearPendingOrder() {
      calls.push('clearPendingOrder')
      state = { ...state, pendingOrder: null }
      return state
    },
    async recordFill() {
      calls.push('recordFill')
      return state
    },
    async addPendingSettlement() {
      calls.push('addPendingSettlement')
      return state
    },
    async setCooldown() {
      calls.push('setCooldown')
      return state
    },
    async seedSettledCash() {
      calls.push('seedSettledCash')
      return state
    },
  }
}

function makeService(store: PositionStore) {
  return new TradingService(
    new FixedRuleStrategy(buyInput.buyBelow, buyInput.sellAbove),
    new DefaultRiskPolicy(),
    new MockExecution(),
    { positionStore: store, now: () => fixedNow },
  )
}

describe('TradingService state gate', () => {
  it('blocks the trade when cooldownUntil is in the future', async () => {
    const future = new Date(fixedNow.getTime() + 60_000).toISOString()
    const store = makeStore({ ...emptySymbolState('SOXL', () => fixedNow), cooldownUntil: future })
    const result = await makeService(store).executeTrade(buyInput, baseConfig)

    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('cooldown'))).toBe(true)
    expect(result.executionResult).toBeUndefined()
    expect(store.calls).toEqual(['getState'])
  })

  it('blocks the trade when a pending order is already in flight', async () => {
    const lock: PendingOrderLock = {
      clientOrderId: 'existing-lock',
      side: 'BUY',
      submittedAt: fixedNow.toISOString(),
      expiresAt: new Date(fixedNow.getTime() + 60_000).toISOString(),
    }
    const store = makeStore({ ...emptySymbolState('SOXL', () => fixedNow), pendingOrder: lock })
    const result = await makeService(store).executeTrade(buyInput, baseConfig)

    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('pending order'))).toBe(true)
    expect(result.executionResult).toBeUndefined()
  })

  it('lock-then-clear on successful DRY_RUN execution so the next tick can fire', async () => {
    const store = makeStore()
    const result = await makeService(store).executeTrade(buyInput, baseConfig)

    expect(result.executionResult?.mode).toBe('DRY_RUN')
    expect(store.calls).toContain('lockPendingOrder')
    expect(store.calls).toContain('clearPendingOrder')
    expect(store.state.pendingOrder).toBeNull()
  })

  it('clears the lock when execution throws so state does not wedge', async () => {
    const store = makeStore()
    const throwingExecution = {
      execute: vi.fn(async () => {
        throw new Error('broker down')
      }),
    }
    const service = new TradingService(
      new FixedRuleStrategy(buyInput.buyBelow, buyInput.sellAbove),
      new DefaultRiskPolicy(),
      throwingExecution,
      { positionStore: store, now: () => fixedNow },
    )

    await expect(service.executeTrade(buyInput, baseConfig)).rejects.toThrow('broker down')
    expect(store.calls).toContain('clearPendingOrder')
    expect(store.state.pendingOrder).toBeNull()
  })
})
