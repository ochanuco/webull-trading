/**
 * 取引所カレンダー (JP 東証 / US NYSE)。
 *
 * US は祝日・半日取引をルール計算する (`isUsMarketHoliday` / `isUsMarketEarlyCloseDay`)
 * ので年次メンテ不要。JP は規則性がなく static テーブルのまま — 2028 以降を運用入り前に
 * 下の HOLIDAYS.JP へ追記すること。
 */

export type TradingMarket = 'JP' | 'US'

const MS_PER_DAY = 86_400_000

// HOLIDAYS.US はルール計算 (isUsMarketHolidayYmd) との一致をテストで担保するだけの
// NYSE_CLOSURES re-export 用データで、判定の単一情報源ではない。
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
    // 2027-12-31 は休場にしない: NYSE Rule 7.2 (年末の営業最終日は 1/1 が土曜でも開ける)。
  ]),
}

/** infra 層の tz-aware session-day check が import するための re-export。新規消費者は `isTradingDay` / `isUsMarketHoliday` 等の関数 API を使うこと。 */
export const NYSE_CLOSURES: ReadonlySet<string> = HOLIDAYS.US
export const TSE_CLOSURES: ReadonlySet<string> = HOLIDAYS.JP

function toYmdUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function isWeekend(date: Date): boolean {
  const dow = date.getUTCDay()
  return dow === 0 || dow === 6
}

// 臨時休場 (弔意休場等の unscheduled closure) はルール化できないため対象外 —
// その日は評価が走ってしまうが、板が更新されず spread gate (perSymbolRiskGate)
// が stale quote を reject するのがバックストップ。

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
 * 例外 (NYSE Rule 7.2): 1/1 が土曜の年は前年 12/31 (金) へ振替しない (年末の
 * 営業最終日は開ける) — 下の判定では「前日金曜」候補が day 0 になり構造的に
 * マッチしないため、追加分岐なしでこの例外を満たす。
 */
const US_FIXED_HOLIDAYS: ReadonlyArray<{ month: number; day: number }> = [
  { month: 1, day: 1 },
  { month: 6, day: 19 },
  { month: 7, day: 4 },
  { month: 12, day: 25 },
]

/** `day` が月の第 `n` 週の曜日 (7 日区切りの帯) に入っているか。 */
function isNthWeekdayOfMonth(day: number, n: number): boolean {
  return day > (n - 1) * 7 && day <= n * 7
}

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
    const isObservedFridayBeforeSaturdayHoliday = day === holiday.day - 1 && dow === 5
    const isObservedMondayAfterSundayHoliday = day === holiday.day + 1 && dow === 1
    if (isObservedFridayBeforeSaturdayHoliday || isObservedMondayAfterSundayHoliday) return true
  }
  if (dow === 1) {
    const isMlkDay = month === 1 && isNthWeekdayOfMonth(day, 3)
    const isPresidentsDay = month === 2 && isNthWeekdayOfMonth(day, 3)
    const isMemorialDay = month === 5 && day >= 25 // 5月最終月曜
    const isLaborDay = month === 9 && day <= 7 // 9月第1月曜
    if (isMlkDay || isPresidentsDay || isMemorialDay || isLaborDay) return true
  }
  const isThanksgiving = dow === 4 && month === 11 && isNthWeekdayOfMonth(day, 4)
  if (isThanksgiving) return true
  const goodFriday = computeGoodFriday(year)
  return month === goodFriday.month && day === goodFriday.day
}

/**
 * NYSE 半日取引 (13:00 ET close) 判定のルール本体 (暦日は ET、month 1–12)。
 * 7/3・12/24 はそれぞれ 7/4・12/25 が火〜金の年のみ対象 — 土曜観測日は全日休場側、
 * 日曜観測日は非対象になる。感謝祭翌金曜は無条件。
 */
function isUsMarketEarlyCloseYmd(year: number, month: number, day: number): boolean {
  const dow = dayOfWeek(year, month, day)
  if (month === 7 && day === 3) return dow >= 1 && dow <= 4
  if (month === 11 && dow === 5 && day >= 23 && day <= 29) return true
  if (month === 12 && day === 24) return dow >= 1 && dow <= 4
  return false
}

