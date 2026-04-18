import { describe, expect, it } from 'vitest'
import { TradingService, type TradingConfig } from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type SymbolState } from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'

const now = new Date('2026-04-21T14:30:00.000Z')

const config: TradingConfig = {
  dryRun: true,
  tradingEnabled: true,
  allowedSymbols: ['SOXL', 'SOXS'],
  maxOrderNotional: 10_000,
  symbolMaxNotional: {},
  marketHoursCheck: false,
}

const buySoxl = { symbol: 'SOXL', price: 9, quantity: 2, buyBelow: 10, sellAbove: 20 }

function makeStore(statesBySymbol: Record<string, SymbolState>): PositionStore {
  return {
    async getState(symbol) {
      return statesBySymbol[symbol.toUpperCase()] ?? emptySymbolState(symbol, () => now)
    },
    async lockPendingOrder(_symbol, _lock) {
      return { ok: true, state: emptySymbolState('_', () => now) }
    },
    async clearPendingOrder(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async recordFill(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async addPendingSettlement(symbol) {
      return emptySymbolState(symbol, () => now)
    },
    async setCooldown(symbol) {
      return emptySymbolState(symbol, () => now)
    },
  }
}

function service(store: PositionStore, inversePairs: Record<string, string>) {
  return new TradingService(
    new FixedRuleStrategy(buySoxl.buyBelow, buySoxl.sellAbove),
    new DefaultRiskPolicy(),
    new MockExecution(),
    { positionStore: store, inversePairs, now: () => now },
  )
}

describe('TradingService inverse-pair correlation cap', () => {
  it('rejects BUY SOXL when SOXS has an open position', async () => {
    const store = makeStore({
      SOXS: {
        ...emptySymbolState('SOXS', () => now),
        position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
      },
    })
    const result = await service(store, { SOXL: 'SOXS', SOXS: 'SOXL' }).executeTrade(buySoxl, config)

    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('inverse-pair'))).toBe(true)
    expect(result.executionResult).toBeUndefined()
  })

  it('allows BUY SOXL when SOXS is flat', async () => {
    const store = makeStore({})
    const result = await service(store, { SOXL: 'SOXS', SOXS: 'SOXL' }).executeTrade(buySoxl, config)
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('allows BUY SOXL when no inverse-pair map is configured', async () => {
    const store = makeStore({
      SOXS: {
        ...emptySymbolState('SOXS', () => now),
        position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
      },
    })
    const result = await service(store, {}).executeTrade(buySoxl, config)
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('does not gate a SELL against the inverse leg', async () => {
    const sellInput = { symbol: 'SOXL', price: 25, quantity: 2, buyBelow: 10, sellAbove: 20 }
    const store = makeStore({
      SOXS: {
        ...emptySymbolState('SOXS', () => now),
        position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
      },
    })
    const result = await service(store, { SOXL: 'SOXS', SOXS: 'SOXL' }).executeTrade(sellInput, config)
    // SELL signals with no position still fail at RiskPolicy for DefaultRiskPolicy,
    // but the reason must NOT be the inverse-pair correlation reason.
    expect(result.riskDecision.reasons.some((r) => r.includes('inverse-pair'))).toBe(false)
  })
})
