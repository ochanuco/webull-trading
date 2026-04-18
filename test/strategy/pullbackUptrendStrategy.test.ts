import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE,
  LEVERAGED_RULE,
  PullbackUptrendStrategy,
  type PullbackInput,
} from '../../src/trading/strategy/strategies/PullbackUptrendStrategy'
import type { PendingOrderLock, PositionState } from '../../src/trading/state/types'

const now = new Date('2026-04-20T14:30:00.000Z')

/** Build a valid BUY-triggering input; individual tests mutate one field. */
function goodEntryInput(): PullbackInput {
  return {
    symbol: 'AAPL',
    indicators: {
      price: 96, // 4% pullback from high20d=100
      sma50: 90,
      return50d: 0.12,
      high20d: 100,
      atr20: 1.5,
      baselineAtr20: 1.5,
    },
    position: null,
    pendingOrder: null,
    cooldownUntil: null,
    holdBusinessDays: 0,
    now,
  }
}

const openPosition: PositionState = {
  qty: 10,
  avgPrice: 100,
  openedAt: '2026-04-15T14:30:00.000Z',
}

describe('PullbackUptrendStrategy entry', () => {
  const strategy = new PullbackUptrendStrategy()

  it('BUYs when all four entry conditions hold', () => {
    const signal = strategy.decide(goodEntryInput())
    expect(signal.action).toBe('BUY')
    expect(signal.quantity).toBe(0) // sizing resolves this downstream
  })

  it('HOLDs when 50d return is below the +8% trend threshold', () => {
    const input = goodEntryInput()
    input.indicators.return50d = 0.05
    expect(strategy.decide(input).action).toBe('HOLD')
  })

  it('HOLDs when price is at or below sma50', () => {
    const input = goodEntryInput()
    input.indicators.price = 89
    input.indicators.high20d = 100
    expect(strategy.decide(input).action).toBe('HOLD')
  })

  it('HOLDs when pullback is shallower than -3%', () => {
    const input = goodEntryInput()
    input.indicators.price = 99 // -1%
    expect(strategy.decide(input).action).toBe('HOLD')
  })

  it('HOLDs when pullback is deeper than -6%', () => {
    const input = goodEntryInput()
    input.indicators.price = 93 // -7%
    expect(strategy.decide(input).action).toBe('HOLD')
  })

  it('HOLDs when a pending order is in flight', () => {
    const input = goodEntryInput()
    input.pendingOrder = {
      clientOrderId: 'x',
      side: 'BUY',
      submittedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    } satisfies PendingOrderLock
    expect(strategy.decide(input).reason).toMatch(/pending order/)
  })

  it('HOLDs while cooldownUntil is in the future', () => {
    const input = goodEntryInput()
    input.cooldownUntil = new Date(now.getTime() + 60_000).toISOString()
    expect(strategy.decide(input).reason).toMatch(/cooldown/)
  })
})

describe('PullbackUptrendStrategy exit priority', () => {
  const strategy = new PullbackUptrendStrategy()

  function withPosition(price: number, holdBusinessDays = 0): PullbackInput {
    return {
      symbol: 'AAPL',
      indicators: { price, sma50: 0, return50d: 0, high20d: 0, atr20: 0, baselineAtr20: 0 },
      position: openPosition,
      pendingOrder: null,
      cooldownUntil: null,
      holdBusinessDays,
      now,
    }
  }

  it('SELLs on take-profit before time-stop', () => {
    const signal = strategy.decide(withPosition(108, 20))
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/take-profit/)
  })

  it('SELLs on stop-loss before time-stop', () => {
    const signal = strategy.decide(withPosition(95, 20))
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/stop-loss/)
  })

  it('SELLs on time-stop once hold reaches timeStopDays', () => {
    const signal = strategy.decide(withPosition(101, DEFAULT_RULE.timeStopDays))
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/time-stop/)
  })

  it('HOLDs while pnl and hold are inside the rule envelope', () => {
    expect(strategy.decide(withPosition(101, 3)).action).toBe('HOLD')
  })
})

describe('PullbackUptrendStrategy 3x ETF guardrail', () => {
  const strategy = new PullbackUptrendStrategy({ SOXL: LEVERAGED_RULE })

  it('applies LEVERAGED_RULE for SOXL', () => {
    expect(strategy.resolveRule('SOXL').timeStopDays).toBe(5)
    expect(strategy.resolveRule('SOXL').stopPct).toBe(-0.03)
  })

  it('falls back to DEFAULT_RULE for non-listed symbols', () => {
    expect(strategy.resolveRule('AAPL')).toEqual(DEFAULT_RULE)
  })

  it('SELLs SOXL at hold=5 days where DEFAULT_RULE would still hold', () => {
    const signal = strategy.decide({
      symbol: 'SOXL',
      indicators: { price: 101, sma50: 0, return50d: 0, high20d: 0, atr20: 0, baselineAtr20: 0 },
      position: openPosition,
      pendingOrder: null,
      cooldownUntil: null,
      holdBusinessDays: 5,
      now,
    })
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/time-stop/)
  })

  it('SELLs SOXL on the tighter -3% stop', () => {
    const signal = strategy.decide({
      symbol: 'SOXL',
      indicators: { price: 96.5, sma50: 0, return50d: 0, high20d: 0, atr20: 0, baselineAtr20: 0 },
      position: openPosition,
      pendingOrder: null,
      cooldownUntil: null,
      holdBusinessDays: 1,
      now,
    })
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/stop-loss/)
  })
})