/** `date` の America/New_York 暦日を y/m/d で返す。抽出失敗 (invalid Date 等) は null。 */
function extractEtYmd(date: Date): { year: number; month: number; day: number } | null {
  return extractLocalYmd(date, 'America/New_York')
}

/** `date` の `timeZone` 暦日を y/m/d で返す (`extractEtYmd` の汎用版)。抽出失敗は null。 */
function extractLocalYmd(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
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

/** `date` 時点の ET 暦日が NYSE 全日休場なら true。土日は false (observed day のみ休場扱い)。 */
export function isUsMarketHoliday(date: Date): boolean {
  const ymd = extractEtYmd(date)
  if (ymd === null) return false
  return isUsMarketHolidayYmd(ymd.year, ymd.month, ymd.day)
}

/** `date` 時点の ET 暦日が NYSE 半日取引 (13:00 ET close) 日なら true。 */
export function isUsMarketEarlyCloseDay(date: Date): boolean {
  const ymd = extractEtYmd(date)
  if (ymd === null) return false
  return isUsMarketEarlyCloseYmd(ymd.year, ymd.month, ymd.day)
}

/** 指定 market の営業日なら true。土日 + 祝日で false。 */
export function isTradingDay(date: Date, market: TradingMarket): boolean {
  // invalid Date は getUTC*() が NaN を返し、素通しすると「営業日」側 (fail-open)
  // に落ちる — 先に弾いて fail-closed にする。
  if (!Number.isFinite(date.getTime())) return false
  if (isWeekend(date)) return false
  if (market === 'US') {
    return !isUsMarketHolidayYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
  }
  const ymd = toYmdUtc(date)
  return !HOLIDAYS[market].has(ymd)
}

/** 指定日の翌営業日を返す。祝日テーブルが尽きた年でも土日判定は機能し続ける。 */
export function nextTradingDay(date: Date, market: TradingMarket): Date {
  let cursor = new Date(date.getTime() + MS_PER_DAY)
  // 祝日テーブル不足 / 連休で無限ループしないよう上限を設ける。
  for (let i = 0; i < 31; i += 1) {
    if (isTradingDay(cursor, market)) return cursor
    cursor = new Date(cursor.getTime() + MS_PER_DAY)
  }
  return cursor
}

/** `fromIso` の翌日から `to` まで (half-open) の営業日数。`fromIso` が invalid なら 0。 */
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

/** symbol から market を推定する軽量版 (4 桁数字は JP、それ以外は US)。domain 層が infra に依存しないよう独立に持つ。 */
export function inferTradingMarket(symbol: string): TradingMarket {
  return /^\d{4}$/.test(symbol) ? 'JP' : 'US'
}

/** US NYSE レギュラー引け = 16:00 ET (分換算)。 */
const US_REGULAR_CLOSE_ET_MINUTES = 16 * 60

/** US NYSE 半日取引の引け = 13:00 ET (分換算)。 */
const US_EARLY_CLOSE_ET_MINUTES = 13 * 60

/**
 * `now` が US 取引日かつ NYSE 引けの `minutesBeforeClose` 分前〜引けの窓内なら true。
 * 半日取引日は引けを 13:00 ET とみなす。
 *
 * 引け窓は常に午後 ET のため UTC 日付 == ET 日付 (深夜跨ぎ無し) — `isTradingDay(now,'US')`
 * と半日取引判定を UTC 日付基準のまま使ってよい。
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
 * JP の lunch break (11:30–12:30) は未対応 — 窓内扱いのまま評価は走るが、
 * 発注自体は marketHoursCheck / 板が抑制する。
 */
const MARKET_SESSION: Record<
  TradingMarket,
  { timeZone: string; openMinutes: number; closeMinutes: number }
> = {
  US: { timeZone: 'America/New_York', openMinutes: 9 * 60 + 30, closeMinutes: 16 * 60 },
  JP: { timeZone: 'Asia/Tokyo', openMinutes: 9 * 60, closeMinutes: 15 * 60 + 30 },
}

/**
 * セッション窓ゲートの判定結果。
 * - 'market_holiday': 全日休場 (土日は恒常的で operator への情報量が無いため 'outside_window' のまま)
 * - 'in_window': 取引日かつ [開場 - minutesBeforeOpen, 引け)
 * - 'outside_window': それ以外 (窓外 / 土日 / 引数不正は fail-closed で窓外扱い)
 */
export type StrategyWindowVerdict = 'in_window' | 'outside_window' | 'market_holiday'

/** 市場ローカル暦日時刻 (曜日込み) の抽出結果。 */
type SessionLocalTime = {
  weekday: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** `now` の market ローカル暦日・曜日・時刻を `Intl.DateTimeFormat` 1 回で抽出する。抽出失敗は null — 呼び出し側は fail-closed (窓外扱い) にする。 */
function extractSessionLocalTime(now: Date, market: TradingMarket): SessionLocalTime | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_SESSION[market].timeZone,
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
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  const hour = Number(get('hour'))
  const minute = Number(get('minute'))
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null
  }
  return { weekday, year, month, day, hour, minute }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** market ローカル暦日 y/m/d が祝日 (全日休場) か。US はルール計算、JP は static テーブル。 */
function isMarketHolidayLocalYmd(market: TradingMarket, year: number, month: number, day: number): boolean {
  if (market === 'US') return isUsMarketHolidayYmd(year, month, day)
  return HOLIDAYS[market].has(`${year}-${pad2(month)}-${pad2(day)}`)
}

/**
 * `now` が当該 market の取引日かつ「開場 `minutesBeforeOpen` 分前〜引け」の窓の
 * どこに居るかを返す。US の半日取引日は引けを 13:00 ET とみなす。
 *
 * `isWithinUsCloseWindow` と異なり開場側 (朝) も判定するため、日付・曜日・時刻を
 * 市場ローカル timezone から 1 回で抽出する — JP 朝 (08:30 JST = 前日 23:30 UTC)
 * は UTC 日付がズレるので、UTC 基準の `isTradingDay` では曜日・祝日判定を誤る。
 */
export function evaluateStrategyWindow(
  now: Date,
  market: TradingMarket,
  minutesBeforeOpen: number,
): StrategyWindowVerdict {
  if (!Number.isFinite(minutesBeforeOpen) || minutesBeforeOpen < 0) return 'outside_window'
  const local = extractSessionLocalTime(now, market)
  if (local === null) return 'outside_window'
  if (local.weekday === 'Sat' || local.weekday === 'Sun') return 'outside_window'
  const { year, month, day } = local
  if (isMarketHolidayLocalYmd(market, year, month, day)) return 'market_holiday'
  const session = MARKET_SESSION[market]
  const localMinutes = (local.hour % 24) * 60 + local.minute // hour12:false で稀に '24' を返す Intl quirk 対策
  const closeMinutes =
    market === 'US' && isUsMarketEarlyCloseYmd(year, month, day)
      ? US_EARLY_CLOSE_ET_MINUTES
      : session.closeMinutes
  return localMinutes >= session.openMinutes - minutesBeforeOpen && localMinutes < closeMinutes
    ? 'in_window'
    : 'outside_window'
}

/** `now` が窓内 ('in_window') なら true。休場と窓外の区別が要らない呼び出し側向けの薄い wrapper。 */
export function isWithinStrategyWindow(
  now: Date,
  market: TradingMarket,
  minutesBeforeOpen: number,
): boolean {
  return evaluateStrategyWindow(now, market, minutesBeforeOpen) === 'in_window'
}

/**
 * `now` が当該 market のレギュラーセッション内 ([開場, 引け)、取引日限定) なら true。
 * `evaluateStrategyWindow` と異なり pre-open 待機窓を持たない — 寄り前の MARKET
 * 注文は寄り値と乖離して約定し得るため、「窓が開いていれば評価してよい」
 * (`evaluateStrategyWindow`) と「発注してよい」をこの関数で分離する。
 */
export function isWithinRegularSession(now: Date, market: TradingMarket): boolean {
  const local = extractSessionLocalTime(now, market)
  if (local === null) return false
  if (local.weekday === 'Sat' || local.weekday === 'Sun') return false
  const { year, month, day } = local
  if (isMarketHolidayLocalYmd(market, year, month, day)) return false
  const session = MARKET_SESSION[market]
  const localMinutes = (local.hour % 24) * 60 + local.minute
  const closeMinutes =
    market === 'US' && isUsMarketEarlyCloseYmd(year, month, day)
      ? US_EARLY_CLOSE_ET_MINUTES
      : session.closeMinutes
  return localMinutes >= session.openMinutes && localMinutes < closeMinutes
}

/** 市場ローカル暦日 y/m/d に `delta` 日を加減する。UTC 固定 placeholder Date (`dayOfWeek` と同じ手法) を使うので DST の影響を受けない。 */
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(year, month - 1, day + delta))
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() }
}

