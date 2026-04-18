/**
 * 取引所カレンダー (JP 東証 / US NYSE)。
 *
 * 現状は 2026 / 2027 分だけ static テーブルで持つ。POC 運用に入る前に
 * **2028 以降を追記する** こと (下の HOLIDAYS テーブル参照)。米国の
 * early close (感謝祭翌日 13:00 close 等) は POC では扱わない。
 *
 * 祝日判定は UTC で比較する。Date 引数は UTC 日付として扱われ、
 * getUTCFullYear / getUTCMonth / getUTCDate の組で YYYY-MM-DD に丸めて
 * set と突き合わせる。時刻成分は無視する。
 */

export type TradingMarket = 'JP' | 'US'

const MS_PER_DAY = 86_400_000

// TODO: 2028 以降の祝日を運用入り前に追記する。
// JP: 東証休業日 (国民の祝日 + 振替休日 + 年始 1/1–1/3 + 大晦日 12/31)
// US NYSE: 9 祝日 + Good Friday。土日と重なる祝日は observed day (振替) を入れる。
const HOLIDAYS: Record<TradingMarket, ReadonlySet<string>> = {
  JP: new Set<string>([
    // 2026
    '2026-01-01', // 元日 (exchange closed)
    '2026-01-02', // 年始休業
    '2026-01-12', // 成人の日
    '2026-02-11', // 建国記念の日
    '2026-02-23', // 天皇誕生日
    '2026-03-20', // 春分の日
    '2026-04-29', // 昭和の日
    '2026-05-04', // みどりの日
    '2026-05-05', // こどもの日
    '2026-05-06', // 振替休日 (憲法記念日 5/3 が日曜)
    '2026-07-20', // 海の日
    '2026-08-11', // 山の日
    '2026-09-21', // 敬老の日
    '2026-09-22', // 国民の休日
    '2026-09-23', // 秋分の日
    '2026-10-12', // スポーツの日
    '2026-11-03', // 文化の日
    '2026-11-23', // 勤労感謝の日
    '2026-12-31', // 大納会翌営業日休 (TSE closed)
    // 2027
    '2027-01-01', // 元日
    '2027-01-11', // 成人の日
    '2027-02-11', // 建国記念の日
    '2027-02-23', // 天皇誕生日
    '2027-03-22', // 振替休日 (春分の日 3/21 が日曜)
    '2027-04-29', // 昭和の日
    '2027-05-03', // 憲法記念日
    '2027-05-04', // みどりの日
    '2027-05-05', // こどもの日
    '2027-07-19', // 海の日
    '2027-08-11', // 山の日
    '2027-09-20', // 敬老の日
    '2027-09-23', // 秋分の日
    '2027-10-11', // スポーツの日
    '2027-11-03', // 文化の日
    '2027-11-23', // 勤労感謝の日
    '2027-12-31', // TSE closed
  ]),
  US: new Set<string>([
    // 2026
    '2026-01-01', // New Year's Day
    '2026-01-19', // MLK Day (3rd Mon Jan)
    '2026-02-16', // Presidents' Day (3rd Mon Feb)
    '2026-04-03', // Good Friday
    '2026-05-25', // Memorial Day
    '2026-06-19', // Juneteenth
    '2026-07-03', // Independence Day observed (Jul 4 is Sat)
    '2026-09-07', // Labor Day
    '2026-11-26', // Thanksgiving
    '2026-12-25', // Christmas
    // 2027
    '2027-01-01', // New Year's Day
    '2027-01-18', // MLK Day
    '2027-02-15', // Presidents' Day
    '2027-03-26', // Good Friday
    '2027-05-31', // Memorial Day
    '2027-06-18', // Juneteenth observed (Jun 19 is Sat)
    '2027-07-05', // Independence Day observed (Jul 4 is Sun)
    '2027-09-06', // Labor Day
    '2027-11-25', // Thanksgiving
    '2027-12-24', // Christmas observed (Dec 25 is Sat)
  ]),
}

function toYmdUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function isWeekend(date: Date): boolean {
  const dow = date.getUTCDay()
  return dow === 0 || dow === 6
}

/**
 * 指定 market の営業日なら true。土日 + 祝日で false。
 */
export function isTradingDay(date: Date, market: TradingMarket): boolean {
  if (isWeekend(date)) return false
  const ymd = toYmdUtc(date)
  return !HOLIDAYS[market].has(ymd)
}

/**
 * 指定日の**翌**営業日を返す。土日・祝日を連続してスキップする。
 * 祝日テーブルが尽きた年を跨ぐ場合も、土日判定だけはそのまま動く。
 */
export function nextTradingDay(date: Date, market: TradingMarket): Date {
  let cursor = new Date(date.getTime() + MS_PER_DAY)
  // 祝日テーブル不足 / 連休で無限ループしないよう上限を設ける (31 日分)。
  for (let i = 0; i < 31; i += 1) {
    if (isTradingDay(cursor, market)) return cursor
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
  }
  return cursor
}

/**
 * `fromIso` の翌日から `to` (両端含む / half-open: to まで) までを走査し、
 * 営業日の数を返す。`fromIso` が invalid なら 0。祝日・土日は除外。
 * `openedAt` がいつで `now` が現在時刻、という保有日数計算に使う。
 */
export function countTradingDaysBetween(
  fromIso: string,
  to: Date,
  market: TradingMarket,
): number {
  const from = new Date(fromIso)
  if (!Number.isFinite(from.getTime())) return 0
  const end = to.getTime()
  if (!Number.isFinite(end)) {
    throw new Error('Invalid "to" date')
  }
  let count = 0
  const cursor = new Date(from.getTime())
  while (true) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    if (cursor.getTime() > end) break
    if (isTradingDay(cursor, market)) count += 1
  }
  return count
}

/**
 * symbol から market を推定する軽量版。infrastructure 層の
 * `inferWebullMarket` と同じ規則 (4 桁数字は JP / それ以外は US)。
 * domain が infrastructure に依存しないよう独立に持つ。
 */
export function inferTradingMarket(symbol: string): TradingMarket {
  return /^\d{4}$/.test(symbol) ? 'JP' : 'US'
}