/**
 * TSE (JP equity) session-day calendar. Design mirrors `usMarketCalendar.ts`
 * (see its header comment) — used to skip the daily-roll cron when the next
 * JP calendar day is a weekend/holiday. Holiday data lives in
 * `src/trading/domain/tradingCalendar.ts`'s `TSE_CLOSURES`.
 */

import { TSE_CLOSURES } from '../../trading/domain/tradingCalendar'

/** Hard-coded holiday data の有効年セット。範囲外は呼び出し側で fail-closed。 */
const TSE_SUPPORTED_YEARS: ReadonlySet<number> = new Set([2026])

// See usMarketCalendar.ts for why formatToParts is used over `.format()`.
const JP_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const JP_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  weekday: 'short',
})

interface YmdParts {
  ymd: string
  year: number
}

function extractJpYmdParts(date: Date): YmdParts | null {
  let year = ''
  let month = ''
  let day = ''
  for (const part of JP_YMD_FORMATTER.formatToParts(date)) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  if (!year || !month || !day) return null
  const yearInt = Number.parseInt(year, 10)
  if (!Number.isFinite(yearInt)) return null
  return { ymd: `${year}-${month}-${day}`, year: yearInt }
}

/** Empty string on an unparseable date, which `isTseSessionDay` treats as fail-closed (false). */
export function formatJpYmd(date: Date): string {
  return extractJpYmdParts(date)?.ymd ?? ''
}

export function isWithinSupportedRange(date: Date): boolean {
  const parts = extractJpYmdParts(date)
  if (!parts) return false
  return TSE_SUPPORTED_YEARS.has(parts.year)
}

/** JP calendar day is a TSE session day (weekday, not a holiday, within `TSE_SUPPORTED_YEARS`). */
export function isTseSessionDay(date: Date): boolean {
  if (!isWithinSupportedRange(date)) return false
  const ymd = formatJpYmd(date)
  if (TSE_CLOSURES.has(ymd)) return false
  const weekday = JP_WEEKDAY_FORMATTER.format(date)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return true
}
