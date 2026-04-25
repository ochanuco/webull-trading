import { describe, expect, it } from 'vitest'
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from '../../../src/trading/strategy/indicators'

function makeBars(closes: number[]): DailyBar[] {
  return closes.map((close, i) => {
    const iso = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
    return { date: iso, open: close, high: close * 1.01, low: close * 0.99, close }
  })
}

describe('computePullbackIndicators', () => {
  it('returns null when fewer than 50 bars are provided', () => {
    expect(computePullbackIndicators(makeBars([1, 2, 3]))).toBeNull()
  })

  it('computes sma50 / return50d / high20d / low20d from the tail window', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const result = computePullbackIndicators(makeBars(closes))
    expect(result).not.toBeNull()
    const r = result!
    expect(r.price).toBe(159)
    // sma50 = average of closes 110..159 = (110+159)/2 = 134.5
    expect(r.sma50).toBeCloseTo(134.5, 4)
    // 50d return: last vs closes[-50] = closes[10] = 110 → (159 - 110)/110
    expect(r.return50d).toBeCloseTo((159 - 110) / 110, 4)
    // high20d = max of highs for last 20 bars. highs are close*1.01.
    expect(r.high20d).toBeCloseTo(159 * 1.01, 4)
    // low20d = min of lows for last 20 bars. lows are close*0.99, last 20 closes
    // are 140..159 → min = 140 * 0.99
    expect(r.low20d).toBeCloseTo(140 * 0.99, 4)
  })

  it('low20d picks the smallest low even when not the most recent bar', () => {
    // 60 closes mostly increasing, but last 20 includes a dip to enforce the
    // 20-bar window semantics. Set bar[55].low artificially low.
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const bars = makeBars(closes)
    bars[55]!.low = 50 // dip in last 20
    const r = computePullbackIndicators(bars)!
    expect(r.low20d).toBeCloseTo(50, 4)
  })
})

describe('computeHoldBusinessDays', () => {
  it('counts weekday-only days between open and now (US)', () => {
    // Mon 2026-04-13 open, Fri 2026-04-17 now → 4 business days
    expect(
      computeHoldBusinessDays(
        '2026-04-13T10:00:00.000Z',
        new Date('2026-04-17T10:00:00.000Z'),
        'US',
      ),
    ).toBe(4)
  })

  it('skips weekends (US)', () => {
    // Fri open, next Mon now → 1 business day (weekend does not count)
    expect(
      computeHoldBusinessDays(
        '2026-04-17T10:00:00.000Z',
        new Date('2026-04-20T10:00:00.000Z'),
        'US',
      ),
    ).toBe(1)
  })

  it('returns 0 for an invalid ISO', () => {
    expect(computeHoldBusinessDays('not-a-date', new Date(), 'US')).toBe(0)
  })
})
