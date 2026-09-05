import { describe, expect, it } from 'vitest'
import {
  countTradingDaysBetween,
  evaluateStrategyWindow,
  HOLIDAYS,
  inferTradingMarket,
  isTradingDay,
  isUsMarketEarlyCloseDay,
  isUsMarketHoliday,
  isWithinRegularSession,
  isWithinStrategyWindow,
  isWithinUsCloseWindow,
  nextSessionOpen,
  nextTradingDay,
} from '../../../src/trading/domain/tradingCalendar'

/** `ymd` の ET 日中 (17:00Z = 12:00 EST / 13:00 EDT) — ET 暦日 == UTC 暦日 == ymd。 */
const etMidday = (ymd: string) => new Date(`${ymd}T17:00:00.000Z`)

/** `year` の全日を ET 日中 instant で走査し、predicate が true の ymd を集める。 */
function scanYear(year: number, predicate: (d: Date) => boolean): string[] {
  const hits: string[] = []
  for (
    let t = Date.UTC(year, 0, 1, 17);
    t < Date.UTC(year + 1, 0, 1);
    t += 86_400_000
  ) {
    const d = new Date(t)
    if (predicate(d)) hits.push(d.toISOString().slice(0, 10))
  }
  return hits
}

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

describe('isWithinRegularSession', () => {
  // 2026-04-20 は月曜、EDT (UTC-4) → 開場 09:30 ET = 13:30 UTC、引け 16:00 ET = 20:00 UTC。
  it('開場前 (09:29 ET) は false', () => {
    expect(isWithinRegularSession(new Date('2026-04-20T13:29:00.000Z'), 'US')).toBe(false)
  })
  it('開場 (09:30 ET) は inclusive で true', () => {
    expect(isWithinRegularSession(new Date('2026-04-20T13:30:00.000Z'), 'US')).toBe(true)
  })
  it('引け前 (15:59 ET) は true', () => {
    expect(isWithinRegularSession(new Date('2026-04-20T19:59:00.000Z'), 'US')).toBe(true)
  })
  it('引け (16:00 ET) は exclusive で false', () => {
    expect(isWithinRegularSession(new Date('2026-04-20T20:00:00.000Z'), 'US')).toBe(false)
  })
  it('半日取引日 (2026-11-27) は 13:00 ET 引けで false になる', () => {
    expect(isWithinRegularSession(new Date('2026-11-27T18:00:00.000Z'), 'US')).toBe(false) // 13:00 ET
  })
  it('祝日は false', () => {
    expect(isWithinRegularSession(new Date('2026-01-01T15:00:00.000Z'), 'US')).toBe(false) // 元日
  })
  it('JP: 開場前 (08:59 JST) は false、開場 (09:00 JST) は true', () => {
    // 2026-04-20(月) 08:59/09:00 JST = 2026-04-19T23:59/T00:00Z の前日 UTC 日跨ぎ。
    expect(isWithinRegularSession(new Date('2026-04-19T23:59:00.000Z'), 'JP')).toBe(false)
    expect(isWithinRegularSession(new Date('2026-04-20T00:00:00.000Z'), 'JP')).toBe(true)
  })
})

