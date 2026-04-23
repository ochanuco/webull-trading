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

  it('rounds down to lotSize multiples (TSE 100-share lot)', () => {
    // equity 1.5M JPY, risk 0.4% = 6_000 JPY budget. Entry 1500, stop -4% =
    // 60 JPY risk/share. Raw qty = floor(6000 / 60) = 100. Already a
    // 100-lot multiple so no change.
    const exact = computePullbackSizing({
      equity: 1_500_000,
      entryPrice: 1500,
      stopPct: -0.04,
      atr20: 10,
      baselineAtr20: 10,
      lotSize: 100,
    })
    expect(exact.quantity).toBe(100)

    // symbolCap forces qty below a lot boundary: cap 250_000 at 1500 →
    // floor(250000/1500) = 166 → round down to 100.
    const rounded = computePullbackSizing({
      equity: 100_000_000,
      entryPrice: 1500,
      stopPct: -0.04,
      atr20: 10,
      baselineAtr20: 10,
      symbolCap: 250_000,
      lotSize: 100,
    })
    expect(rounded.quantity).toBe(100)
    expect(rounded.notional).toBe(150_000)
    expect(rounded.capped).toBe(true)
  })

  it('returns qty=0 with lot-size-round when raw qty is below one lot', () => {
    // Budget too small to afford 100 shares → round down to 0.
    const result = computePullbackSizing({
      equity: 100_000,
      entryPrice: 5000,
      stopPct: -0.04,
      atr20: 10,
      baselineAtr20: 10,
      lotSize: 100,
    })
    expect(result.quantity).toBe(0)
    expect(result.capReason).toBe('lot-size-round')
  })
})
