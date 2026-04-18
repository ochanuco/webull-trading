import { describe, expect, it } from 'vitest'
import { isWithinJpPriceBand, jpPriceBand } from '../../../src/trading/risk/jpPriceBand'

describe('jpPriceBand approximation table', () => {
  it('returns a ±80 band around a 500 yen reference price', () => {
    const band = jpPriceBand(500)
    expect(band.upper).toBe(580)
    expect(band.lower).toBe(420)
  })

  it('returns a ±700 band around a 5000 yen reference price', () => {
    const band = jpPriceBand(5_000)
    expect(band.upper).toBe(5_700)
    expect(band.lower).toBe(4_300)
  })

  it('clamps lower bound at zero so tiny reference prices do not underflow', () => {
    const band = jpPriceBand(50)
    expect(band.lower).toBe(20)
    expect(band.upper).toBe(80)
  })

  it('falls back to an extreme band when reference price exceeds the table', () => {
    const band = jpPriceBand(50_000_000)
    expect(band.upper - band.lower).toBeGreaterThan(0)
  })
})

describe('isWithinJpPriceBand', () => {
  it('accepts an in-band order at 500 yen reference', () => {
    expect(isWithinJpPriceBand(500, 560)).toBe(true)
    expect(isWithinJpPriceBand(500, 420)).toBe(true)
  })

  it('rejects an out-of-band order at 500 yen reference', () => {
    expect(isWithinJpPriceBand(500, 600)).toBe(false)
    expect(isWithinJpPriceBand(500, 400)).toBe(false)
  })

  it('accepts an in-band order at 5000 yen reference', () => {
    expect(isWithinJpPriceBand(5_000, 5_600)).toBe(true)
    expect(isWithinJpPriceBand(5_000, 4_400)).toBe(true)
  })

  it('rejects an out-of-band order at 5000 yen reference', () => {
    expect(isWithinJpPriceBand(5_000, 5_800)).toBe(false)
    expect(isWithinJpPriceBand(5_000, 4_200)).toBe(false)
  })

  it('skips the check (returns true) when reference price is invalid', () => {
    expect(isWithinJpPriceBand(0, 500)).toBe(true)
    expect(isWithinJpPriceBand(Number.NaN, 500)).toBe(true)
  })
})