describe('isTradingDay', () => {
  it('invalid Date は fail-closed で false (US/JP とも)', () => {
    expect(isTradingDay(new Date('invalid'), 'US')).toBe(false)
    expect(isTradingDay(new Date('invalid'), 'JP')).toBe(false)
  })

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

// NYSE 公式カレンダーの既知休場日 (2026–2030)。assert 値は自前計算ではなく
// 公式カレンダー / 祝日規則の既知日 (#547 タスク指定の Good Friday 含む)。
// 2028 に New Year 休場が無いのは NYSE Rule 7.2 (1/1 が土曜 → 前年 12/31 に
// 振替しない) のため。
const NYSE_EXPECTED_CLOSURES: Record<number, string[]> = {
  2026: [
    '2026-01-01', // New Year's Day
    '2026-01-19', // MLK Day
    '2026-02-16', // Presidents' Day
    '2026-04-03', // Good Friday
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth
    '2026-07-03', // Independence Day observed (7/4 = 土)
    '2026-09-07', // Labor Day
    '2026-11-26', // Thanksgiving
    '2026-12-25', // Christmas
  ],
  2027: [
    '2027-01-01',
    '2027-01-18',
    '2027-02-15',
    '2027-03-26', // Good Friday
    '2027-05-31',
    '2027-06-18', // Juneteenth observed (6/19 = 土)
    '2027-07-05', // Independence Day observed (7/4 = 日)
    '2027-09-06',
    '2027-11-25',
    '2027-12-24', // Christmas observed (12/25 = 土)
  ],
  2028: [
    // New Year 休場なし (1/1 = 土、Rule 7.2)
    '2028-01-17',
    '2028-02-21',
    '2028-04-14', // Good Friday
    '2028-05-29',
    '2028-06-19',
    '2028-07-04',
    '2028-09-04',
    '2028-11-23',
    '2028-12-25',
  ],
  2029: [
    '2029-01-01',
    '2029-01-15',
    '2029-02-19',
    '2029-03-30', // Good Friday
    '2029-05-28',
    '2029-06-19',
    '2029-07-04',
    '2029-09-03',
    '2029-11-22',
    '2029-12-25',
  ],
  2030: [
    '2030-01-01',
    '2030-01-21',
    '2030-02-18',
    '2030-04-19', // Good Friday
    '2030-05-27',
    '2030-06-19',
    '2030-07-04',
    '2030-09-02',
    '2030-11-28',
    '2030-12-25',
  ],
}

describe('isUsMarketHoliday — NYSE 休場ルール計算 (#547)', () => {
  for (const [year, expected] of Object.entries(NYSE_EXPECTED_CLOSURES)) {
    it(`${year}: 年間走査が NYSE 公式カレンダーの休場日と完全一致する`, () => {
      expect(scanYear(Number(year), isUsMarketHoliday)).toEqual(expected)
    })
  }

  it('Good Friday (Computus): 2026–2030 の既知日', () => {
    for (const gf of ['2026-04-03', '2027-03-26', '2028-04-14', '2029-03-30', '2030-04-19']) {
      expect(isUsMarketHoliday(etMidday(gf)), gf).toBe(true)
    }
  })

  it('振替境界: 7/4=土→7/3休場、7/4=日→7/5休場、7/4=平日→7/4のみ', () => {
    // 2026: 7/4 土 → 7/3 (金) が休場。7/4 当日 (土) は observed でないので false。
    expect(isUsMarketHoliday(etMidday('2026-07-03'))).toBe(true)
    expect(isUsMarketHoliday(etMidday('2026-07-04'))).toBe(false)
    // 2027: 7/4 日 → 7/5 (月) が休場。前週金曜 7/2 は通常営業。
    expect(isUsMarketHoliday(etMidday('2027-07-05'))).toBe(true)
    expect(isUsMarketHoliday(etMidday('2027-07-02'))).toBe(false)
    // 2028: 7/4 火 (平日) → 休場は 7/4 のみ。7/3 (月) は半日取引であって休場ではない。
    expect(isUsMarketHoliday(etMidday('2028-07-04'))).toBe(true)
    expect(isUsMarketHoliday(etMidday('2028-07-03'))).toBe(false)
    expect(isUsMarketHoliday(etMidday('2028-07-05'))).toBe(false)
  })

  it('NYSE Rule 7.2: 1/1 が土曜でも前年 12/31 (金) は休場にしない', () => {
    // 2028-01-01 は土曜。実例: 2022-01-01 (土) に対し 2021-12-31 は通常立会。
    expect(isUsMarketHoliday(etMidday('2027-12-31'))).toBe(false)
    expect(isUsMarketHoliday(etMidday('2021-12-31'))).toBe(false)
  })

  it('判定は America/New_York 暦日基準 (UTC 日付をそのまま使わない)', () => {
    // 2026-07-04T02:00Z = ET では 7/3 (金) 22:00 → 休場日
    expect(isUsMarketHoliday(new Date('2026-07-04T02:00:00.000Z'))).toBe(true)
    // 2026-07-03T03:00Z = ET では 7/2 (木) 23:00 → 通常営業日
    expect(isUsMarketHoliday(new Date('2026-07-03T03:00:00.000Z'))).toBe(false)
  })

  it('static HOLIDAYS.US テーブル (NYSE_CLOSURES re-export 用) とルールが一致する', () => {
    for (const year of [2026, 2027]) {
      const fromTable = [...HOLIDAYS.US].filter((d) => d.startsWith(String(year))).sort()
      expect(scanYear(year, isUsMarketHoliday)).toEqual(fromTable)
    }
  })

  it('invalid Date は false (呼び出し側の窓判定で fail-closed)', () => {
    expect(isUsMarketHoliday(new Date(Number.NaN))).toBe(false)
  })
})

describe('isUsMarketEarlyCloseDay — 半日取引 (13:00 ET close) ルール計算 (#547)', () => {
  const EXPECTED_EARLY_CLOSE: Record<number, string[]> = {
    2026: ['2026-11-27', '2026-12-24'], // 7/3 は全日休場側 (7/4=土)
    2027: ['2027-11-26'], // 7/3=土、12/24 は Christmas observed で全日休場側
    2028: ['2028-07-03', '2028-11-24'], // 12/25=月 → 12/24 は日曜で対象外
    2029: ['2029-07-03', '2029-11-23', '2029-12-24'],
    2030: ['2030-07-03', '2030-11-29', '2030-12-24'],
  }

  for (const [year, expected] of Object.entries(EXPECTED_EARLY_CLOSE)) {
    it(`${year}: 年間走査が既知の半日取引日と完全一致する`, () => {
      expect(scanYear(Number(year), isUsMarketEarlyCloseDay)).toEqual(expected)
    })
  }

  it('全日休場と半日取引は排他 (7/3・12/24 の振替年)', () => {
    expect(isUsMarketEarlyCloseDay(etMidday('2026-07-03'))).toBe(false) // 全日休場
    expect(isUsMarketEarlyCloseDay(etMidday('2027-12-24'))).toBe(false) // 全日休場
    expect(isUsMarketEarlyCloseDay(etMidday('2028-07-03'))).toBe(true)
  })
})

describe('evaluateStrategyWindow — 休場 / 半日取引 (#547)', () => {
  it('US 祝日 (2026-07-03 振替休場) は窓内時刻でも market_holiday', () => {
    expect(evaluateStrategyWindow(etMidday('2026-07-03'), 'US', 30)).toBe('market_holiday')
    expect(isWithinStrategyWindow(etMidday('2026-07-03'), 'US', 30)).toBe(false)
  })
  it('JP 祝日は market_holiday (static テーブル)', () => {
    // 2026-05-04(月) みどりの日、10:00 JST。
    expect(evaluateStrategyWindow(new Date('2026-05-04T01:00:00.000Z'), 'JP', 30)).toBe(
      'market_holiday',
    )
  })
  it('土日・時間外は従来通り outside_window (休場ラベルにしない)', () => {
    expect(evaluateStrategyWindow(new Date('2026-04-18T16:00:00.000Z'), 'US', 30)).toBe(
      'outside_window',
    ) // 土曜
    expect(evaluateStrategyWindow(new Date('2026-04-20T06:00:00.000Z'), 'US', 30)).toBe(
      'outside_window',
    ) // 02:00 ET
  })
  it('通常取引日の日中は in_window', () => {
    expect(evaluateStrategyWindow(new Date('2026-04-20T17:00:00.000Z'), 'US', 30)).toBe(
      'in_window',
    )
  })
  it('Rule 7.2: 2027-12-31 (金) は通常営業として in_window', () => {
    expect(evaluateStrategyWindow(etMidday('2027-12-31'), 'US', 30)).toBe('in_window')
  })
  it('半日取引日 (2026-11-27) は引けが 13:00 ET に短縮される', () => {
    // EST (UTC-5): 12:59 ET = 17:59Z は窓内、13:00 ET = 18:00Z は窓外。
    expect(evaluateStrategyWindow(new Date('2026-11-27T17:59:00.000Z'), 'US', 30)).toBe(
      'in_window',
    )
    expect(evaluateStrategyWindow(new Date('2026-11-27T18:00:00.000Z'), 'US', 30)).toBe(
      'outside_window',
    )
    // 比較: 通常日 (2026-11-30 月) の 13:00 ET は窓内のまま。
    expect(evaluateStrategyWindow(new Date('2026-11-30T18:00:00.000Z'), 'US', 30)).toBe(
      'in_window',
    )
  })
})

describe('isWithinUsCloseWindow — 半日取引 (#547)', () => {
  it('半日取引日は 13:00 ET 引け基準の窓になる', () => {
    // 2026-11-27 (感謝祭翌日、EST)。窓 = [12:45, 13:00 ET)。
    expect(isWithinUsCloseWindow(new Date('2026-11-27T17:50:00.000Z'), 15)).toBe(true) // 12:50 ET
    expect(isWithinUsCloseWindow(new Date('2026-11-27T18:00:00.000Z'), 15)).toBe(false) // 13:00 ET
    // 16:00 ET 基準の旧窓 (15:50 ET) は半日取引日には当たらない。
    expect(isWithinUsCloseWindow(new Date('2026-11-27T20:50:00.000Z'), 15)).toBe(false)
  })
})

describe('isTradingDay / nextTradingDay — US ルール計算化で 2028 以降も判定 (#547)', () => {
  it('2028 の祝日 (旧 static テーブル範囲外) を休場と判定する', () => {
    expect(isTradingDay(new Date('2028-07-04T10:00:00.000Z'), 'US')).toBe(false)
    expect(isTradingDay(new Date('2028-11-23T10:00:00.000Z'), 'US')).toBe(false)
    expect(isTradingDay(new Date('2028-07-05T10:00:00.000Z'), 'US')).toBe(true)
  })
  it('US: 2027-12-30 (木) の翌営業日は 2027-12-31 (Rule 7.2 で営業)', () => {
    expect(
      nextTradingDay(new Date('2027-12-30T10:00:00.000Z'), 'US').toISOString().slice(0, 10),
    ).toBe('2027-12-31')
  })
})

describe('nextSessionOpen (#661)', () => {
  it('US 平日 (EDT): 2026-08-04 (火) 18:00Z exit → 翌日 2026-08-05 09:30 EDT', () => {
    expect(nextSessionOpen(new Date('2026-08-04T18:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-08-05T13:30:00.000Z',
    )
  })

  it('US 平日 (EST / 冬時間): 2026-01-06 (火) exit → 翌日 2026-01-07 09:30 EST', () => {
    expect(nextSessionOpen(new Date('2026-01-06T20:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-01-07T14:30:00.000Z',
    )
  })

  it('DST spring-forward: 2026-03-06 (金, EST) exit → 2026-03-09 (月) は EDT で 09:30=13:30Z', () => {
    // 2026-03-08 (日) が切替日。金曜は EST、月曜は EDT — offset をまたぐ。
    expect(nextSessionOpen(new Date('2026-03-06T20:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-03-09T13:30:00.000Z',
    )
  })

  it('DST fall-back: 2026-10-30 (金, EDT) exit → 2026-11-02 (月) は EST で 09:30=14:30Z', () => {
    // 2026-11-01 (日) が切替日。金曜は EDT、月曜は EST — offset をまたぐ。
    expect(nextSessionOpen(new Date('2026-10-30T20:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-11-02T14:30:00.000Z',
    )
  })

  it('金曜 exit → 月曜の寄り (週末 skip)', () => {
    expect(nextSessionOpen(new Date('2026-04-17T20:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-04-20T13:30:00.000Z',
    )
  })

  it('US 祝日 skip: 2025-12-31 (水) exit → 元日 (木) を跳ばして 2026-01-02 (金) 09:30 EST', () => {
    expect(nextSessionOpen(new Date('2025-12-31T20:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-01-02T14:30:00.000Z',
    )
  })

  it('US: 寄り前 exit (08:00 ET) でも当日ではなく翌取引日の寄りを返す', () => {
    // 2026-08-04T12:00:00.000Z = 08:00 EDT (当日の寄り 13:30Z より前)。
    expect(nextSessionOpen(new Date('2026-08-04T12:00:00.000Z'), 'US').toISOString()).toBe(
      '2026-08-05T13:30:00.000Z',
    )
  })

  it('JP 平日: 2026-04-15 (水) exit → 翌日 2026-04-16 09:00 JST = 00:00Z', () => {
    expect(nextSessionOpen(new Date('2026-04-15T10:00:00.000Z'), 'JP').toISOString()).toBe(
      '2026-04-16T00:00:00.000Z',
    )
  })

  it('JP 夜間 (UTC 日付ズレ): 2026-04-19T23:30Z (=月曜 08:30 JST) exit → 当日ではなく翌営業日 (火) の寄り', () => {
    // JST 暦日は月曜 (2026-04-20) だが UTC 暦日は日曜 (2026-04-19)。UTC 日付基準で
    // 判定すると誤って月曜を「翌日」扱いしてしまう回帰ケース — JST 暦日で
    // 月曜を当日とみなし、翌営業日である火曜 (2026-04-21) 09:00 JST を返すべき。
    expect(nextSessionOpen(new Date('2026-04-19T23:30:00.000Z'), 'JP').toISOString()).toBe(
      '2026-04-21T00:00:00.000Z',
    )
  })

  it('JP 年末年始: 2026-12-30 (水) exit → 2027-01-04 (月) 09:00 JST = 00:00Z', () => {
    // 12/31 TSE closed, 1/1 元日, 1/2 (土), 1/3 (日) → 翌営業日は 1/4 (月)。
    expect(nextSessionOpen(new Date('2026-12-30T10:00:00.000Z'), 'JP').toISOString()).toBe(
      '2027-01-04T00:00:00.000Z',
    )
  })
})
