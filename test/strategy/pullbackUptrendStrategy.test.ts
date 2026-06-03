import { describe, expect, it } from 'vitest'
import {
  PullbackUptrendStrategy,
  TEST_DEFAULT_RULE,
  type PullbackInput,
  type SymbolRule,
} from '../../src/trading/strategy/strategies/PullbackUptrendStrategy'
import type { PendingOrderLock, PositionState } from '../../src/trading/state/types'

const now = new Date('2026-04-20T14:30:00.000Z')

const LEVERAGED_RULE: SymbolRule = {
  stopPct: -0.03,
  takeProfitPct: 0.05,
  timeStopDays: 5,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.5,
  // 過熱ガードは既存ケースでは無効化 (大きい値)。ガード検証は専用 describe で実施。
  maxSma50DeviationPct: 100,
  maxAtrRatio: 100,
}

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
  const strategy = new PullbackUptrendStrategy(TEST_DEFAULT_RULE)

  it('BUYs when all four entry conditions hold', () => {
    const signal = strategy.decide(goodEntryInput())
    expect(signal.action).toBe('BUY')
    expect(signal.quantity).toBe(0) // sizing resolves this downstream
    expect(signal.trace?.map((step) => [step.label, step.passed])).toEqual([
      ['guard.pending_order_absent', true],
      ['guard.cooldown_inactive', true],
      ['route.position_open', false],
      ['entry.trend_50d_return', true],
      ['entry.above_sma50', true],
      ['entry.not_overextended', true],
      ['entry.vol_not_elevated', true],
      ['entry.high20d_valid', true],
      ['entry.pullback_not_too_shallow', true],
      ['entry.pullback_not_too_deep', true],
      ['entry.adopt_buy', true],
    ])
    expect(signal.trace?.find((step) => step.label === 'entry.adopt_buy')?.label_ja).toBe('買い採用')
  })

  it('HOLDs when 50d return is below the +8% trend threshold', () => {
    const input = goodEntryInput()
    input.indicators.return50d = 0.05
    const signal = strategy.decide(input)
    expect(signal.action).toBe('HOLD')
    expect(signal.trace?.at(-1)).toMatchObject({
      label: 'entry.trend_50d_return',
      passed: false,
    })
  })

  it('HOLDs when price is at or below sma50', () => {
    const input = goodEntryInput()
    input.indicators.price = 89
    input.indicators.high20d = 100
    expect(strategy.decide(input).action).toBe('HOLD')
  })

  // #strategy-overextension-guards: SMA50 上方乖離が上限超 → 過熱で見送り。
  it('HOLDs (overextended) when price is too far above sma50', () => {
    const input = goodEntryInput()
    input.indicators.sma50 = 50 // price 96 → deviation +92% > default 0.6
    const signal = strategy.decide(input)
    expect(signal.action).toBe('HOLD')
    expect(signal.reason).toMatch(/overextended/)
    expect(signal.trace?.at(-1)).toMatchObject({ label: 'entry.not_overextended', passed: false })
  })

  // #strategy-overextension-guards: 直近 ATR が baseline 比で過大 → ボラ過熱で見送り。
  it('HOLDs (volatility elevated) when atr20 exceeds maxAtrRatio of baseline', () => {
    const input = goodEntryInput()
    input.indicators.atr20 = 4 // baselineAtr20=1.5 → ratio 2.67 > default 1.5
    const signal = strategy.decide(input)
    expect(signal.action).toBe('HOLD')
    expect(signal.reason).toMatch(/volatility elevated/)
    expect(signal.trace?.at(-1)).toMatchObject({ label: 'entry.vol_not_elevated', passed: false })
  })

  it('still BUYs at moderate extension / normal volatility (gates do not over-block)', () => {
    // price 96 / sma50 90 → dev +6.7% < 0.6、atr 比 1.0 < 1.5 → 両ガード通過で BUY。
    expect(strategy.decide(goodEntryInput()).action).toBe('BUY')
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
  const strategy = new PullbackUptrendStrategy(TEST_DEFAULT_RULE)

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
    expect(signal.trace?.at(-1)).toMatchObject({ label: 'exit.take_profit', passed: true })
  })

  it('SELLs on stop-loss before time-stop', () => {
    const signal = strategy.decide(withPosition(95, 20))
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/stop-loss/)
  })

  it('SELLs on time-stop once hold reaches timeStopDays', () => {
    const signal = strategy.decide(withPosition(101, TEST_DEFAULT_RULE.timeStopDays))
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/time-stop/)
  })

  it('HOLDs while pnl and hold are inside the rule envelope', () => {
    expect(strategy.decide(withPosition(101, 3)).action).toBe('HOLD')
  })
})

describe('PullbackUptrendStrategy per-symbol override', () => {
  const strategy = new PullbackUptrendStrategy(TEST_DEFAULT_RULE, { SOXL: LEVERAGED_RULE })

  it('applies per-symbol rule for SOXL', () => {
    expect(strategy.resolveRule('SOXL').timeStopDays).toBe(5)
    expect(strategy.resolveRule('SOXL').stopPct).toBe(-0.03)
  })

  it('falls back to default rule for non-listed symbols', () => {
    expect(strategy.resolveRule('AAPL')).toEqual(TEST_DEFAULT_RULE)
  })

  it('SELLs SOXL at hold=5 days where default rule would still hold', () => {
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
