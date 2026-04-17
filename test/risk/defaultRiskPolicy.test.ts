import { describe, expect, it } from 'vitest'
import type { Signal } from '../../src/trading/domain/Signal'
import { DefaultRiskPolicy } from '../../src/trading/risk/DefaultRiskPolicy'

describe('DefaultRiskPolicy', () => {
  const policy = new DefaultRiskPolicy()
  const signal: Signal = {
    action: 'BUY',
    symbol: 'SOXL',
    quantity: 2,
    price: 10,
    reason: 'test',
    generatedAtIso: '2026-01-01T00:00:00.000Z',
  }
  const baseInput = {
    signal,
    tradingEnabled: true,
    allowedSymbols: ['SOXL', 'SOXS'],
    maxOrderNotional: 100,
    symbolMaxNotional: {},
    marketHoursCheck: false,
  }

  it('allows a whitelisted order within the configured notional limit', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
    })

    expect(decision.allowed).toBe(true)
    expect(decision.normalizedIntent?.symbol).toBe('SOXL')
  })

  it('accepts a lowercase symbol when the whitelist contains its uppercase form', () => {
    const decision = policy.evaluate({
      ...baseInput,
      signal: {
        ...signal,
        symbol: 'soxl',
      },
      orderIntent: {
        symbol: 'soxl',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
    })

    expect(decision.allowed).toBe(true)
    expect(decision.normalizedIntent?.symbol).toBe('soxl')
  })

  it('denies an order for an unknown symbol', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'TSLA',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('symbol TSLA is not allowed')
  })

  it('denies an order when notional exceeds the limit or trading is disabled', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 20,
        price: 10,
        notional: 200,
      },
      tradingEnabled: false,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('trading is disabled')
    expect(decision.reasons).toContain('order notional 200 exceeds max 100')
  })

  it('returns early when orderIntent is missing', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: undefined,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('orderIntent is missing')
  })

  it('uses a symbol-specific max notional override when present', () => {
    const allowedDecision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 4,
        price: 10,
        notional: 40,
      },
      symbolMaxNotional: { SOXL: 50 },
    })
    const rejectedDecision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 6,
        price: 10,
        notional: 60,
      },
      symbolMaxNotional: { SOXL: 50 },
    })

    expect(allowedDecision.allowed).toBe(true)
    expect(rejectedDecision.allowed).toBe(false)
    expect(rejectedDecision.reasons).toContain('order notional 60 exceeds max 50')
  })

  it('falls back to the global max notional when a symbol override is absent', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXS',
        side: 'BUY',
        quantity: 11,
        price: 10,
        notional: 110,
      },
      symbolMaxNotional: { SOXL: 50 },
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('order notional 110 exceeds max 100')
  })

  it('rejects outside market hours when the market hours check is enabled', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
      marketHoursCheck: true,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons.some((reason) => reason.toLowerCase().includes('market hours'))).toBe(true)
  })

  it('allows within market hours when the market hours check is enabled', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
      marketHoursCheck: true,
      now: () => new Date('2026-04-20T15:00:00.000Z'),
    })

    expect(decision.allowed).toBe(true)
  })

  it('ignores time when the market hours check is disabled', () => {
    const decision = policy.evaluate({
      ...baseInput,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
      marketHoursCheck: false,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    })

    expect(decision.allowed).toBe(true)
  })
})
