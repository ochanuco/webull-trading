import { describe, expect, it, vi } from 'vitest'
import {
  evaluatePerSymbolRisk,
  type PerSymbolRiskConfig,
} from '../../../src/trading/risk/perSymbolRiskGate'
import {
  emptySymbolState,
  type QuoteSnapshot,
  type SymbolState,
} from '../../../src/trading/state/types'

const now = new Date('2026-04-21T14:30:00.000Z')

const baseConfig: PerSymbolRiskConfig = {
  inversePairs: { SOXL: 'SOXS', SOXS: 'SOXL' },
  spreadLimits: { US: 0.0025, JP: 0.006 },
  staleQuoteMs: 15 * 60 * 1_000,
  gapRejectPct: 0.03,
}

function quote(price: number, ageMs = 1_000, overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  // bid/ask seeded inside default spread envelope so non-spread tests do not
  // trip the spread gate inadvertently。Override per-test as needed.
  return {
    price,
    asOf: new Date(now.getTime() - ageMs).toISOString(),
    fetchedAt: new Date(now.getTime() - ageMs).toISOString(),
    source: 'test',
    bid: price * 0.999,
    ask: price * 1.001,
    ...overrides,
  }
}

describe('evaluatePerSymbolRisk — pass-through baseline', () => {
  it('approves a clean BUY with empty state', () => {
    const decision = evaluatePerSymbolRisk(
      {
        symbol: 'SOXL',
        side: 'BUY',
        intentPrice: 9,
        intentNotional: 9,
        state: emptySymbolState('SOXL', () => now),
        inverseState: null,
        now,
      },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(decision.reasons).toEqual([])
  })
})

describe('evaluatePerSymbolRisk — settled cash', () => {
  it('rejects BUY when notional exceeds settledCash', () => {
    const state: SymbolState = { ...emptySymbolState('SOXL', () => now), settledCash: 20 }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 27, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('insufficient settled cash')
  })

  it('skips the gate for SELL', () => {
    const state: SymbolState = { ...emptySymbolState('SOXL', () => now), settledCash: 20 }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'SELL', intentPrice: 9, intentNotional: 27, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('skips when settledCash=0 (unseeded)', () => {
    const decision = evaluatePerSymbolRisk(
      {
        symbol: 'SOXL',
        side: 'BUY',
        intentPrice: 9,
        intentNotional: 27,
        state: emptySymbolState('SOXL', () => now),
        now,
      },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })
})

describe('evaluatePerSymbolRisk — inverse pair', () => {
  it('rejects BUY when inverseState shows an open position', () => {
    const state = emptySymbolState('SOXL', () => now)
    const inverseState: SymbolState = {
      ...emptySymbolState('SOXS', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, inverseState, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('inverse-pair exposure')
  })

  it('approves BUY when inverseState has no position', () => {
    const state = emptySymbolState('SOXL', () => now)
    const inverseState = emptySymbolState('SOXS', () => now)
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, inverseState, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('does not gate SELL on inverse exposure', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: { qty: 1, avgPrice: 9, openedAt: now.toISOString() },
    }
    const inverseState: SymbolState = {
      ...emptySymbolState('SOXS', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'SELL', intentPrice: 9, intentNotional: 9, state, inverseState, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })
})

describe('evaluatePerSymbolRisk — stale quote / halt fallback', () => {
  it('rejects when lastQuote.fetchedAt is older than staleQuoteMs', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9, 16 * 60 * 1_000),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('halt or stale quote')
  })

  it('skips when lastQuote is null (unseeded)', () => {
    const decision = evaluatePerSymbolRisk(
      {
        symbol: 'SOXL',
        side: 'BUY',
        intentPrice: 9,
        intentNotional: 9,
        state: emptySymbolState('SOXL', () => now),
        now,
      },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('approves SELL even when lastQuote is days-stale (stop hit / exit priority)', () => {
    // SOXL stop hit scenario from prod: lastQuote 4 days old must NOT block SELL.
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: { qty: 10, avgPrice: 124.95, openedAt: now.toISOString() },
      lastQuote: quote(119.38, 4 * 24 * 60 * 60 * 1_000),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'SELL', intentPrice: 119.38, intentNotional: 1_193.8, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(decision.reasons).toEqual([])
  })
})

describe('evaluatePerSymbolRisk — spread guard', () => {
  it('rejects US BUY when spread > US limit', () => {
    const state: SymbolState = {
      ...emptySymbolState('SPY', () => now),
      lastQuote: quote(100, 1_000, { bid: 99.85, ask: 100.15 }),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SPY', side: 'BUY', intentPrice: 100, intentNotional: 100, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('spread')
  })

  it('rejects when bid is missing (fail-closed)', () => {
    const state: SymbolState = {
      ...emptySymbolState('SPY', () => now),
      lastQuote: quote(100, 1_000, { bid: undefined, ask: 100.1 }),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SPY', side: 'BUY', intentPrice: 100, intentNotional: 100, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('bid/ask missing')
  })

  it('skips spread guard (approves) when source lacks bid/ask — Yahoo (#411 案A)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const state: SymbolState = {
        ...emptySymbolState('TQQQ', () => now),
        // Yahoo feed は bid/ask 無しで price のみ保存する。
        lastQuote: quote(100, 1_000, { source: 'yahoo-snapshot', bid: undefined, ask: undefined }),
      }
      const decision = evaluatePerSymbolRisk(
        { symbol: 'TQQQ', side: 'BUY', intentPrice: 100, intentNotional: 100, state, now },
        baseConfig,
      )
      expect(decision.approved).toBe(true)
      expect(decision.reasons).toEqual([])
      // observability に skip を明示する構造化ログが出る。
      const logged = warn.mock.calls.map((c) => JSON.parse(c[0] as string))
      expect(logged).toContainEqual(
        expect.objectContaining({ event: 'spread_guard_skipped_no_bidask', symbol: 'TQQQ', source: 'yahoo-snapshot' }),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('still enforces spread limit when a bid/ask-less source DOES provide bid/ask', () => {
    // Yahoo source でも bid/ask が来た場合は通常通り spread 判定する (skip は欠損時のみ)。
    const state: SymbolState = {
      ...emptySymbolState('TQQQ', () => now),
      lastQuote: quote(100, 1_000, { source: 'yahoo-snapshot', bid: 99.0, ask: 101.0 }), // spread 2% >> 0.25%
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'TQQQ', side: 'BUY', intentPrice: 100, intentNotional: 100, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('spread')
  })

  it('approves SELL when spread is wide (exit priority)', () => {
    const state: SymbolState = {
      ...emptySymbolState('SPY', () => now),
      position: { qty: 1, avgPrice: 100, openedAt: now.toISOString() },
      lastQuote: quote(100, 1_000, { bid: 99.85, ask: 100.15 }),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SPY', side: 'SELL', intentPrice: 100, intentNotional: 100, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(decision.reasons).toEqual([])
  })

  it('approves SELL even when bid/ask is missing (exit priority)', () => {
    const state: SymbolState = {
      ...emptySymbolState('SPY', () => now),
      position: { qty: 1, avgPrice: 100, openedAt: now.toISOString() },
      lastQuote: quote(100, 1_000, { bid: undefined, ask: 100.1 }),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SPY', side: 'SELL', intentPrice: 100, intentNotional: 100, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })
})

describe('evaluatePerSymbolRisk — gap re-eval', () => {
  it('rejects BUY when |gap| exceeds threshold', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
      lastQuote: quote(9),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('gap re-eval')
  })

  it('skips when no position is open', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('approves SELL even when |gap| exceeds threshold (stop hit fires)', () => {
    // SOXL stop hit shape: avgPrice 124.95 vs current 119.38 (~-4.5%) > 3% threshold.
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: { qty: 10, avgPrice: 124.95, openedAt: now.toISOString() },
      lastQuote: quote(119.38),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'SELL', intentPrice: 119.38, intentNotional: 1_193.8, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(decision.reasons).toEqual([])
  })
})

describe('evaluatePerSymbolRisk — JP price band', () => {
  it('rejects JP limit priced outside the band', () => {
    const state: SymbolState = {
      ...emptySymbolState('7203', () => now),
      lastQuote: quote(5_000),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: '7203', side: 'BUY', intentPrice: 5_800, intentNotional: 5_800, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('JP price band')
  })

  it('does not apply the JP band to US symbols', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastQuote: quote(9),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('approves SELL outside JP price band (exit priority)', () => {
    const state: SymbolState = {
      ...emptySymbolState('7203', () => now),
      position: { qty: 100, avgPrice: 5_000, openedAt: now.toISOString() },
      lastQuote: quote(5_000),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: '7203', side: 'SELL', intentPrice: 5_800, intentNotional: 580_000, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(decision.reasons).toEqual([])
  })
})

describe('evaluatePerSymbolRisk — cooldown (option)', () => {
  it('rejects when evaluateCooldown=true and cooldownUntil is in the future', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      cooldownUntil: new Date(now.getTime() + 60_000).toISOString(),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      { ...baseConfig, evaluateCooldown: true },
    )
    expect(decision.approved).toBe(false)
    expect(decision.reasons[0]).toContain('cooldown active')
  })

  it('ignores cooldown when evaluateCooldown=false (cron path)', () => {
    const state: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      cooldownUntil: new Date(now.getTime() + 60_000).toISOString(),
    }
    const decision = evaluatePerSymbolRisk(
      { symbol: 'SOXL', side: 'BUY', intentPrice: 9, intentNotional: 9, state, now },
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })
})
