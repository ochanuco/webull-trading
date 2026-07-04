/**
 * 取引所カレンダー (JP 東証 / US NYSE)。
 *
 * US (NYSE) の全日休場・半日取引 (13:00 ET close) は #547 でルール計算
 * (`isUsMarketHoliday` / `isUsMarketEarlyCloseDay`) に移行済みで年次メンテ不要。
 * JP は 2026 / 2027 分だけ static テーブルで持つ。POC 運用を続けるなら
 * **JP の 2028 以降を追記する** こと (下の HOLIDAYS テーブル参照)。
 *
 * `isTradingDay` / `nextTradingDay` / `countTradingDaysBetween` の祝日判定は
 * UTC 日付基準 (時刻成分は無視)。市場ローカル暦日 (ET / JST) 基準の関数
 * (`isUsMarketHoliday` / `evaluateStrategyWindow` 等) は各 doc comment 参照。
 */

export type TradingMarket = 'JP' | 'US'

const MS_PER_DAY = 86_400_000

// TODO(annual): JP の 2028 以降の祝日を運用入り前に追記する。
// JP: 東証休業日 (国民の祝日 + 振替休日 + 年始 1/1–1/3 + 大晦日 12/31)
// US NYSE: 9 祝日 + Good Friday。土日と重なる祝日は observed day (振替) を入れる。
//   ※ US の単一情報源は #547 でルール計算 (`isUsMarketHoliday`) に移った。
//   この US set は infrastructure 層の `NYSE_CLOSURES` re-export (#354) 向けに
//   残しており、ルールとの整合はテストで担保する (tradingCalendar.test.ts)。
//
// JP テーブルは market holiday set の単一情報源 (#354)。
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
    // 2027-12-31 は休場にしない: NYSE Rule 7.2 (年末の営業最終日は 1/1 が土曜
    // でも開ける)。実例: 2022-01-01 (土) に対し 2021-12-31 は通常立会だった。
  ]),
}

/**
 * `HOLIDAYS` の market 別 alias。infrastructure 層の tz-aware session-day check
 * が import するためだけに公開する (#354)。新しい消費者は `isTradingDay` /
 * `isUsMarketHoliday` 等の関数 API を使うこと (US はルール計算が単一情報源、#547)。
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

// ---------------------------------------------------------------------------
// US (NYSE) ルール計算カレンダー (#547)
//
// 静的テーブルの年次追記を不要にするため、休場・半日取引を規則から導出する。
// 臨時休場 (服喪・災害等の unscheduled closure) は規則で書けないため対象外 —
// その日は評価が走ってしまうが、閉場で板が更新されず spread gate
// (perSymbolRiskGate) が stale quote を reject するのがバックストップ。
// ---------------------------------------------------------------------------

/** proleptic Gregorian の曜日 (0=Sun .. 6=Sat)。month は 1–12。 */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * 復活祭 (Easter Sunday) の月日 (month は 1–12)。Computus の Anonymous
 * Gregorian algorithm (Meeus / Jones / Butcher)。Good Friday の導出にだけ使う。
 */
function computeEasterSunday(year: number): { month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

/** Good Friday = 復活祭の 2 日前 (Date.UTC の日付正規化で月跨ぎを吸収)。 */
function computeGoodFriday(year: number): { month: number; day: number } {
  const easter = computeEasterSunday(year)
  const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2))
  return { month: gf.getUTCMonth() + 1, day: gf.getUTCDate() }
}

/**
 * 振替付き固定祝日 (New Year 1/1, Juneteenth 6/19, Independence 7/4,
 * Christmas 12/25)。土曜に当たる年は前日金曜、日曜に当たる年は翌月曜が休場。
 *
 * 例外 (NYSE Rule 7.2): 1/1 が土曜の年は前年 12/31 (金) へ振替**しない**
 * (年末の営業最終日は開ける。実例: 2022-01-01 が土曜で 2021-12-31 は通常立会)。
 * 下の判定では「前日金曜」候補が day 0 となり構造的にマッチしないため、
 * 追加分岐なしでこの例外を満たす。
 */
const US_FIXED_HOLIDAYS: ReadonlyArray<{ month: number; day: number }> = [
  { month: 1, day: 1 },
  { month: 6, day: 19 },
  { month: 7, day: 4 },
  { month: 12, day: 25 },
]

/**
 * NYSE 全日休場判定のルール本体。year/month/day は **America/New_York の暦日**
 * (month 1–12)。休場は observed day (振替後の平日) のみ true — 土日そのものは
 * false を返すので、呼び出し側の週末判定と組み合わせる。
 */
