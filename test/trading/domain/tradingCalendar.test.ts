import { describe, expect, it } from 'vitest'
import {
  countTradingDaysBetween,
  inferTradingMarket,
  isTradingDay,
  nextTradingDay,
} from '../../../src/trading/domain/tradingCalendar'

describe('isTradingDay', () => {
  it('returns false for weekends', () => {
    // Sat
    expect(isTradingDay(new Date('2026-04-18T10:00:00.000Z'), 'US')).toBe(false)
    // Sun
    expect(isTradingDay(new Date('2026-04-19T10:00:00.000Z'), 'JP')).toBe(false)
  })

  it('returns false for JP/US holidays', () => {
    // 2026-01-01 (Thu) US New Year's Day
    expect(isTradingDay(new Date('2026-01-01T10:00:00.000Z'), 'US')).toBe(false)
    // 2026-05-04 (Mon) JP みどりの日
    expect(isTradingDay(new Date('2026-05-04T10:00:00.000Z'), 'JP')).toBe(false)
  })

  it('returns true for plain weekdays', () => {
    // Wed 2026-04-15
    expect(isTradingDay(new Date('2026-04-15T10:00:00.000Z'), 'US')).toBe(true)
    expect(isTradingDay(new Date('2026-04-15T10:00:00.000Z'), 'JP')).toBe(true)
  })
})

describe('nextTradingDay — year-end / new year roll', () => {
  it('JP: 2026-12-30 (Wed) → 2027-01-04 (Mon) skipping 12/31 + 年始', () => {
    // 2026-12-31 (Thu) TSE closed, 2027-01-01 (Fri) 元日,
    // 2027-01-02 (Sat), 2027-01-03 (Sun) → next trading day is 2027-01-04 (Mon).
    const tue = new Date('2026-12-30T10:00:00.000Z')
    expect(nextTradingDay(tue, 'JP').toISOString().slice(0, 10)).toBe('2027-01-04')
  })

  it('US: 2025-12-31 (Wed) → 2026-01-02 (Fri) skipping New Year Day', () => {
    const wed = new Date('2025-12-31T10:00:00.000Z')
    expect(nextTradingDay(wed, 'US').toISOString().slice(0, 10)).toBe('2026-01-02')
  })
})

describe('nextTradingDay — Golden Week', () => {
  it('JP: 2026-05-01 (Fri) → 2026-05-07 (Thu) skipping GW', () => {
    // 5/2 Sat, 5/3 Sun, 5/4 Mon みどりの日, 5/5 Tue こどもの日,
    // 5/6 Wed 振替休日 (5/3 が Sun) → next trading day is 5/7 Thu.
    const fri = new Date('2026-05-01T10:00:00.000Z')
    expect(nextTradingDay(fri, 'JP').toISOString().slice(0, 10)).toBe('2026-05-07')
  })
})

describe('countTradingDaysBetween — excludes holidays', () => {
  it('JP: 2026-04-28 (Tue) → 2026-05-07 (Thu) counts 3 trading days', () => {
    // Cursor から翌日以降をカウント:
    // 4/29 Wed 昭和の日 ✗ / 4/30 Thu ○ / 5/1 Fri ○ / 5/2 Sat ✗ /
    // 5/3 Sun ✗ / 5/4 Mon ✗ / 5/5 Tue ✗ / 5/6 Wed ✗ / 5/7 Thu ○ → 3
    expect(
      countTradingDaysBetween(
        '2026-04-28T10:00:00.000Z',
        new Date('2026-05-07T10:00:00.000Z'),
        'JP',
      ),
    ).toBe(3)
  })

  it('US: 2026-06-18 (Thu) → 2026-06-22 (Mon) skips Juneteenth 6/19', () => {
    // 6/19 Fri Juneteenth ✗ / 6/20 Sat ✗ / 6/21 Sun ✗ / 6/22 Mon ○ → 1
    expect(
      countTradingDaysBetween(
        '2026-06-18T10:00:00.000Z',
        new Date('2026-06-22T10:00:00.000Z'),
        'US',
      ),
    ).toBe(1)
  })

  it('returns 0 for invalid ISO', () => {
    expect(countTradingDaysBetween('not-a-date', new Date(), 'US')).toBe(0)
  })
})

describe('inferTradingMarket', () => {
  it('treats 4-digit symbols as JP', () => {
    expect(inferTradingMarket('7203')).toBe('JP')
  })
  it('treats alphabetic symbols as US', () => {
    expect(inferTradingMarket('SOXL')).toBe('US')
    expect(inferTradingMarket('AAPL')).toBe('US')
  })
})
