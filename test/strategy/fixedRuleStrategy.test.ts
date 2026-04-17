import { describe, expect, it } from 'vitest'
import { FixedRuleStrategy } from '../../src/trading/strategy/strategies/FixedRuleStrategy'

describe('FixedRuleStrategy', () => {
  it('returns BUY when price is below the buy threshold', () => {
    const strategy = new FixedRuleStrategy(10, 20)

    const signal = strategy.decide({ symbol: 'SOXL', price: 9, quantity: 2 })

    expect(signal.action).toBe('BUY')
  })

  it('returns SELL when price is above the sell threshold', () => {
    const strategy = new FixedRuleStrategy(10, 20)

    const signal = strategy.decide({ symbol: 'SOXL', price: 21, quantity: 2 })

    expect(signal.action).toBe('SELL')
  })

  it('returns HOLD when price is between thresholds', () => {
    const strategy = new FixedRuleStrategy(10, 20)

    const signal = strategy.decide({ symbol: 'SOXL', price: 15, quantity: 2 })

    expect(signal.action).toBe('HOLD')
  })
})
