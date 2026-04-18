import { describe, expect, it } from 'vitest'
import { TradingService, type TradingConfig } from '../../../src/trading/application/TradingService'
import { MockExecution } from '../../../src/trading/execution/MockExecution'
import { DefaultRiskPolicy } from '../../../src/trading/risk/DefaultRiskPolicy'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type QuoteSnapshot, type SymbolState } from '../../../src/trading/state/types'
import { FixedRuleStrategy } from '../../../src/trading/strategy/strategies/FixedRuleStrategy'

const now = new Date('2026-04-21T14:30:00.000Z')

const baseConfig: TradingConfig = {
  dryRun: true,
  tradingEnabled: true,
  allowedSymbols: ['SOXL', '7203'],
  maxOrderNotional: 1_000_000,
  symbolMaxNotional: {},
  marketHoursCheck: false,
}

function quote(price: number, ageMs = 1_000): QuoteSnapshot {
  // bid/ask seeded inside the default spread-guard envelope so the halt /
  // gap / band tests exercise their own gate and not the spread fail-closed.
  return {
    price,
    asOf: new Date(now.getTime() - ageMs).toISOString(),
    fetchedAt: new Date(now.getTime() - ageMs).toISOString(),
    source: 'test',
    bid: price * 0.999,
    ask: price * 1.001,
  }
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
    async setCooldown() {
      return state
    },
    async seedSettledCash() {
      return state
    },
  }
}

function makeService(
  store: PositionStore,
  overrides: { staleQuoteMs?: number; gapRejectPct?: number } = {},
) {
  // FixedRuleStrategy: price<=buyBelow → BUY. The wide thresholds make every
  // test input a BUY regardless of symbol.
  return new TradingService(
    new FixedRuleStrategy(10_000, 20_000_000),
    new DefaultRiskPolicy(),
    new MockExecution(),
    { positionStore: store, now: () => now, ...overrides },
  )
}

const soxlBuy = { symbol: 'SOXL', price: 9, quantity: 1, buyBelow: 10, sellAbove: 20 }
const soxlBuyAt10 = { symbol: 'SOXL', price: 10, quantity: 1, buyBelow: 10, sellAbove: 20 }
const toyotaBuyOutOfBand = {
  symbol: '7203',
  price: 5_800,
  quantity: 1,
  buyBelow: 10_000,
  sellAbove: 20_000_000,
}
const toyotaBuyInBand = {
  symbol: '7203',
  price: 5_500,
  quantity: 1,
  buyBelow: 10_000,
  sellAbove: 20_000_000,
}

describe('TradingService halt (quote freshness fallback)', () => {
  it('rejects when lastQuote is older than staleQuoteMs', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9, 16 * 60 * 1_000),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('halt or stale quote'))).toBe(true)
    expect(result.executionResult).toBeUndefined()
  })

  it('allows the BUY when lastQuote is fresh', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9, 60_000),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
    expect(result.riskDecision.reasons.some((r) => r.includes('halt or stale quote'))).toBe(false)
  })

  it('skips the halt check when lastQuote is null (POC back-compat)', async () => {
    const state = emptySymbolState('SOXL', () => now)
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('honours a custom staleQuoteMs override', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9, 5 * 60_000),
    }
    const result = await makeService(makeStore(state), { staleQuoteMs: 60_000 }).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(false)
  })
})

describe('TradingService opening-gap re-eval', () => {
  it('rejects BUY when |gap| between avgPrice and lastQuote exceeds threshold', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
      lastQuote: quote(9),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('gap re-eval'))).toBe(true)
  })

  it('passes when |gap| is within threshold', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
      lastQuote: quote(10.1),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuyAt10,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('skips the gap check when no position is open', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
  })
})

describe('TradingService JP price band gate', () => {
  it('rejects a JP limit priced outside the band', async () => {
    const state: SymbolState = {
      ...emptySymbolState('7203', () => now),
      lastQuote: quote(5_000),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      toyotaBuyOutOfBand,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(false)
    expect(result.riskDecision.reasons.some((r) => r.includes('JP price band'))).toBe(true)
  })

  it('allows a JP limit priced inside the band', async () => {
    const state: SymbolState = {
      ...emptySymbolState('7203', () => now),
      lastQuote: quote(5_000),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      toyotaBuyInBand,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
  })

  it('does not apply the JP band to US symbols', async () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9),
    }
    const result = await makeService(makeStore(state)).executeTrade(
      soxlBuy,
      baseConfig,
    )
    expect(result.riskDecision.allowed).toBe(true)
  })
})
