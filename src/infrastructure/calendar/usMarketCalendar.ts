/**
 * NYSE (US equity) session-day calendar. Holiday data itself lives in
 * `src/trading/domain/tradingCalendar.ts`'s `NYSE_CLOSURES` (single source
 * of truth) — this module only adds tz-aware (America/New_York) classification.
 */

import { NYSE_CLOSURES } from '../../trading/domain/tradingCalendar'

// Fail-closed on years not yet added here, rather than trusting NYSE_CLOSURES
// alone — an un-added future year must not silently be treated as tradable.
const NYSE_SUPPORTED_YEARS: ReadonlySet<number> = new Set([2026])

// formatToParts avoids relying on `.format()`'s ICU-build-dependent ordering.
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

export function formatNyYmd(date: Date): string {
  return extractNyYmdParts(date)?.ymd ?? ''
}

export function isWithinSupportedRange(date: Date): boolean {
  const parts = extractNyYmdParts(date)
  if (!parts) return false
  return NYSE_SUPPORTED_YEARS.has(parts.year)
}

export function isNyseSessionDay(date: Date): boolean {
  if (!isWithinSupportedRange(date)) return false
  const ymd = formatNyYmd(date)
  if (NYSE_CLOSURES.has(ymd)) return false
  const weekday = NY_WEEKDAY_FORMATTER.format(date)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return true
}
