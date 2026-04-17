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

  it('allows a whitelisted order within the configured notional limit', () => {
    const decision = policy.evaluate({
      signal,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
      tradingEnabled: true,
      allowedSymbols: ['SOXL', 'SOXS'],
      maxOrderNotional: 100,
    })

    expect(decision.allowed).toBe(true)
    expect(decision.normalizedIntent?.symbol).toBe('SOXL')
  })

  it('accepts a lowercase symbol when the whitelist contains its uppercase form', () => {
    const decision = policy.evaluate({
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
      tradingEnabled: true,
      allowedSymbols: ['SOXL', 'SOXS'],
      maxOrderNotional: 100,
    })

    expect(decision.allowed).toBe(true)
    expect(decision.normalizedIntent?.symbol).toBe('soxl')
  })

  it('denies an order for an unknown symbol', () => {
    const decision = policy.evaluate({
      signal,
      orderIntent: {
        symbol: 'TSLA',
        side: 'BUY',
        quantity: 2,
        price: 10,
        notional: 20,
      },
      tradingEnabled: true,
      allowedSymbols: ['SOXL', 'SOXS'],
      maxOrderNotional: 100,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('symbol TSLA is not allowed')
  })

  it('denies an order when notional exceeds the limit or trading is disabled', () => {
    const decision = policy.evaluate({
      signal,
      orderIntent: {
        symbol: 'SOXL',
        side: 'BUY',
        quantity: 20,
        price: 10,
        notional: 200,
      },
      tradingEnabled: false,
      allowedSymbols: ['SOXL', 'SOXS'],
      maxOrderNotional: 100,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('trading is disabled')
    expect(decision.reasons).toContain('order notional 200 exceeds max 100')
  })

  it('returns early when orderIntent is missing', () => {
    const decision = policy.evaluate({
      signal,
      orderIntent: undefined,
      tradingEnabled: true,
      allowedSymbols: ['SOXL', 'SOXS'],
      maxOrderNotional: 100,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('orderIntent is missing')
  })
})