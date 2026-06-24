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

// TODO(annual): 2028 以降の祝日を運用入り前に追記する。
// JP: 東証休業日 (国民の祝日 + 振替休日 + 年始 1/1–1/3 + 大晦日 12/31)
// US NYSE: 9 祝日 + Good Friday。土日と重なる祝日は observed day (振替) を入れる。
//
// このテーブルは market holiday set の単一情報源 (#354)。
// `src/infrastructure/calendar/{us,jp}MarketCalendar.ts` の tz-aware
// session-day check も `NYSE_CLOSURES` / `TSE_CLOSURES` re-export を経由して
// 同じデータを参照する。
export const HOLIDAYS: Record<TradingMarket, ReadonlySet<string>> = {
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
    '2027-12-31', // New Year's Day observed (Jan 1 2028 is Sat)
  ]),
}

/**
 * `HOLIDAYS` の market 別 alias。infrastructure 層の tz-aware session-day check
 * が import するためだけに公開する (#354)。新しい消費者は `HOLIDAYS[market]`
 * を使うか、`isTradingDay` 等の関数 API を使うこと。
 */
export const NYSE_CLOSURES: ReadonlySet<string> = HOLIDAYS.US
export const TSE_CLOSURES: ReadonlySet<string> = HOLIDAYS.JP

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

/** US NYSE レギュラー引け = 16:00 ET (分換算)。 */
const US_REGULAR_CLOSE_ET_MINUTES = 16 * 60

/**
 * `now` が **US 取引日かつ NYSE 引け (16:00 ET) の `minutesBeforeClose` 分前〜引け**
 * の窓内なら true (#intraday-only)。レバ ETF をオーバーナイト持ち越さず引け前に
 * 強制クローズするのに使う。
 *
 * ET wall-clock は `Intl.DateTimeFormat('America/New_York')` で取得し DST 自動対応
 * (macroEventGate と同手法)。引け窓は午後 ET なので UTC 日付 == ET 日付 (深夜跨ぎ
 * 無し) → `isTradingDay(now,'US')` を UTC 基準で使って問題ない。
 *
 * 注意: early close (感謝祭翌日 13:00 ET 等) は POC 未対応 — その日は窓に当たらず
 * 持ち越しうる (`tradingCalendar` 冒頭コメント参照)。
 */
export function isWithinUsCloseWindow(now: Date, minutesBeforeClose: number): boolean {
  if (!Number.isFinite(minutesBeforeClose) || minutesBeforeClose <= 0) return false
  if (!isTradingDay(now, 'US')) return false
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const etMinutes = (hour % 24) * 60 + minute // hour12:false で稀に '24' を返す Intl quirk 対策
  return (
    etMinutes >= US_REGULAR_CLOSE_ET_MINUTES - minutesBeforeClose &&
    etMinutes < US_REGULAR_CLOSE_ET_MINUTES
  )
}

/**
 * 市場ごとのレギュラーセッション (開場 / 引け、市場ローカル分換算)。
 * - US NYSE: 09:30–16:00 ET
 * - JP TSE : 09:00–15:30 JST (引けは 2024-11-05 に 15:30 へ延長後の値)
 *
 * lunch break (JP 11:30–12:30) / early close (US 13:00 ET) は POC 未対応 —
 * 窓内扱いで評価は走る (発注は marketHoursCheck / 板で自然に抑制される)。
 */
const MARKET_SESSION: Record<
  TradingMarket,
  { timeZone: string; openMinutes: number; closeMinutes: number }
> = {
  US: { timeZone: 'America/New_York', openMinutes: 9 * 60 + 30, closeMinutes: 16 * 60 },
  JP: { timeZone: 'Asia/Tokyo', openMinutes: 9 * 60, closeMinutes: 15 * 60 + 30 },
}

/**
 * `now` が **当該 market の取引日かつ「開場 `minutesBeforeOpen` 分前〜引け」**
 * の窓内なら true (#session-window-gate)。戦略 cron を開場前まで停止するゲートに
 * 使う (窓外は評価そのものを skip)。
 *
 * `isWithinUsCloseWindow` と異なり **開場側 (朝)** も判定するため、市場ローカルの
 * 日付・曜日・時刻をすべて `Intl.DateTimeFormat(timeZone)` から 1 回で抽出する。
 * 理由: JP 朝 (08:30 JST = 前日 23:30 UTC) は UTC 日付がズレるので、UTC 基準の
 * `isTradingDay` では曜日・祝日判定を誤る。祝日は **市場ローカル日付**で
 * `HOLIDAYS[market]` と照合する (2026/2027 を保持、範囲外は曜日判定のみに degrade)。
 * DST は `Intl` が自動解決する。
 */
export function isWithinStrategyWindow(
  now: Date,
  market: TradingMarket,
  minutesBeforeOpen: number,
): boolean {
  if (!Number.isFinite(minutesBeforeOpen) || minutesBeforeOpen < 0) return false
  const session = MARKET_SESSION[market]
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: session.timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  const weekday = get('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const ymd = `${get('year')}-${get('month')}-${get('day')}`
  if (HOLIDAYS[market].has(ymd)) return false
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false
  const localMinutes = (hour % 24) * 60 + minute // hour12:false で稀に '24' を返す Intl quirk 対策
  return (
    localMinutes >= session.openMinutes - minutesBeforeOpen &&
    localMinutes < session.closeMinutes
  )
}