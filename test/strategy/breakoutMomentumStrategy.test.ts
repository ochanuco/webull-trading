import { describe, expect, it } from 'vitest'
import {
  BreakoutMomentumStrategy,
  TEST_DEFAULT_MOMENTUM_RULE,
  type MomentumInput,
  type MomentumRule,
} from '../../src/trading/strategy/strategies/BreakoutMomentumStrategy'
import type { PositionState } from '../../src/trading/state/types'

const now = new Date('2026-04-20T14:30:00.000Z')

/** breakoutHigh20=100, buffer 0.5% → breakout level = 100.5。price 101 で発火。 */
function goodEntry(): MomentumInput {
  return {
    symbol: 'ICLN',
    indicators: {
      price: 101,
      sma50: 95,
      return50d: 0.06,
      high20d: 101,
      low20d: 88,
      atr20: 1.5,
      baselineAtr20: 1.5,
      breakoutHigh20: 100,
    },
    position: null,
    pendingOrder: null,
    cooldownUntil: null,
    holdBusinessDays: 0,
    now,
  }
}

function decideEntry(mut: (i: MomentumInput) => void, rule: MomentumRule = TEST_DEFAULT_MOMENTUM_RULE) {
  const input = goodEntry()
  mut(input)
  return new BreakoutMomentumStrategy(rule).decide(input)
}

describe('BreakoutMomentumStrategy entry', () => {
  it('終値が当日除く20日高値×(1+buffer) 以上で BUY', () => {
    expect(decideEntry(() => {}).action).toBe('BUY')
  })

  it('ブレイク境界: level 未満は HOLD、ちょうど level は BUY', () => {
    // level = 100 * 1.005 = 100.5
    expect(decideEntry((i) => { i.indicators.price = 100.49 }).action).toBe('HOLD')
    expect(decideEntry((i) => { i.indicators.price = 100.5 }).action).toBe('BUY')
  })

  it('トレンド未達 (return20d <= minReturn) は HOLD', () => {
    expect(decideEntry((i) => { i.indicators.return50d = 0.03 }).action).toBe('HOLD')
  })

  it('price <= sma50 は HOLD', () => {
    expect(decideEntry((i) => { i.indicators.sma50 = 102 }).action).toBe('HOLD')
  })

  it('blowoff (SMA50 乖離が上限超) は HOLD', () => {
    // maxSma50DeviationPct=0.6。price 101 / sma50 60 → dev ~0.68 > 0.6。
    expect(decideEntry((i) => { i.indicators.sma50 = 60 }).action).toBe('HOLD')
  })

  it('breakoutHigh20 が無効 (<=0) は HOLD', () => {
    expect(decideEntry((i) => { i.indicators.breakoutHigh20 = 0 }).action).toBe('HOLD')
  })

  it('低ボラ要求は無い (ATR が高くても breakout は発火する = 自己矛盾回避)', () => {
    expect(decideEntry((i) => { i.indicators.atr20 = 10; i.indicators.baselineAtr20 = 1 }).action).toBe('BUY')
  })
})

describe('BreakoutMomentumStrategy exit', () => {
  const pos: PositionState = { qty: 10, avgPrice: 100, openedAt: now.toISOString() }
  function exitInput(price: number, holdDays: number): MomentumInput {
    const i = goodEntry()
    i.position = pos
    i.holdBusinessDays = holdDays
    i.indicators.price = price
    return i
  }
  const strat = new BreakoutMomentumStrategy(TEST_DEFAULT_MOMENTUM_RULE)

  it('TP (+10%) で SELL', () => {
    expect(strat.decide(exitInput(110, 1)).action).toBe('SELL')
  })
  it('time-stop (7日) で SELL', () => {
    expect(strat.decide(exitInput(101, 7)).action).toBe('SELL')
  })
  it('利確/損切/time 未達は HOLD', () => {
    expect(strat.decide(exitInput(101, 2)).action).toBe('HOLD')
  })
})
