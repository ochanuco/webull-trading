import { describe, expect, it } from 'vitest'
import {
  formatJpYmd,
  isTseSessionDay,
  isWithinSupportedRange,
} from '../../../src/infrastructure/calendar/jpMarketCalendar'

describe('formatJpYmd', () => {
  it('converts a UTC instant to its Asia/Tokyo calendar day (JST, UTC+9, no DST)', () => {
    // 20:00 UTC on Jan 1 is already 05:00 JST on Jan 2.
    expect(formatJpYmd(new Date('2026-01-01T20:00:00Z'))).toBe('2026-01-02')
  })

  it('throws on an unparseable date instead of the documented empty-string fail-closed result (suspected bug, see report)', () => {
    expect(() => formatJpYmd(new Date('not-a-date'))).toThrow(RangeError)
  })
})

describe('isWithinSupportedRange', () => {
  it('accepts a year in TSE_SUPPORTED_YEARS', () => {
    expect(isWithinSupportedRange(new Date('2026-06-15T03:00:00Z'))).toBe(true)
  })

  it('rejects a year outside TSE_SUPPORTED_YEARS', () => {
    expect(isWithinSupportedRange(new Date('2025-06-15T03:00:00Z'))).toBe(false)
    expect(isWithinSupportedRange(new Date('2027-06-15T03:00:00Z'))).toBe(false)
  })

  it('throws on an unparseable date instead of rejecting it (suspected bug, see report)', () => {
    expect(() => isWithinSupportedRange(new Date('not-a-date'))).toThrow(RangeError)
  })
})

describe('isTseSessionDay', () => {
  it('is true for an ordinary weekday with no holiday collision', () => {
    expect(isTseSessionDay(new Date('2026-06-15T03:00:00Z'))).toBe(true)
  })

  it('is false on a Saturday and a Sunday (JST)', () => {
    expect(isTseSessionDay(new Date('2026-06-13T03:00:00Z'))).toBe(false)
    expect(isTseSessionDay(new Date('2026-06-14T03:00:00Z'))).toBe(false)
  })

  it('is false on a TSE_CLOSURES holiday (秋分の日, a Wednesday)', () => {
    expect(isTseSessionDay(new Date('2026-09-23T03:00:00Z'))).toBe(false)
  })

  it('classifies by the JST calendar day, not the UTC calendar day, across the UTC midnight rollover', () => {
    // 2026-01-01T16:00Z is 2026-01-02 01:00 JST: 年始休業, even though the
    // Date's UTC date component is still 2026-01-01.
    expect(isTseSessionDay(new Date('2026-01-01T16:00:00Z'))).toBe(false)
    // 2026-01-01T10:00Z is 2026-01-01 19:00 JST: still 元日, also a holiday.
    expect(isTseSessionDay(new Date('2026-01-01T10:00:00Z'))).toBe(false)
    // The first non-holiday JST weekday after New Year (2026-01-05, Monday).
    expect(isTseSessionDay(new Date('2026-01-04T20:00:00Z'))).toBe(true)
  })

  it('is false outside TSE_SUPPORTED_YEARS even for an otherwise ordinary weekday', () => {
    expect(isTseSessionDay(new Date('2027-06-15T03:00:00Z'))).toBe(false)
  })

  it('throws on an unparseable date instead of failing closed (suspected bug, see report)', () => {
    expect(() => isTseSessionDay(new Date('not-a-date'))).toThrow(RangeError)
  })
})
