/**
 * NYSE (US equity) session-day calendar (issue #319)。
 *
 * 22:00 UTC の daily roll cron は「今日 NY が close した」事を前提に
 * `dailyRealizedPnl` を畳むが、土日 / NYSE 祝日にも cron 自体は発火するため
 * 「実際には立会が無かった日」に roll を 1 回足してしまう。`isNyseSessionDay`
 * を pre-check に挟む事で、real session boundary でない日は roll を skip し、
 * `lastRolledAt` の連続性を保つ。
 *
 * Approach (POC):
 *   - 外部 API に依存せず、`NYSE_2026_CLOSURES` の hard-coded set + weekday 判定。
 *   - 範囲外 (e.g. 2027 以降) を引いた場合は呼び出し側で fail-closed 判断できる
 *     よう `isWithinSupportedRange` を分けて公開する。
 *
 * TODO(annual): 年末ごとに翌年の NYSE closure list を追記し
 * `NYSE_SUPPORTED_YEARS` を伸ばす事。NYSE は通常前年の早い段階で翌年
 * holiday schedule を公表する (https://www.nyse.com/markets/hours-calendars)。
 */

/**
 * NYSE 2026 full closures。
 *
 * 出典: NYSE Holidays & Trading Hours
 * (https://www.nyse.com/markets/hours-calendars — 2025-12 時点で公表済み)。
 * Early-close (1300 ET) days はここに含めない (full close ではないので
 * 22:00 UTC = 17:00 ET 時点では session は終わっており roll 自体は妥当)。
 *
 * 2026 list:
 *   - 2026-01-01 New Year's Day (Thu)
 *   - 2026-01-19 MLK Jr. Day (Mon)
 *   - 2026-02-16 Presidents' Day (Mon)
 *   - 2026-04-03 Good Friday (Fri)
 *   - 2026-05-25 Memorial Day (Mon)
 *   - 2026-06-19 Juneteenth (Fri)
 *   - 2026-07-03 Independence Day (Fri) — observed (Jul 4 is Sat)
 *   - 2026-09-07 Labor Day (Mon)
 *   - 2026-11-26 Thanksgiving (Thu)
 *   - 2026-12-25 Christmas (Fri)
 */
const NYSE_2026_CLOSURES: ReadonlySet<string> = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
])

/** Hard-coded holiday data の有効年セット。範囲外は呼び出し側で fail-closed。 */
const NYSE_SUPPORTED_YEARS: ReadonlySet<number> = new Set([2026])

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

/**
 * `date` (UTC instant) を America/New_York の "YYYY-MM-DD" に format。
 * DST は `Intl.DateTimeFormat` が解決するので worker side で扱う必要なし。
 */
export function formatNyYmd(date: Date): string {
  return NY_YMD_FORMATTER.format(date)
}

/**
 * `date` 時点の NY 暦日が NYSE supported range (hard-coded list) に
 * 含まれているか。false の年は呼び出し側で safe-default (skip) する。
 */
export function isWithinSupportedRange(date: Date): boolean {
  const ymd = formatNyYmd(date)
  const year = Number.parseInt(ymd.slice(0, 4), 10)
  if (!Number.isFinite(year)) return false
  return NYSE_SUPPORTED_YEARS.has(year)
}

/**
 * `date` 時点の NY 暦日が NYSE の session day (= 月-金 かつ holiday でない) か。
 *
 * Supported range 外 (e.g. 2027) は `false` を返す。日付計算は完全に
 * `Intl.DateTimeFormat` に委任しているので caller 側の tz 補正は不要。
 */
export function isNyseSessionDay(date: Date): boolean {
  if (!isWithinSupportedRange(date)) return false
  const ymd = formatNyYmd(date)
  if (NYSE_2026_CLOSURES.has(ymd)) return false
  const weekday = NY_WEEKDAY_FORMATTER.format(date)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return true
}
