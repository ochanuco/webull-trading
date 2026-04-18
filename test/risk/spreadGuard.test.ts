import { describe, expect, it } from 'vitest'
import { computeSpreadPct, isSpreadWithinLimit } from '../../src/trading/risk/spreadGuard'

describe('computeSpreadPct', () => {
  it('returns (ask-bid)/mid for a normal book', () => {
    // bid 99.9, ask 100.1 -> mid 100, spread 0.2, pct 0.002
    const pct = computeSpreadPct(99.9, 100.1)
    expect(pct).not.toBeNull()
    expect(pct!).toBeCloseTo(0.002, 10)
  })

  it('returns 0 when bid equals ask (tight/locked book)', () => {
    expect(computeSpreadPct(100, 100)).toBe(0)
  })

  it('returns null when bid is zero or negative', () => {
    expect(computeSpreadPct(0, 100)).toBeNull()
    expect(computeSpreadPct(-1, 100)).toBeNull()
  })

  it('returns null when ask is zero or negative', () => {
    expect(computeSpreadPct(100, 0)).toBeNull()
    expect(computeSpreadPct(100, -1)).toBeNull()
  })

  it('returns null for a crossed book (ask < bid)', () => {
    expect(computeSpreadPct(101, 100)).toBeNull()
  })

  it('returns null for non-finite inputs', () => {
    expect(computeSpreadPct(Number.NaN, 100)).toBeNull()
    expect(computeSpreadPct(100, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('isSpreadWithinLimit', () => {
  it('returns true when spread is within limit', () => {
    // spread 0.2% <= 0.25% limit
    expect(isSpreadWithinLimit(99.9, 100.1, 0.0025)).toBe(true)
  })

  it('returns true when spread equals limit exactly', () => {
    // 99.875 / 100.125 -> mid 100, spread 0.25, pct 0.0025
    expect(isSpreadWithinLimit(99.875, 100.125, 0.0025)).toBe(true)
  })

  it('returns false when spread exceeds limit', () => {
    // 99.85 / 100.15 -> pct 0.003 > 0.0025
    expect(isSpreadWithinLimit(99.85, 100.15, 0.0025)).toBe(false)
  })

  it('fail-closed on degenerate book', () => {
    expect(isSpreadWithinLimit(0, 100, 0.01)).toBe(false)
    expect(isSpreadWithinLimit(101, 100, 0.01)).toBe(false)
  })

  it('fail-closed on invalid limit', () => {
    expect(isSpreadWithinLimit(99.9, 100.1, -0.01)).toBe(false)
    expect(isSpreadWithinLimit(99.9, 100.1, Number.NaN)).toBe(false)
  })
})
