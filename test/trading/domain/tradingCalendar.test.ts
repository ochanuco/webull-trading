import { describe, expect, it } from 'vitest'
import {
  countTradingDaysBetween,
  inferTradingMarket,
  isTradingDay,
  isWithinStrategyWindow,
  isWithinUsCloseWindow,
  nextTradingDay,
} from '../../../src/trading/domain/tradingCalendar'

describe('isWithinUsCloseWindow (#intraday-only)', () => {
  // 2026-04-20 は月曜 (US 取引日)、EDT (UTC-4) → NYSE 引け 16:00 ET = 20:00 UTC。
  it('true within the window before US close (EDT / summer)', () => {
    expect(isWithinUsCloseWindow(new Date('2026-04-20T19:50:00.000Z'), 15)).toBe(true) // 15:50 ET
    expect(isWithinUsCloseWindow(new Date('2026-04-20T19:55:00.000Z'), 15)).toBe(true) // 15:55 ET
  })
  it('false before the window opens / after close', () => {
    expect(isWithinUsCloseWindow(new Date('2026-04-20T19:40:00.000Z'), 15)).toBe(false) // 15:40 ET (>15分前)
    expect(isWithinUsCloseWindow(new Date('2026-04-20T20:05:00.000Z'), 15)).toBe(false) // 16:05 ET (引け後)
    expect(isWithinUsCloseWindow(new Date('2026-04-20T14:30:00.000Z'), 15)).toBe(false) // 10:30 ET (日中)
  })
  it('DST-safe: EST (winter) uses 21:00 UTC close', () => {
    // 2026-01-05 は月曜、EST (UTC-5) → 引け 16:00 ET = 21:00 UTC。
    expect(isWithinUsCloseWindow(new Date('2026-01-05T20:50:00.000Z'), 15)).toBe(true) // 15:50 ET
    expect(isWithinUsCloseWindow(new Date('2026-01-05T19:50:00.000Z'), 15)).toBe(false) // 14:50 ET (夏時間の窓は冬は外れる)
  })
  it('false on weekends / holidays / invalid window', () => {
    expect(isWithinUsCloseWindow(new Date('2026-04-18T19:50:00.000Z'), 15)).toBe(false) // 土曜
    expect(isWithinUsCloseWindow(new Date('2026-01-01T20:50:00.000Z'), 15)).toBe(false) // 元日 (US 祝日)
    expect(isWithinUsCloseWindow(new Date('2026-04-20T19:50:00.000Z'), 0)).toBe(false) // window<=0
  })
})

describe('isWithinStrategyWindow — US (#session-window-gate)', () => {
  // 2026-04-20 は月曜、EDT (UTC-4) → 開場 09:30 ET = 13:30 UTC、引け 16:00 ET = 20:00 UTC。
  // 窓 = [09:00 ET, 16:00 ET) (minutesBeforeOpen=30)。
  it('開場30分前 (09:00 ET) は inclusive で true', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-20T13:00:00.000Z'), 'US', 30)).toBe(true) // 09:00 ET
  })
  it('窓の前 (08:59 ET) は false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-20T12:59:00.000Z'), 'US', 30)).toBe(false) // 08:59 ET
  })
  it('日中 (12:00 ET) は true、引け (16:00 ET) は exclusive で false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-20T16:00:00.000Z'), 'US', 30)).toBe(true) // 12:00 ET
    expect(isWithinStrategyWindow(new Date('2026-04-20T19:59:00.000Z'), 'US', 30)).toBe(true) // 15:59 ET
    expect(isWithinStrategyWindow(new Date('2026-04-20T20:00:00.000Z'), 'US', 30)).toBe(false) // 16:00 ET
  })
  it('DST-safe: 13:00 UTC は夏 (EDT) で 09:00 ET=true、冬 (EST) は 08:00 ET=false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-20T13:00:00.000Z'), 'US', 30)).toBe(true) // EDT 09:00
    expect(isWithinStrategyWindow(new Date('2026-01-05T13:00:00.000Z'), 'US', 30)).toBe(false) // EST 08:00
    expect(isWithinStrategyWindow(new Date('2026-01-05T14:00:00.000Z'), 'US', 30)).toBe(true) // EST 09:00
  })
  it('週末 / 祝日 / 負の offset は false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-18T16:00:00.000Z'), 'US', 30)).toBe(false) // 土曜
    expect(isWithinStrategyWindow(new Date('2026-01-01T14:30:00.000Z'), 'US', 30)).toBe(false) // 元日
    expect(isWithinStrategyWindow(new Date('2026-04-20T13:00:00.000Z'), 'US', -1)).toBe(false) // offset<0
  })
  it('minutesBeforeOpen=0 は開場 (09:30 ET) ちょうどから', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-20T13:00:00.000Z'), 'US', 0)).toBe(false) // 09:00 ET
    expect(isWithinStrategyWindow(new Date('2026-04-20T13:30:00.000Z'), 'US', 0)).toBe(true) // 09:30 ET
  })
})

describe('isWithinStrategyWindow — JP (#session-window-gate)', () => {
  // JST = UTC+9 (DST なし)。開場 09:00 JST、引け 15:30 JST。窓 = [08:30 JST, 15:30 JST)。
  it('回帰: 月曜 08:30 JST (=前日 23:30 UTC) で true (UTC 日付ズレを跨ぐ)', () => {
    // 2026-04-20(月) 08:30 JST = 2026-04-19T23:30Z (UTC は日曜) でも JP 取引日として true。
    expect(isWithinStrategyWindow(new Date('2026-04-19T23:30:00.000Z'), 'JP', 30)).toBe(true)
  })
  it('窓の前 (08:29 JST) は false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-19T23:29:00.000Z'), 'JP', 30)).toBe(false)
  })
  it('引け前 (15:29 JST) true / 引け (15:30 JST) は exclusive で false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-20T06:29:00.000Z'), 'JP', 30)).toBe(true) // 15:29 JST
    expect(isWithinStrategyWindow(new Date('2026-04-20T06:30:00.000Z'), 'JP', 30)).toBe(false) // 15:30 JST
  })
  it('週末は false', () => {
    expect(isWithinStrategyWindow(new Date('2026-04-18T03:00:00.000Z'), 'JP', 30)).toBe(false) // 土曜 12:00 JST
  })
  it('祝日は JST 日付で判定 (08:30 JST が前日 UTC でも休)', () => {
    // 2026-05-04(月) みどりの日。10:00 JST = 同日 UTC。
    expect(isWithinStrategyWindow(new Date('2026-05-04T01:00:00.000Z'), 'JP', 30)).toBe(false)
    // 08:30 JST = 前日 (05-03) UTC でも、祝日判定は JST 日付 (05-04) を見るので false。
    expect(isWithinStrategyWindow(new Date('2026-05-03T23:30:00.000Z'), 'JP', 30)).toBe(false)
  })
})

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