/** 市場ローカル暦日 y/m/d が指定 market の取引日か (`isTradingDay` の市場ローカル版)。 */
function isTradingDayLocalYmd(market: TradingMarket, year: number, month: number, day: number): boolean {
  const dow = dayOfWeek(year, month, day)
  if (dow === 0 || dow === 6) return false
  if (market === 'US') return !isUsMarketHolidayYmd(year, month, day)
  return !HOLIDAYS.JP.has(`${year}-${pad2(month)}-${pad2(day)}`)
}

/**
 * ローカル日付 y-m-d の `minutes` (分換算、0=00:00) を `timeZone` で解釈した UTC
 * instant を返す。事前に offset テーブルを持たず、レンダリング結果とのズレを
 * 補正する反復で DST を解決する。2 回で収束する: 1 回目で概ね正しい offset に、
 * 2 回目で DST 境界を跨いだ場合の再ズレも解消する。
 */
function zonedTimeToUtc(year: number, month: number, day: number, minutes: number, timeZone: string): Date {
  const targetHour = Math.floor(minutes / 60)
  const targetMinute = minutes % 60
  let guessMs = Date.UTC(year, month - 1, day, targetHour, targetMinute)
  for (let i = 0; i < 2; i += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(guessMs))
    const get = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((p) => p.type === type)?.value)
    const py = get('year')
    const pm = get('month')
    const pd = get('day')
    const ph = get('hour') % 24 // hour12:false で稀に '24' を返す Intl quirk 対策
    const pmin = get('minute')
    const renderedMs = Date.UTC(py, pm - 1, pd, ph, pmin)
    guessMs += Date.UTC(year, month - 1, day, targetHour, targetMinute) - renderedMs
  }
  return new Date(guessMs)
}

