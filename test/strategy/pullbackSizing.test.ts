import { describe, expect, it } from 'vitest'
import { computePullbackSizing, type PullbackSizingInput } from '../../src/trading/strategy/pullbackSizing'

/**
 * kAtr is required (#23 Lane 1, no-backward-compat). This helper injects
 * kAtr=2 by default; individual tests override to exercise ATR-dominant
 * paths. Chosen so `kAtr * atr20 <= |entry * stopPct|` in the baseline case,
 * preserving the pct-bound expectations of legacy tests.
 */
const baseInput = (
  overrides: Partial<PullbackSizingInput> = {},
): PullbackSizingInput => ({
  equity: 100_000,
  entryPrice: 100,
  stopPct: -0.04,
  atr20: 2,
  baselineAtr20: 2,
  kAtr: 2,
  ...overrides,
})

describe('computePullbackSizing', () => {
  it('sizes to 0.4% NAV risk divided by stop distance', () => {
    // max(pct=4, atr=4) = 4. qty = floor(400 / 4) = 100.
    const result = computePullbackSizing(baseInput())
    expect(result.quantity).toBe(100)
    expect(result.notional).toBe(10_000)
    expect(result.capped).toBe(false)
  })

  it('implied $ risk never exceeds equity * riskPerTradePct', () => {
    const equity = 50_000
    const result = computePullbackSizing(
      baseInput({
        equity,
        entryPrice: 55,
        stopPct: -0.05,
        atr20: 1,
        baselineAtr20: 1,
        riskPerTradePct: 0.004,
      }),
    )
    const maxRisk = equity * 0.004
    const realizedRisk = result.quantity * Math.abs(55 * -0.05)
    expect(realizedRisk).toBeLessThanOrEqual(maxRisk)
  })

  it('halves the size when ATR(20) collapses below half the baseline', () => {
    const base = computePullbackSizing(baseInput())
    const floored = computePullbackSizing(baseInput({ atr20: 0.5, baselineAtr20: 2 }))
    expect(floored.quantity).toBe(Math.floor(base.quantity / 2))
    expect(floored.capped).toBe(true)
    expect(floored.capReason).toBe('atr-floor')
  })

  it('clamps to symbolCap when unrestricted notional would exceed it', () => {
    const result = computePullbackSizing(baseInput({ equity: 1_000_000, symbolCap: 5_000 }))
    expect(result.notional).toBeLessThanOrEqual(5_000)
    expect(result.capped).toBe(true)
    expect(result.capReason).toBe('symbol-cap')
  })

  it('rejects when both ATR and pct stop distances are 0', () => {
    // pctStop=0 (stopPct=0) AND atrStop=0 (atr20=0) → stopDistance=0 → invalid
    expect(
      computePullbackSizing(baseInput({ stopPct: 0, atr20: 0, baselineAtr20: 2 })),
    ).toMatchObject({ quantity: 0, capReason: 'invalid-stop' })
  })

  it('rounds down to lotSize multiples (TSE 100-share lot)', () => {
    const exact = computePullbackSizing(
      baseInput({
        equity: 1_500_000,
        entryPrice: 1500,
        atr20: 10,
        baselineAtr20: 10,
        lotSize: 100,
      }),
    )
    expect(exact.quantity).toBe(100)

    const rounded = computePullbackSizing(
      baseInput({
        equity: 100_000_000,
        entryPrice: 1500,
        atr20: 10,
        baselineAtr20: 10,
        symbolCap: 250_000,
        lotSize: 100,
      }),
    )
    expect(rounded.quantity).toBe(100)
    expect(rounded.notional).toBe(150_000)
    expect(rounded.capped).toBe(true)
  })

  it('returns qty=0 with lot-size-round when raw qty is below one lot', () => {
    const result = computePullbackSizing(
      baseInput({
        entryPrice: 5000,
        atr20: 10,
        baselineAtr20: 10,
        lotSize: 100,
      }),
    )
    expect(result.quantity).toBe(0)
    expect(result.capReason).toBe('lot-size-round')
  })

  it('populates diagnostic fields (rawQuantity / stopDistance / riskBudget)', () => {
    // equity 100k, risk 0.4% → budget 400。entry 100 × stopPct -4% → pctStop 4。
    // atr20 × kAtr = 2×2 = 4。max = 4。raw qty = floor(400 / 4) = 100。
    const result = computePullbackSizing(baseInput())
    expect(result.rawQuantity).toBe(100)
    expect(result.stopDistance).toBe(4)
    expect(result.riskBudget).toBe(400)
  })

  it('rawQuantity reflects pre-lot-round value so operators can see the gap', () => {
    // entry 1297 atr20 24 kAtr 2 → atrStop 48、pctStop 1297*0.04=51.88。stop≒52。
    // equity 2M risk 0.4% → budget 8000。raw qty = floor(8000/51.88) = 154。
    // lot 100 → rounded 100 (allowed) → diagnostic rawQuantity still 154.
    const result = computePullbackSizing(
      baseInput({
        equity: 2_000_000,
        entryPrice: 1297,
        atr20: 24,
        baselineAtr20: 24,
        lotSize: 100,
      }),
    )
    expect(result.quantity).toBe(100)
    expect(result.rawQuantity).toBe(154)
  })

  it('uses the ATR-based stop when wider than the pct-based stop', () => {
    // atr20=3 × kAtr=2 → atr stop = 6 > pct stop 4. floor(400 / 6) = 66.
    const result = computePullbackSizing(
      baseInput({ atr20: 3, baselineAtr20: 3, kAtr: 2 }),
    )
    expect(result.quantity).toBe(66)
  })

  it('falls back to pct stop when atr20 is 0 (post-halt ATR collapse guard)', () => {
    // atr20=0 → atrStop=0, pctStop=4 wins. floor(400/4)=100, then atr-floor
    // halving (atr20 < baseline*0.5) → 50.
    const result = computePullbackSizing(
      baseInput({ atr20: 0, baselineAtr20: 3 }),
    )
    expect(result.quantity).toBe(50)
    expect(result.capReason).toBe('atr-floor')
  })

  it('throws when kAtr is non-positive or non-finite', () => {
    expect(() => computePullbackSizing(baseInput({ kAtr: 0 }))).toThrow(/kAtr/)
    expect(() => computePullbackSizing(baseInput({ kAtr: -1 }))).toThrow(/kAtr/)
    expect(() => computePullbackSizing(baseInput({ kAtr: Number.NaN }))).toThrow(/kAtr/)
  })
})