function isUsMarketHolidayYmd(year: number, month: number, day: number): boolean {
  const dow = dayOfWeek(year, month, day)
  for (const holiday of US_FIXED_HOLIDAYS) {
    if (holiday.month !== month) continue
    if (day === holiday.day && dow >= 1 && dow <= 5) return true
    if (day === holiday.day - 1 && dow === 5) return true // 祝日が土曜 → 前日金曜が休場
    if (day === holiday.day + 1 && dow === 1) return true // 祝日が日曜 → 翌月曜が休場
  }
  if (dow === 1) {
    if (month === 1 && day >= 15 && day <= 21) return true // MLK Day (1月第3月曜)
    if (month === 2 && day >= 15 && day <= 21) return true // Presidents' Day (2月第3月曜)
    if (month === 5 && day >= 25) return true // Memorial Day (5月最終月曜)
    if (month === 9 && day <= 7) return true // Labor Day (9月第1月曜)
  }
  if (dow === 4 && month === 11 && day >= 22 && day <= 28) return true // Thanksgiving (11月第4木曜)
  const goodFriday = computeGoodFriday(year)
  return month === goodFriday.month && day === goodFriday.day
}

/**
 * NYSE 半日取引 (13:00 ET close) 判定のルール本体 (暦日は ET、month 1–12)。
 *  - 7/3: 7/4 が火〜金の年 (= 7/3 が月〜木)。7/4 が土曜の年の 7/3 は全日休場
 *    (振替) 側なので対象外、7/4 が月曜の年の 7/3 は日曜で対象外
 *  - 感謝祭翌日 (11月第4木曜の翌金曜)
 *  - 12/24: 12/25 が火〜金の年 (= 12/24 が月〜木)。12/25 が土曜の年の 12/24 は
 *    全日休場 (振替) 側なので対象外
 */
function isUsMarketEarlyCloseYmd(year: number, month: number, day: number): boolean {
  const dow = dayOfWeek(year, month, day)
  if (month === 7 && day === 3) return dow >= 1 && dow <= 4
  if (month === 11 && dow === 5 && day >= 23 && day <= 29) return true
  if (month === 12 && day === 24) return dow >= 1 && dow <= 4
  return false
}

/**
 * `date` (UTC instant) の America/New_York 暦日を数値 y/m/d で返す。
 * `Intl.DateTimeFormat#formatToParts` ベース (DST 自動解決。format() の出力
 * 文字列に依存しないのは #349 と同じ理由)。抽出失敗は null。
 */
function extractEtYmd(date: Date): { year: number; month: number; day: number } | null {
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  return { year, month, day }
}

/**
 * `date` 時点の **America/New_York 暦日** が NYSE 全日休場 (祝日 + 振替) なら
 * true (#547)。固定日 + 振替 / 第n月曜 / Memorial / Thanksgiving / Good Friday
 * (Computus) をルール計算するので年次テーブル追記は不要。土日は false
 * (observed day のみ休場扱い)。臨時休場は対象外 — spread gate がバックストップ
 * (上のセクションコメント参照)。
 */
export function isUsMarketHoliday(date: Date): boolean {
  const ymd = extractEtYmd(date)
  if (ymd === null) return false
  return isUsMarketHolidayYmd(ymd.year, ymd.month, ymd.day)
}

/**
 * `date` 時点の ET 暦日が NYSE 半日取引 (13:00 ET close) 日なら true (#547)。
 * 対象: 7/3 (7/4 が平日の年) / 感謝祭翌日 / 12/24 (12/25 が平日の年)。
 */
export function isUsMarketEarlyCloseDay(date: Date): boolean {
  const ymd = extractEtYmd(date)
  if (ymd === null) return false
  return isUsMarketEarlyCloseYmd(ymd.year, ymd.month, ymd.day)
}

/**
 * 指定 market の営業日なら true。土日 + 祝日で false。
 */
