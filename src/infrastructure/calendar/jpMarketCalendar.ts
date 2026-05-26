/**
 * TSE (JP equity) session-day calendar (issue #319)。
 *
 * 22:00 UTC daily roll cron は「翌日 JP が open する」前提で動くため、土日 /
 * TSE 祝日が「明日」に当たる場合は roll を skip して連続性を保つ。
 *
 * Approach (POC): 外部 API に依存せず、`src/trading/domain/tradingCalendar.ts`
 * の `TSE_CLOSURES` (single source of truth, #354) + weekday 判定。
 * usMarketCalendar と設計対称。詳細な動機は同じファイルの header コメント参照。
 *
 * Holiday data 自体の更新は `tradingCalendar.ts` 側で行う。当 module は
 * tz-aware (Asia/Tokyo) な session-day 判定のみを責務にする。
 */

import { TSE_CLOSURES } from '../../trading/domain/tradingCalendar'

/** Hard-coded holiday data の有効年セット。範囲外は呼び出し側で fail-closed。 */
const TSE_SUPPORTED_YEARS: ReadonlySet<number> = new Set([2026])

// formatToParts ベースで year / month / day を抜く理由は usMarketCalendar.ts
// 参照 (#349 — runtime-portable な YYYY-MM-DD 組立)。
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

/**
 * `date` (UTC instant) を Asia/Tokyo の "YYYY-MM-DD" に format。
 *
 * formatToParts ベースで runtime drift に強い (#349)。抽出失敗時は空文字 →
 * caller (`isTseSessionDay`) で fail-closed (false) になる。
 */
export function formatJpYmd(date: Date): string {
  return extractJpYmdParts(date)?.ymd ?? ''
}

/** `date` 時点の JP 暦日が hard-coded supported range に含まれているか。 */
export function isWithinSupportedRange(date: Date): boolean {
  const parts = extractJpYmdParts(date)
  if (!parts) return false
  return TSE_SUPPORTED_YEARS.has(parts.year)
}

/**
 * `date` 時点の JP 暦日が TSE の session day (= 月-金 かつ holiday でない) か。
 * Supported range 外は `false` を返す (fail-closed)。
 */
export function isTseSessionDay(date: Date): boolean {
  if (!isWithinSupportedRange(date)) return false
  const ymd = formatJpYmd(date)
  if (TSE_CLOSURES.has(ymd)) return false
  const weekday = JP_WEEKDAY_FORMATTER.format(date)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return true
}
