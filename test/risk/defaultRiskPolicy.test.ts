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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
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
        clientOrderId: 'test-coid',
      },
      marketHoursCheck: false,
      now: () => new Date('2026-04-20T12:00:00.000Z'),
    })

    expect(decision.allowed).toBe(true)
  })

  describe('market hours DST handling', () => {
    const buyIntent = {
      symbol: 'SOXL',
      side: 'BUY' as const,
      quantity: 2,
      price: 10,
      notional: 20,
      clientOrderId: 'test-coid',
    }
    const marketHoursInput = {
      ...baseInput,
      orderIntent: buyIntent,
      marketHoursCheck: true,
    }

    it('opens at 09:30 EST in winter (UTC-5)', () => {
      // 2026-01-15 14:30 UTC = 09:30 EST (Thursday)
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-01-15T14:30:00.000Z'),
      })
      expect(decision.allowed).toBe(true)
    })

    it('is closed one minute before open in winter (EST)', () => {
      // 2026-01-15 14:29 UTC = 09:29 EST
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-01-15T14:29:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
      expect(decision.reasons.some((r) => r.toLowerCase().includes('market hours'))).toBe(true)
    })

    it('opens at 09:30 EDT in summer (UTC-4)', () => {
      // 2026-07-15 13:30 UTC = 09:30 EDT (Wednesday)
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-07-15T13:30:00.000Z'),
      })
      expect(decision.allowed).toBe(true)
    })

    it('is closed one minute before open in summer (EDT)', () => {
      // 2026-07-15 13:29 UTC = 09:29 EDT
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-07-15T13:29:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
    })

    it('is closed at the 16:00 EDT boundary (close exclusive)', () => {
      // 2026-07-15 20:00 UTC = 16:00 EDT
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-07-15T20:00:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
    })

    it('is open one minute before close in winter (EST)', () => {
      // 2026-01-15 20:59 UTC = 15:59 EST
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-01-15T20:59:00.000Z'),
      })
      expect(decision.allowed).toBe(true)
    })

    it('rejects Saturday in NY even when the UTC clock looks active', () => {
      // 2026-04-25 15:00 UTC = 11:00 EDT on Saturday
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-04-25T15:00:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
    })

    it('uses NY weekday: late Sunday UTC that maps to NY Sunday is rejected', () => {
      // 2026-04-26 20:00 UTC = 16:00 EDT on Sunday
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-04-26T20:00:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
    })

    it('uses NY weekday: Friday UTC night that maps to NY Friday is still NY Friday (outside hours)', () => {
      // 2026-04-24 23:30 UTC = 19:30 EDT Friday (after close, but Friday in NY)
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-04-24T23:30:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
    })

    it('handles the DST spring-forward day (2026-03-08)', () => {
      // After 02:00 local on 2026-03-08, NY shifts EST→EDT.
      // 13:30 UTC on 2026-03-08 = 09:30 EDT (already on DST).
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-03-08T13:30:00.000Z'),
      })
      // Sunday in NY → still rejected by weekend rule, which is the correct conservative answer.
      expect(decision.allowed).toBe(false)

      // 13:30 UTC on Monday 2026-03-09 = 09:30 EDT → open.
      const nextDay = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-03-09T13:30:00.000Z'),
      })
      expect(nextDay.allowed).toBe(true)
    })

    it('handles the DST fall-back day (2026-11-01)', () => {
      // 2026-11-01 is Sunday — closed.
      // Monday 2026-11-02 after fall-back: 14:30 UTC = 09:30 EST → open.
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-11-02T14:30:00.000Z'),
      })
      expect(decision.allowed).toBe(true)
    })
  })

  describe('market hours market-aware handling (#656)', () => {
    const buyIntent = {
      symbol: 'SOXL',
      side: 'BUY' as const,
      quantity: 2,
      price: 10,
      notional: 20,
      clientOrderId: 'test-coid',
    }
    const marketHoursInput = {
      ...baseInput,
      orderIntent: buyIntent,
      marketHoursCheck: true,
    }

    it('rejects on a US market holiday (2026-07-03, Independence Day observed)', () => {
      // 2026-07-03 14:00 UTC = 10:00 EDT — would be within the regular session
      // by clock time alone, but the whole day is a US market holiday.
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-07-03T14:00:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
      expect(decision.reasons.some((r) => r.toLowerCase().includes('market hours'))).toBe(true)
    })

    it('allows before the early close on a US half-day (2026-11-27, day after Thanksgiving)', () => {
      // 2026-11-27 17:00 UTC = 12:00 EST — before the 13:00 ET early close.
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-11-27T17:00:00.000Z'),
      })
      expect(decision.allowed).toBe(true)
    })

    it('rejects after the early close on a US half-day (2026-11-27, day after Thanksgiving)', () => {
      // 2026-11-27 18:30 UTC = 13:30 EST — after the 13:00 ET early close.
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-11-27T18:30:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
    })

    it('allows a JP symbol during the JST regular session', () => {
      // 2026-08-04 01:00 UTC = 10:00 JST (Tuesday) — within the 09:00-15:30 JST session.
      const decision = policy.evaluate({
        ...marketHoursInput,
        orderIntent: { ...buyIntent, symbol: '7203' },
        now: () => new Date('2026-08-04T01:00:00.000Z'),
      })
      expect(decision.reasons.some((r) => r.toLowerCase().includes('market hours'))).toBe(false)
    })

    it('rejects a US symbol at the same instant a JP symbol would be allowed', () => {
      // 2026-08-04 01:00 UTC = 08/03 21:00 EDT (Monday) — after the US regular session close.
      const decision = policy.evaluate({
        ...marketHoursInput,
        now: () => new Date('2026-08-04T01:00:00.000Z'),
      })
      expect(decision.allowed).toBe(false)
      expect(decision.reasons.some((r) => r.toLowerCase().includes('market hours'))).toBe(true)
    })
  })
})
