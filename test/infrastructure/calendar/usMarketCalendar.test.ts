import { describe, expect, it } from 'vitest'
import { NYSE_CLOSURES } from '../../../src/trading/domain/tradingCalendar'
import {
  formatNyYmd,
  isNyseSessionDay,
  isWithinSupportedRange,
} from '../../../src/infrastructure/calendar/usMarketCalendar'

describe('formatNyYmd', () => {
  it('converts a UTC instant to its America/New_York calendar day, not the UTC date', () => {
    // 04:30 UTC in EST (winter, UTC-5) is still the previous NY calendar day.
    expect(formatNyYmd(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14')
  })

  it('applies the DST offset (EDT, UTC-4) rather than a fixed UTC-5 offset', () => {
    // Same 04:30 UTC clock time, but in summer (EDT) it lands on the same NY day.
    expect(formatNyYmd(new Date('2026-07-15T04:30:00Z'))).toBe('2026-07-15')
  })

  it('rolls the NY calendar day forward across the spring-forward instant (2026-03-08 02:00 EST -> 03:00 EDT)', () => {
    expect(formatNyYmd(new Date('2026-03-08T04:59:00Z'))).toBe('2026-03-07')
    expect(formatNyYmd(new Date('2026-03-08T07:01:00Z'))).toBe('2026-03-08')
  })

  it('throws RangeError on an unparseable date', () => {
    expect(() => formatNyYmd(new Date('not-a-date'))).toThrow(RangeError)
  })
})

describe('isWithinSupportedRange', () => {
  it('supports every year that has closure data, so a year added to NYSE_CLOSURES cannot be left unsupported', () => {
    const years = new Set([...NYSE_CLOSURES].map((ymd) => ymd.slice(0, 4)))
    for (const year of years) {
      expect(isWithinSupportedRange(new Date(`${year}-06-15T12:00:00Z`)), year).toBe(true)
    }
  })

  it('accepts 2027', () => {
    expect(isWithinSupportedRange(new Date('2027-06-15T12:00:00Z'))).toBe(true)
  })

  it('accepts a year in NYSE_SUPPORTED_YEARS', () => {
    expect(isWithinSupportedRange(new Date('2026-06-15T12:00:00Z'))).toBe(true)
  })

  it('rejects a year outside NYSE_SUPPORTED_YEARS', () => {
    expect(isWithinSupportedRange(new Date('2025-06-15T12:00:00Z'))).toBe(false)
    expect(isWithinSupportedRange(new Date('2028-06-15T12:00:00Z'))).toBe(false)
  })

  it('throws RangeError on an unparseable date', () => {
    expect(() => isWithinSupportedRange(new Date('not-a-date'))).toThrow(RangeError)
  })
})

describe('isNyseSessionDay', () => {
  it('is true for an ordinary weekday with no holiday collision', () => {
    expect(isNyseSessionDay(new Date('2026-06-15T15:00:00Z'))).toBe(true)
  })

  it('is false on a Saturday and a Sunday', () => {
    expect(isNyseSessionDay(new Date('2026-06-13T15:00:00Z'))).toBe(false)
    expect(isNyseSessionDay(new Date('2026-06-14T15:00:00Z'))).toBe(false)
  })

  it('is false on an NYSE_CLOSURES holiday (Juneteenth, a Friday)', () => {
    expect(isNyseSessionDay(new Date('2026-06-19T15:00:00Z'))).toBe(false)
  })

  it('classifies by the NY calendar day, not the UTC calendar day: 2026-01-02T03:00Z is still 2026-01-01 22:00 EST, the New Year holiday, though the Date is UTC-dated Jan 2 (a non-holiday Friday)', () => {
    expect(isNyseSessionDay(new Date('2026-01-02T03:00:00Z'))).toBe(false)
  })

  it('is false outside NYSE_SUPPORTED_YEARS even for an otherwise ordinary weekday', () => {
    expect(isNyseSessionDay(new Date('2028-06-15T15:00:00Z'))).toBe(false)
  })

  it('throws RangeError on an unparseable date', () => {
    expect(() => isNyseSessionDay(new Date('not-a-date'))).toThrow(RangeError)
  })
})
