import { describe, expect, it } from 'vitest'
import { computePullbackSizing } from '../../src/trading/strategy/pullbackSizing'

describe('computePullbackSizing', () => {
  it('sizes to 0.4% NAV risk divided by stop distance', () => {
    // $100k equity, 0.4% risk = $400 budget. Entry $100, stop -4% = $4 risk/share.
    // qty = floor(400 / 4) = 100. notional = 100 * 100 = 10_000.
    const result = computePullbackSizing({
      equity: 100_000,
      entryPrice: 100,
      stopPct: -0.04,
      atr20: 2,
      baselineAtr20: 2,
    })
    expect(result.quantity).toBe(100)
    expect(result.notional).toBe(10_000)
    expect(result.capped).toBe(false)
  })

  it('implied $ risk never exceeds equity * riskPerTradePct', () => {
    const equity = 50_000
    const result = computePullbackSizing({
      equity,
      entryPrice: 55,
      stopPct: -0.05,
      atr20: 1,
      baselineAtr20: 1,
      riskPerTradePct: 0.004,
    })
    const maxRisk = equity * 0.004
    const realizedRisk = result.quantity * Math.abs(55 * -0.05)
    expect(realizedRisk).toBeLessThanOrEqual(maxRisk)
  })

  it('halves the size when ATR(20) collapses below half the baseline', () => {
    const base = computePullbackSizing({
      equity: 100_000,
      entryPrice: 100,
      stopPct: -0.04,
      atr20: 2,
      baselineAtr20: 2,
    })
    const floored = computePullbackSizing({
      equity: 100_000,
      entryPrice: 100,
      stopPct: -0.04,
      atr20: 0.5,
      baselineAtr20: 2,
    })
    expect(floored.quantity).toBe(Math.floor(base.quantity / 2))
    expect(floored.capped).toBe(true)
    expect(floored.capReason).toBe('atr-floor')
  })

  it('clamps to symbolCap when unrestricted notional would exceed it', () => {
    const result = computePullbackSizing({
      equity: 1_000_000,
      entryPrice: 100,
      stopPct: -0.04,
      atr20: 2,
      baselineAtr20: 2,
      symbolCap: 5_000,
    })
    expect(result.notional).toBeLessThanOrEqual(5_000)
    expect(result.capped).toBe(true)
    expect(result.capReason).toBe('symbol-cap')
  })

  it('rejects a non-positive stop distance', () => {
    expect(
      computePullbackSizing({ equity: 100_000, entryPrice: 100, stopPct: 0, atr20: 2, baselineAtr20: 2 }),
    ).toMatchObject({ quantity: 0, capReason: 'invalid-stop' })
  })
})