/**
 * `date` の市場ローカル暦日より後の、最初の取引日のセッション開場時刻 (UTC
 * instant) を返す。`date` 当日が取引日かつ寄り前でも、必ず翌取引日以降の寄りを
 * 返す。
 *
 * `nextTradingDay` ベースの旧方式 (24h ずつ加算し元の時刻を保持) だと cooldown の
 * 実効長が exit 時刻に依存してしまう (引け際 exit ≈ 1 セッション分、寄り直後
 * exit ≈ ほぼ 0) — 本関数は常に「翌営業日の寄り」を返すことでこの依存を断つ。
 *
 * `nextTradingDay`/`isTradingDay` は UTC 日付基準のため JP 夜間 (UTC 日付が市場
 * ローカル日付とズレる) には使えない — 市場ローカル暦日で日送りしてから開場
 * 時刻を UTC instant に変換する (`zonedTimeToUtc`)。
 */
export function nextSessionOpen(date: Date, market: TradingMarket): Date {
  const session = MARKET_SESSION[market]
  const start = extractLocalYmd(date, session.timeZone)
  if (start === null) return new Date(NaN)
  let cursor = addCalendarDays(start.year, start.month, start.day, 1)
  // 祝日テーブル不足 / 連休で無限ループしないよう上限を設ける。
  for (let i = 0; i < 31; i += 1) {
    if (isTradingDayLocalYmd(market, cursor.year, cursor.month, cursor.day)) {
      return zonedTimeToUtc(cursor.year, cursor.month, cursor.day, session.openMinutes, session.timeZone)
    }
    cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1)
  }
  return zonedTimeToUtc(cursor.year, cursor.month, cursor.day, session.openMinutes, session.timeZone)
}
