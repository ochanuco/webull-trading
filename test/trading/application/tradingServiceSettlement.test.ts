import { describe, expect, it } from 'vitest'
import { TradingService, type TradingConfig } from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type SymbolState } from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'

const fixedNow = new Date('2026-04-20T10:00:00.000Z')

const config: TradingConfig = {
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
  quantity: 3,
  buyBelow: 10,
  sellAbove: 20,
}

function makeStore(state: SymbolState): PositionStore {
  return {
    async getState() {
      return state
    },
    async lockPendingOrder() {
      return { ok: true, state }
    },
    async clearPendingOrder() {
      return state
    },
    async recordFill() {
      return state
    },
    async addPendingSettlement() {
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

describe('TradingService settled-cash guard', () => {
  it('rejects a BUY when notional exceeds seeded settledCash', async () => {
    const state: SymbolState = { ...emptySymbolState('SOXL', () => fixedNow), settledCash: 20 }
    const result = await makeService(makeStore(state)).executeTrade(buyInput, config)

    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('insufficient settled cash'))).toBe(true)
    expect(result.executionResult).toBeUndefined()
  })

  it('allows the BUY when settledCash is zero (unseeded / ungated)', async () => {
    const state: SymbolState = emptySymbolState('SOXL', () => fixedNow)
    const result = await makeService(makeStore(state)).executeTrade(buyInput, config)

    expect(result.riskDecision.allowed).toBe(true)
    expect(result.executionResult?.mode).toBe('DRY_RUN')
  })

  it('allows the BUY when settledCash >= notional', async () => {
    const state: SymbolState = { ...emptySymbolState('SOXL', () => fixedNow), settledCash: 100 }
    const result = await makeService(makeStore(state)).executeTrade(buyInput, config)

    expect(result.riskDecision.allowed).toBe(true)
  })
})
