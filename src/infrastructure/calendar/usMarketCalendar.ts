/**
 * NYSE (US equity) session-day calendar. Used to skip the daily-roll cron on
 * weekends/holidays it would otherwise fire on, so `lastRolledAt` only
 * advances on real session boundaries. Holiday data itself lives in
 * `src/trading/domain/tradingCalendar.ts`'s `NYSE_CLOSURES` (single source
 * of truth) — this module only adds tz-aware (America/New_York) session-day
 * classification and its own `NYSE_SUPPORTED_YEARS` range guard.
 */

import { NYSE_CLOSURES } from '../../trading/domain/tradingCalendar'

/** Hard-coded holiday data の有効年セット。範囲外は呼び出し側で fail-closed。 */
const NYSE_SUPPORTED_YEARS: ReadonlySet<number> = new Set([2026])

// `Intl.DateTimeFormat#format`'s output ordering/separators are
// implementation-dependent per ECMA-402; formatToParts avoids depending on
// a specific runtime/ICU build producing YYYY-MM-DD from `en-CA`.
const NY_YMD_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const NY_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
})

interface YmdParts {
  ymd: string
  year: number
}

function extractNyYmdParts(date: Date): YmdParts | null {
  let year = ''
  let month = ''
  let day = ''
  for (const part of NY_YMD_FORMATTER.formatToParts(date)) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  if (!year || !month || !day) return null
  const yearInt = Number.parseInt(year, 10)
  if (!Number.isFinite(yearInt)) return null
  return { ymd: `${year}-${month}-${day}`, year: yearInt }
}

/** Empty string on an unparseable date, which `isNyseSessionDay` treats as fail-closed (false). */
export function formatNyYmd(date: Date): string {
  return extractNyYmdParts(date)?.ymd ?? ''
}

export function isWithinSupportedRange(date: Date): boolean {
  const parts = extractNyYmdParts(date)
  if (!parts) return false
  return NYSE_SUPPORTED_YEARS.has(parts.year)
}

/** NY calendar day is a NYSE session day (weekday, not a holiday, within `NYSE_SUPPORTED_YEARS`). */
export function isNyseSessionDay(date: Date): boolean {
  if (!isWithinSupportedRange(date)) return false
  const ymd = formatNyYmd(date)
  if (NYSE_CLOSURES.has(ymd)) return false
  const weekday = NY_WEEKDAY_FORMATTER.format(date)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return true
}