describe('computePullbackSizing — fixed-% budget allocation (#budget-alloc)', () => {
  it('sizes by notional = equity * budgetAllocPct (bypasses risk-% / ATR floor)', () => {
    // 総資本 100k の 40% = 40,000 を price 35,000 で → floor(40000/35000) = 1 株。
    const result = computePullbackSizing(
      baseInput({ equity: 100_000, entryPrice: 35_000, budgetAllocPct: 0.4, atr20: 5000, baselineAtr20: 1000 }),
    )
    expect(result.quantity).toBe(1)
    expect(result.notional).toBe(35_000)
    // risk-% なら floor(400 / stop) = 0 株のはず。budget-alloc で 1 株建つ。
    expect(result.capped).toBe(false)
  })

  it('clamps to symbolCap when budget*pct exceeds it (min semantics)', () => {
    // 40% = 40,000 だが symbolCap 30,000 → min。floor(30000/10000)=3。
    const result = computePullbackSizing(
      baseInput({ equity: 100_000, entryPrice: 10_000, budgetAllocPct: 0.4, symbolCap: 30_000 }),
    )
    expect(result.quantity).toBe(3)
    expect(result.notional).toBe(30_000)
    expect(result.capReason).toBe('symbol-cap')
  })

  it('uses budget pct even when below symbolCap (% wins, abs is only a ceiling)', () => {
    // 20% = 20,000 < symbolCap 50,000 → 予算% を採用。floor(20000/10000)=2。
    const result = computePullbackSizing(
      baseInput({ equity: 100_000, entryPrice: 10_000, budgetAllocPct: 0.2, symbolCap: 50_000 }),
    )
    expect(result.quantity).toBe(2)
    expect(result.notional).toBe(20_000)
  })

  it('respects lot size in budget-alloc mode', () => {
    // 40% = 40,000、price 100、lot 100 → floor(400/100)*100 = 400。
    const result = computePullbackSizing(
      baseInput({ equity: 100_000, entryPrice: 100, budgetAllocPct: 0.4, lotSize: 100 }),
    )
    expect(result.quantity).toBe(400)
  })

  it('rejects (qty 0) when budget*pct is too small for one share', () => {
    // 1% = 1,000 だが price 35,000 → floor(1000/35000)=0。
    const result = computePullbackSizing(
      baseInput({ equity: 100_000, entryPrice: 35_000, budgetAllocPct: 0.01 }),
    )
    expect(result.quantity).toBe(0)
  })

  it('falls back to risk-% sizing when budgetAllocPct is undefined', () => {
    const result = computePullbackSizing(baseInput())
    expect(result.quantity).toBe(100) // 従来通り
  })
})
