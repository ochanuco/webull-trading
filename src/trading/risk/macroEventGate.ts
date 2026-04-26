/**
 * Macro economic event calendar gate (issue #196 2/3)。
 *
 * FOMC / CPI / NFP / PCE / GDP / ISM 等の重要 macro 発表 当日 (±N 時間) の
 * BUY エントリを凍結する **avoid 用 risk gate**。
 * - シグナル源ではない (BUY を出す根拠にしない、BUY を *止める* だけ)
 * - 計算コストはゼロに近い (D1 read 1 本)
 * - DB read 失敗 → fail-closed (entry block) で safe 側に倒す
 * - `event_time` (ET) があれば 発表時刻 ± freezeHoursBefore/After で window 判定。
 *   なければ event_date 当日全日凍結 (POC 簡略 fallback)。
 * - tz 計算は完璧でなくて OK (POC、`Intl.DateTimeFormat('en-US', { timeZone:
 *   'America/New_York' })` で ET の wall-clock 文字列を取って比較)。
 *
 * scope:
 *   - in: BUY を ±N 時間内に macro event がある時刻について止める
 *   - out: SELL は止めない (既存 position 保護のため macro 跨ぎ手仕舞いは許容)
 *   - out: 銘柄非依存 (ETF だろうと個別株だろうと cron 全銘柄に適用)
 *   - out: VIX regime filter は別 PR (#196 3/3) で
 *
 * 呼び出し側 (`pullbackScheduler` 経由) は gate decision の `reason` を
 * `risk: macro_event_gate: FOMC 2026-06-17 14:00ET` 形式で
 * `strategy_decision_log.reason` に書く。
 */
