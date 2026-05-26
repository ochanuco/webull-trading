/**
 * TSE (JP equity) session-day calendar (issue #319)。
 *
 * 22:00 UTC daily roll cron は「翌日 JP が open する」前提で動くため、土日 /
 * TSE 祝日が「明日」に当たる場合は roll を skip して連続性を保つ。
 *
 * Approach (POC): 外部 API に依存せず hard-coded list。usMarketCalendar と
 * 設計対称。詳細な動機は同じファイルの header コメント参照。
 *
 * TODO(annual): 翌年の TSE holiday を追記し `TSE_SUPPORTED_YEARS` を伸ばす。
 * JPX は前年の年央〜年末に翌年カレンダーを公表する
 * (https://www.jpx.co.jp/corporate/about-jpx/calendar/)。
 */

/**
 * TSE 2026 full closures。
 *
 * 出典: JPX trading calendar 2026 (https://www.jpx.co.jp/corporate/about-jpx/calendar/)。
 * 振替休日 (substitute holiday) は当該振替日を含む。年末 / 年始 (12/31, 1/2,
 * 1/3) は祝日扱いではないが TSE が立会を行わない (大納会 12/30 / 大発会 1/5)
 * ため closure に含める。
 *
 * 2026 list:
 *   - 2026-01-01 元日 (New Year's Day, Thu)
 *   - 2026-01-02 (Fri) 年始 TSE 休場
 *   - 2026-01-12 成人の日 (Coming of Age, Mon)
 *   - 2026-02-11 建国記念の日 (Foundation Day, Wed)
 *   - 2026-02-23 天皇誕生日 (Emperor's Birthday, Mon)
 *   - 2026-03-20 春分の日 (Vernal Equinox, Fri)
 *   - 2026-04-29 昭和の日 (Showa Day, Wed)
 *   - 2026-05-04 みどりの日 (Greenery Day, Mon)
 *   - 2026-05-05 こどもの日 (Children's Day, Tue)
 *   - 2026-05-06 振替休日 (substitute, Wed) — Sun May 3 was 憲法記念日
 *   - 2026-07-20 海の日 (Marine Day, Mon)
 *   - 2026-08-11 山の日 (Mountain Day, Tue)
 *   - 2026-09-21 敬老の日 (Respect for the Aged Day, Mon)
 *   - 2026-09-22 国民の休日 (Citizens' Holiday, Tue) — between 敬老の日 and 秋分の日
 *   - 2026-09-23 秋分の日 (Autumnal Equinox, Wed)
 *   - 2026-10-12 スポーツの日 (Sports Day, Mon)
 *   - 2026-11-03 文化の日 (Culture Day, Tue)
 *   - 2026-11-23 勤労感謝の日 (Labor Thanksgiving, Mon)
 *   - 2026-12-31 (Thu) 年末 TSE 休場 — 12/30 大納会で 12/31 立会なし
 */
const TSE_2026_CLOSURES: ReadonlySet<string> = new Set([
  '2026-01-01',
  '2026-01-02',
  '2026-01-12',
  '2026-02-11',
  '2026-02-23',
  '2026-03-20',
  '2026-04-29',
  '2026-05-04',
  '2026-05-05',
  '2026-05-06',
  '2026-07-20',
  '2026-08-11',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-10-12',
  '2026-11-03',
  '2026-11-23',
  '2026-12-31',
])

/** Hard-coded holiday data の有効年セット。範囲外は呼び出し側で fail-closed。 */
const TSE_SUPPORTED_YEARS: ReadonlySet<number> = new Set([2026])

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

/** `date` (UTC instant) を Asia/Tokyo の "YYYY-MM-DD" に format。 */
export function formatJpYmd(date: Date): string {
  return JP_YMD_FORMATTER.format(date)
}

/** `date` 時点の JP 暦日が hard-coded supported range に含まれているか。 */
export function isWithinSupportedRange(date: Date): boolean {
  const ymd = formatJpYmd(date)
  const year = Number.parseInt(ymd.slice(0, 4), 10)
  if (!Number.isFinite(year)) return false
  return TSE_SUPPORTED_YEARS.has(year)
}

/**
 * `date` 時点の JP 暦日が TSE の session day (= 月-金 かつ holiday でない) か。
 * Supported range 外は `false` を返す (fail-closed)。
 */
export function isTseSessionDay(date: Date): boolean {
  if (!isWithinSupportedRange(date)) return false
  const ymd = formatJpYmd(date)
  if (TSE_2026_CLOSURES.has(ymd)) return false
  const weekday = JP_WEEKDAY_FORMATTER.format(date)
  if (weekday === 'Sat' || weekday === 'Sun') return false
  return true
}
