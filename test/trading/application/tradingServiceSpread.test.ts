import { describe, expect, it } from 'vitest'
import { TradingService, type TradingConfig } from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import {
  emptySymbolState,
  type QuoteSnapshot,
  type SymbolState,
} from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'

const now = new Date('2026-04-21T14:30:00.000Z')

const baseConfig: TradingConfig = {
  dryRun: true,
  tradingEnabled: true,
  allowedSymbols: ['SPY', '7203'],
  maxOrderNotional: 100_000,
  symbolMaxNotional: {},
  marketHoursCheck: false,
}

function buy(symbol: string): { symbol: string; price: number; quantity: number; buyBelow: number; sellAbove: number } {
  return { symbol, price: 100, quantity: 1, buyBelow: 150, sellAbove: 200 }
}

function quote(bid: number | undefined, ask: number | undefined): QuoteSnapshot {
  return {
    price: 100,
    asOf: now.toISOString(),
    fetchedAt: now.toISOString(),
    source: 'test',
    bid,
    ask,
  }
}

function makeStore(stateBySymbol: Record<string, SymbolState>): PositionStore {
  return {
    async getState(symbol) {
      return stateBySymbol[symbol.toUpperCase()] ?? emptySymbolState(symbol, () => now)
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
    async seedSettledCash(symbol) {
      return emptySymbolState(symbol, () => now)
    },
  }
}

function service(store: PositionStore, overrides: { US?: number; JP?: number } = {}) {
  return new TradingService(
    new FixedRuleStrategy(150, 200),
    new DefaultRiskPolicy(),
    new MockExecution(),
    {
      positionStore: store,
      spreadLimits: {
        US: overrides.US ?? 0.0025,
        JP: overrides.JP ?? 0.006,
      },
      now: () => now,
    },
  )
}

describe('TradingService spread guard (#38-D)', () => {
  it('rejects BUY for US liquid name when spread is 0.3% (above 0.25% limit)', async () => {
    // 99.85 / 100.15 -> mid 100, spread 0.3 / 100 = 0.003
    const store = makeStore({
      SPY: { ...emptySymbolState('SPY', () => now), lastQuote: quote(99.85, 100.15) },
    })
    const result = await service(store).executeTrade(buy('SPY'), baseConfig)
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('spread'))).toBe(true)
    expect(result.executionResult).toBeUndefined()
  })

  it('allows BUY for US liquid name when spread is 0.2% (within 0.25% limit)', async () => {
    // 99.9 / 100.1 -> pct 0.002
    const store = makeStore({
      SPY: { ...emptySymbolState('SPY', () => now), lastQuote: quote(99.9, 100.1) },
    })
    const result = await service(store).executeTrade(buy('SPY'), baseConfig)
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('rejects BUY for JP name when spread is 0.7% (above 0.6% limit)', async () => {
    // 99.65 / 100.35 -> mid 100, spread 0.7 / 100 = 0.007
    const store = makeStore({
      '7203': { ...emptySymbolState('7203', () => now), lastQuote: quote(99.65, 100.35) },
    })
    const result = await service(store).executeTrade(buy('7203'), baseConfig)
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('spread'))).toBe(true)
  })

  it('allows BUY for JP name when spread is 0.5% (within 0.6% limit)', async () => {
    // 99.75 / 100.25 -> pct 0.005
    const store = makeStore({
      '7203': { ...emptySymbolState('7203', () => now), lastQuote: quote(99.75, 100.25) },
    })
    const result = await service(store).executeTrade(buy('7203'), baseConfig)
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('fail-closed: rejects BUY when lastQuote is present but bid is missing', async () => {
    const store = makeStore({
      SPY: { ...emptySymbolState('SPY', () => now), lastQuote: quote(undefined, 100.1) },
    })
    const result = await service(store).executeTrade(buy('SPY'), baseConfig)
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('bid/ask missing'))).toBe(true)
  })

  it('fail-closed: rejects BUY when lastQuote is present but ask is missing', async () => {
    const store = makeStore({
      SPY: { ...emptySymbolState('SPY', () => now), lastQuote: quote(99.9, undefined) },
    })
    const result = await service(store).executeTrade(buy('SPY'), baseConfig)
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('bid/ask missing'))).toBe(true)
  })

  it('skips the gate when lastQuote is null (unseeded symbol) to preserve legacy flow', async () => {
    const store = makeStore({})
    const result = await service(store).executeTrade(buy('SPY'), baseConfig)
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('uses the US limit for non-JP symbols and the JP limit for 4-digit codes', async () => {
    // Same spread 0.4% — pass for JP (< 0.6%), reject for US (> 0.25%)
    const storeUs = makeStore({
      SPY: { ...emptySymbolState('SPY', () => now), lastQuote: quote(99.8, 100.2) },
    })
    const storeJp = makeStore({
      '7203': { ...emptySymbolState('7203', () => now), lastQuote: quote(99.8, 100.2) },
    })
    const us = await service(storeUs).executeTrade(buy('SPY'), baseConfig)
    const jp = await service(storeJp).executeTrade(buy('7203'), baseConfig)
    expect(us.riskDecision.allowed).toBe(false)
    expect(jp.riskDecision.allowed).toBe(true)
  })
})