export function isTradingDay(date: Date, market: TradingMarket): boolean {
  // invalid Date は getUTC*() が NaN になり土日/祝日判定をすり抜けて「営業日」
  // 側 (fail-open) に落ちるため、先に弾く (fail-closed)。
  if (!Number.isFinite(date.getTime())) return false
  if (isWeekend(date)) return false
  if (market === 'US') {
    // US は従来どおり UTC 日付基準のままルール判定へ委譲 (#547)。static set
    // 参照と同じ semantics を保ちつつ、テーブル切れ (2028 以降) が無くなる。
    return !isUsMarketHolidayYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
  }
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

/** US NYSE 半日取引の引け = 13:00 ET (分換算、#547)。 */
const US_EARLY_CLOSE_ET_MINUTES = 13 * 60

/**
 * `now` が **US 取引日かつ NYSE 引けの `minutesBeforeClose` 分前〜引け**
 * の窓内なら true (#intraday-only)。レバ ETF をオーバーナイト持ち越さず引け前に
 * 強制クローズするのに使う。半日取引日 (感謝祭翌日等) は引けを 13:00 ET に
 * 短縮して判定する (#547)。
 *
 * ET wall-clock は `Intl.DateTimeFormat('America/New_York')` で取得し DST 自動対応
 * (macroEventGate と同手法)。引け窓は 13:00/16:00 ET どちらでも午後 ET なので
 * UTC 日付 == ET 日付 (深夜跨ぎ無し) → `isTradingDay(now,'US')` と半日取引判定を
 * UTC 日付基準で使って問題ない。
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
  const closeEtMinutes = isUsMarketEarlyCloseYmd(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    now.getUTCDate(),
  )
    ? US_EARLY_CLOSE_ET_MINUTES
    : US_REGULAR_CLOSE_ET_MINUTES
  return etMinutes >= closeEtMinutes - minutesBeforeClose && etMinutes < closeEtMinutes
}

/**
 * 市場ごとのレギュラーセッション (開場 / 引け、市場ローカル分換算)。
 * - US NYSE: 09:30–16:00 ET (半日取引日は 13:00 ET 引け、#547)
 * - JP TSE : 09:00–15:30 JST (引けは 2024-11-05 に 15:30 へ延長後の値)
 *
 * lunch break (JP 11:30–12:30) は POC 未対応 — 窓内扱いで評価は走る
 * (発注は marketHoursCheck / 板で自然に抑制される)。
 */
const MARKET_SESSION: Record<
  TradingMarket,
  { timeZone: string; openMinutes: number; closeMinutes: number }
> = {
  US: { timeZone: 'America/New_York', openMinutes: 9 * 60 + 30, closeMinutes: 16 * 60 },
  JP: { timeZone: 'Asia/Tokyo', openMinutes: 9 * 60, closeMinutes: 15 * 60 + 30 },
}

/**
 * #session-window-gate の判定結果 (#547)。
 * - 'market_holiday': 全日休場 (US はルール計算、JP は HOLIDAYS static テーブル。
 *   土日は恒常的で operator への情報量が無いため従来通り 'outside_window')
 * - 'in_window': 取引日かつ [開場 - minutesBeforeOpen, 引け)
 * - 'outside_window': それ以外 (窓外 / 土日 / 引数不正は fail-closed で窓外扱い)
 */
export type StrategyWindowVerdict = 'in_window' | 'outside_window' | 'market_holiday'

/**
 * `now` が **当該 market の取引日かつ「開場 `minutesBeforeOpen` 分前〜引け」**
 * の窓のどこに居るかを返す (#session-window-gate)。戦略 cron を開場前まで停止する
 * ゲートに使う (窓外は評価そのものを skip)。US の半日取引日は引けを 13:00 ET に
 * 短縮する (#547)。
 *
 * `isWithinUsCloseWindow` と異なり **開場側 (朝)** も判定するため、市場ローカルの
 * 日付・曜日・時刻をすべて `Intl.DateTimeFormat(timeZone)` から 1 回で抽出する。
 * 理由: JP 朝 (08:30 JST = 前日 23:30 UTC) は UTC 日付がズレるので、UTC 基準の
 * `isTradingDay` では曜日・祝日判定を誤る。祝日は **市場ローカル日付** で判定する
 * (US はルール計算で年次メンテ不要、JP は HOLIDAYS static — 2026/2027 を保持、
 * 範囲外は曜日判定のみに degrade)。DST は `Intl` が自動解決する。
 */
export function evaluateStrategyWindow(
  now: Date,
  market: TradingMarket,
  minutesBeforeOpen: number,
): StrategyWindowVerdict {
  if (!Number.isFinite(minutesBeforeOpen) || minutesBeforeOpen < 0) return 'outside_window'
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
  if (weekday === 'Sat' || weekday === 'Sun') return 'outside_window'
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return 'outside_window'
  }
  if (market === 'US') {
    if (isUsMarketHolidayYmd(year, month, day)) return 'market_holiday'
  } else if (HOLIDAYS[market].has(`${get('year')}-${get('month')}-${get('day')}`)) {
    return 'market_holiday'
  }
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'outside_window'
  const localMinutes = (hour % 24) * 60 + minute // hour12:false で稀に '24' を返す Intl quirk 対策
  const closeMinutes =
    market === 'US' && isUsMarketEarlyCloseYmd(year, month, day)
      ? US_EARLY_CLOSE_ET_MINUTES
      : session.closeMinutes
  return localMinutes >= session.openMinutes - minutesBeforeOpen && localMinutes < closeMinutes
    ? 'in_window'
    : 'outside_window'
}

/**
 * `now` が窓内 ('in_window') なら true。休場と窓外の区別が要らない呼び出し側
 * 向けの薄い wrapper (#session-window-gate)。
 */
export function isWithinStrategyWindow(
  now: Date,
  market: TradingMarket,
  minutesBeforeOpen: number,
): boolean {
  return evaluateStrategyWindow(now, market, minutesBeforeOpen) === 'in_window'
}