import type { MacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import type { MacroEventCalendarRow } from '../../infrastructure/db/schema'

export interface MacroEventGateInput {
  /**
   * 評価時刻 ISO datetime (e.g. `2026-06-17T18:30:00.000Z`)。cron tick の現在
   * 時刻を渡す。time-of-day を持つ点が earnings gate との違い (発表時刻 ±N
   * 時間で window 判定するため)。
   */
  evalTimestamp: string
  /**
   * 評価対象の side。BUY のみ gate を効かせる。SELL は既存 position の
   * 撤退 / cleanup を妨げないように常に approve。
   */
  side: 'BUY' | 'SELL'
}

export interface MacroEventGateConfig {
  /** 発表前の凍結時間 (hours)。default 1。 */
  freezeHoursBefore: number
  /**
   * 発表後の凍結時間 (hours)。default 6 (発表直後の volatility / drift を回避)。
   * 上限は `sanitizeHours` で 6h クランプ。
   */
  freezeHoursAfter: number
  /**
   * `event_time` が NULL の event を全日凍結するか。default true。
   * false なら時刻不明 event は無視 (POC ではあまり推奨しない)。
   */
  freezeFullDayWhenTimeUnknown: boolean
}

export interface MacroEventGateDecision {
  approved: boolean
  /**
   * Approved=false のときの reject 理由。形式:
   *   - `macro_event_gate: FOMC 2026-06-17 14:00ET` (時刻指定あり)
   *   - `macro_event_gate: ISM 2026-07-01 (full-day)` (時刻不明)
   *   - `macro_event_gate_invalid_eval_timestamp: <raw>`
   *   - `macro_event_gate_invalid_calendar_row: <type> <date> <time>` (event_time が不正)
   *   - `macro_event_gate_fetch_failed: <error>`
   */
  reason?: string
  /** Operator UI / log 用に reject を引き起こした event を返す。 */
  triggeringEvent?: { type: string; date: string; time: string | null }
}

export const DEFAULT_MACRO_GATE_CONFIG: MacroEventGateConfig = {
  freezeHoursBefore: 1,
  freezeHoursAfter: 6,
  freezeFullDayWhenTimeUnknown: true,
}

const MS_PER_HOUR = 3_600_000

/**
 * Pure-ish gate evaluator (`repo.fetchByDateRange` のみ side-effect)。
 *
 * 振る舞い:
 *  1. SELL → 常に approve (gate scope 外)
 *  2. evalTimestamp parse 失敗 → fail-closed reject
 *  3. ET tz の `eval` を中心に ±freezeHours で window を計算し、被りそうな
 *     event_date 範囲を repo.fetchByDateRange で取得 (前日 / 当日 / 翌日 を
 *     カバーすれば DST / midnight 跨ぎ含めて十分粗く拾える)
 *  4. fetch throw → fail-closed reject (D1 read failure を silent pass させない)
 *  5. event_time 指定行: ET wall-clock で `event_date + event_time` を組み立て
 *     evalTimestamp と差分を取り freezeHoursBefore/After 以内なら reject
 *  6. event_time NULL 行: `freezeFullDayWhenTimeUnknown=true` のときのみ、
 *     ET の評価日が event_date と一致したら reject
 *  7. 該当なければ approve
 */
export async function evaluateMacroEventGate(
  input: MacroEventGateInput,
  repo: MacroEventCalendarRepo,
  config: MacroEventGateConfig = DEFAULT_MACRO_GATE_CONFIG,
): Promise<MacroEventGateDecision> {
  if (input.side === 'SELL') return { approved: true }

  const evalMs = Date.parse(input.evalTimestamp)
  if (!Number.isFinite(evalMs)) {
    return {
      approved: false,
      reason: `macro_event_gate_invalid_eval_timestamp: ${input.evalTimestamp}`,
    }
  }
  const evalDate = new Date(evalMs)

  const freezeBefore = sanitizeHours(config.freezeHoursBefore, DEFAULT_MACRO_GATE_CONFIG.freezeHoursBefore)
  const freezeAfter = sanitizeHours(config.freezeHoursAfter, DEFAULT_MACRO_GATE_CONFIG.freezeHoursAfter)
  const freezeFullDayWhenTimeUnknown = config.freezeFullDayWhenTimeUnknown

  // ET 観点で評価対象になりうる event_date を 3 日窓 (前日 / 当日 / 翌日) で拾う。
  // freeze 幅が ±1〜2 時間想定であれば、ET の midnight 跨ぎが噛んでも 3 日で
  // 包含できる (24h を超える freeze は sanitizeHours で 6h にクランプ)。
  const evalEtYmd = formatEtYmd(evalDate)
  const fromYmd = shiftYmd(evalEtYmd, -1)
  const toYmd = shiftYmd(evalEtYmd, 1)

  let rows: MacroEventCalendarRow[]
  try {
    rows = await repo.fetchByDateRange(fromYmd, toYmd)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      approved: false,
      reason: `macro_event_gate_fetch_failed: ${msg}`,
    }
  }

  if (rows.length === 0) return { approved: true }

  const beforeMs = freezeBefore * MS_PER_HOUR
  const afterMs = freezeAfter * MS_PER_HOUR

  for (const row of rows) {
    // event_time あり / NULL の両分岐を通す前に event_date を round-trip validate。
    // event_time NULL 分岐は単純文字列一致 (`row.eventDate === evalEtYmd`) しか
    // しないため、不正な event_date (e.g., `2026-02-30`, `2026-13-01`) が来ても
    // 一致する可能性が無く silent pass = fail-open する。両分岐で対称な
    // fail-closed validation を保証するため、ループ先頭で reject する。
    if (!isStrictYmd(row.eventDate)) {
      return {
        approved: false,
        reason: `macro_event_gate_invalid_calendar_row: ${row.eventType} ${row.eventDate} ${row.eventTime ?? 'null'}`,
        triggeringEvent: {
          type: row.eventType,
          date: row.eventDate,
          time: row.eventTime ?? null,
        },
      }
    }

    if (row.eventTime !== null && row.eventTime !== undefined && row.eventTime !== '') {
      // 発表時刻指定あり: ET wall-clock で `event_date + event_time` を UTC ms
      // に変換 (簡略 ET tz: `America/New_York` の現時点 offset を Intl で取得)。
      const eventMs = etWallClockToUtcMs(row.eventDate, row.eventTime)
      if (eventMs === null) {
        // 不正な event_date / event_time の row を silent skip すると
        // その event だけ BUY 素通り = fail-open になるため fail-closed reject。
        return {
          approved: false,
          reason: `macro_event_gate_invalid_calendar_row: ${row.eventType} ${row.eventDate} ${row.eventTime}`,
          triggeringEvent: {
            type: row.eventType,
            date: row.eventDate,
            time: row.eventTime,
          },
        }
      }
      const delta = evalMs - eventMs // > 0 なら eval が event より後
      if (delta >= -beforeMs && delta <= afterMs) {
        return {
          approved: false,
          reason: `macro_event_gate: ${row.eventType} ${row.eventDate} ${row.eventTime}ET`,
          triggeringEvent: {
            type: row.eventType,
            date: row.eventDate,
            time: row.eventTime,
          },
        }
      }
    } else if (freezeFullDayWhenTimeUnknown) {
      // 時刻不明 event: ET の評価日と event_date が一致したら全日凍結。
      if (row.eventDate === evalEtYmd) {
        return {
          approved: false,
          reason: `macro_event_gate: ${row.eventType} ${row.eventDate} (full-day)`,
          triggeringEvent: {
            type: row.eventType,
            date: row.eventDate,
            time: null,
          },
        }
      }
    }
  }

  return { approved: true }
}

