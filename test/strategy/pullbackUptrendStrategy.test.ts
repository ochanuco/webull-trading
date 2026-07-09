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
  // 再エントリーガードも既存ケースでは無効化 (0)。検証は専用 describe で実施。
  reentryMinAtrBelowLastExit: 0,
  reentryGuardBusinessDays: 0,
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
      ['entry.reentry_below_last_exit', true],
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

// #reentry: 前回売値からの再エントリー価格ガード。窓内 (既定 3 営業日) は前回売値
// −1ATR 以上安くないと買い直さない。窓外 / 情報欠落は素通り (fail-open)。
describe('PullbackUptrendStrategy re-entry price guard', () => {
  const strategy = new PullbackUptrendStrategy(TEST_DEFAULT_RULE)

  it('HOLDs when re-buying within the window at/above (last exit - 1 ATR)', () => {
    const input = goodEntryInput() // price 96, atr20 1.5
    input.lastExitPrice = 96 // ceiling = 96 - 1*1.5 = 94.5; price 96 > 94.5 → block
    input.businessDaysSinceExit = 1
    const signal = strategy.decide(input)
    expect(signal.action).toBe('HOLD')
    expect(signal.reason).toMatch(/re-entry guard/)
    expect(signal.trace?.at(-1)).toMatchObject({
      label: 'entry.reentry_below_last_exit',
      passed: false,
    })
  })

  it('BUYs when re-entry price is sufficiently below last exit within the window', () => {
    const input = goodEntryInput() // price 96
    input.lastExitPrice = 100 // ceiling = 100 - 1.5 = 98.5; price 96 <= 98.5 → pass
    input.businessDaysSinceExit = 1
    expect(strategy.decide(input).action).toBe('BUY')
  })

  it('BUYs once the guard window has elapsed even at/above last exit', () => {
    const input = goodEntryInput()
    input.lastExitPrice = 96
    input.businessDaysSinceExit = 3 // >= reentryGuardBusinessDays → guard inactive
    expect(strategy.decide(input).action).toBe('BUY')
  })

  it('is fail-open when lastExitPrice is unknown', () => {
    const input = goodEntryInput()
    input.lastExitPrice = null
    input.businessDaysSinceExit = 1
    expect(strategy.decide(input).action).toBe('BUY')
  })

  it('is fail-open when businessDaysSinceExit is unknown', () => {
    const input = goodEntryInput()
    input.lastExitPrice = 96
    input.businessDaysSinceExit = null
    expect(strategy.decide(input).action).toBe('BUY')
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

describe('PullbackUptrendStrategy exit ATR-linked stop (#exit-atr)', () => {
  // LEVERAGED_RULE: stopPct -0.03, kAtr 2.5, avgPrice 100 → pctStopDist=3 (=-3%)。
  const strategy = new PullbackUptrendStrategy(LEVERAGED_RULE)
  const buildExit = (price: number, atr20: number): PullbackInput => ({
    symbol: 'TQQQ',
    indicators: { price, sma50: 0, return50d: 0, high20d: 0, atr20, baselineAtr20: 1 },
    position: openPosition, // avgPrice 100
    pendingOrder: null,
    cooldownUntil: null,
    holdBusinessDays: 0,
    now,
  })

  it('ATR widens the stop: -4% loss does NOT trigger when atr stop is -5%', () => {
    // atr20=2, kAtr 2.5 → atrStopDist=5 (=-5%) > pctStopDist=3 → 実効 stop -5%。
    // price 96 (pnl -4%) は -5% に届かず HOLD。固定 -3% pct stop なら誤発火していた。
    const signal = strategy.decide(buildExit(96, 2))
    expect(signal.action).toBe('HOLD')
  })

  it('ATR stop fires (and labels atr) once loss exceeds the ATR-widened distance', () => {
    const signal = strategy.decide(buildExit(94, 2)) // pnl -6% <= -5%
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/stop-loss/)
    expect(signal.reason).toMatch(/atr/)
  })

  it('pct floor applies when ATR is small: -4% triggers the -3% pct stop', () => {
    // atr20=0.5 → atrStopDist=1.25 < pctStopDist=3 → 実効 stop は pct floor -3%。
    const signal = strategy.decide(buildExit(96, 0.5)) // pnl -4% <= -3%
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/pct/)
  })

  it('falls back to pct stop when atr20 is 0 / invalid', () => {
    const signal = strategy.decide(buildExit(96, 0)) // pnl -4% <= -3% pct
    expect(signal.action).toBe('SELL')
    expect(signal.reason).toMatch(/stop-loss/)
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