/**
 * 不正値を default に倒し、上限 6 時間でクランプ。POC 段階では「±1〜2 時間
 * 凍結」が想定運用で、巨大値による全停止暴発を防ぐため軽い sane bound。
 * 24h を超えると ±1 日窓 fetch では拾えなくなるため、6h で十分。
 */
function sanitizeHours(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < 0) return fallback
  if (value > 6) return 6
  return value
}

/**
 * UTC `Date` を `America/New_York` 観点の "YYYY-MM-DD" に format。
 * `Intl.DateTimeFormat` で `en-CA` ('YYYY-MM-DD' をそのまま返す locale) を
 * 使う方が format 後の split が要らないので採用。
 */
function formatEtYmd(date: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(date)
}

/**
 * "YYYY-MM-DD" を厳密 validate (round-trip)。
 *
 * JS Date は不正な暦日 (e.g. `2026-02-30`, `2026-13-01`, `2026-04-31`) を
 * silent normalize するため、`Date.parse` だけでは fail-open する。`toISOString`
 * に戻して入力文字列と一致するか比較し、実在する暦日のみ true を返す。
 *
 * `etWallClockToUtcMs` は event_time あり経路で同等 round-trip を内部で行うが、
 * event_time NULL 経路 (full-day freeze) ではこの helper を使って対称な
 * fail-closed validation を行う。
 */
function isStrictYmd(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === ymd
}

/**
 * "YYYY-MM-DD" を `±days` 日シフトして "YYYY-MM-DD" に戻す。pure UTC 計算で
 * tz は介さない (windowing で前日 / 翌日 を拾うため)。
 */
function shiftYmd(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return ymd
  const shifted = new Date(ms + days * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * `event_date` (ET YYYY-MM-DD) + `event_time` (ET HH:MM) を UTC ms に変換。
 *
 * 簡略 ET 変換 (POC):
 *   1. naive UTC ms = `Date.parse(${date}T${time}:00.000Z)`
 *   2. その瞬間に America/New_York が UTC からどれだけ offset しているかを
 *      `Intl.DateTimeFormat` で probe (DST aware)
 *   3. `naive UTC ms - offset` が真の UTC ms
 *
 * DST 境界の 1 時間ジャンプは無視 (POC では 1 時間程度の誤差を許容する旨
 * task に明記)。不正値は `null` を返し、caller 側で fail-closed reject する。
 */
function etWallClockToUtcMs(eventDate: string, eventTime: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null
  const tm = /^(\d{2}):(\d{2})$/.exec(eventTime)
  if (!tm) return null
  const hh = Number(tm[1])
  const mm = Number(tm[2])
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  const naiveUtcMs = Date.parse(`${eventDate}T${eventTime}:00.000Z`)
  if (!Number.isFinite(naiveUtcMs)) return null
  // round-trip で実在しない暦日 (e.g. 2026-02-30, 2026-04-31) を reject。
  // JS Date は不正な日付を silent normalize する (2026-02-30 → 2026-03-02) ため、
  // ISOString に戻して入力と一致するか厳密比較しないと fail-open する。
  const roundTrip = new Date(naiveUtcMs).toISOString()
  if (roundTrip.slice(0, 10) !== eventDate) return null
  if (roundTrip.slice(11, 16) !== eventTime) return null
  const offsetMin = etOffsetMinutesAt(naiveUtcMs)
  // ET は UTC の西側 (negative offset)。例: EST = -300, EDT = -240。
  // wall-clock が UTC `XX` のときの真 UTC = naive - offset (offset is negative)
  // → naiveUtcMs - offsetMin*60_000 = 真の UTC ms。
  return naiveUtcMs - offsetMin * 60_000
}

/**
 * 与えられた瞬間 (UTC ms) で America/New_York が UTC から何分 offset している
 * かを Intl 経由で probe。DST 切替を吸収する。
 *
 * 計算は `Intl.DateTimeFormat({ timeZone: 'America/New_York', timeZoneName:
 * 'shortOffset' })` で 'GMT-4' / 'GMT-5' 文字列を取得 → 数値化。
 */
function etOffsetMinutesAt(utcMs: number): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
    })
    const parts = fmt.formatToParts(new Date(utcMs))
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    // 'GMT-4' / 'GMT-04:00' / 'GMT-5' などをサポート。
    const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(tzName)
    if (!match) return -300 // 失敗時は EST 相当に倒す (POC default)
    const sign = match[1] === '-' ? -1 : 1
    const hours = Number(match[2])
    const mins = match[3] !== undefined ? Number(match[3]) : 0
    return sign * (hours * 60 + mins)
  } catch {
    return -300
  }
}
