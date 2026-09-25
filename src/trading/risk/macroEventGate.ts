/**
 * Freezes BUY entries within ±N hours of a macro calendar event (FOMC / CPI /
 * NFP / PCE / GDP / ISM). Symbol-agnostic; applies to every cron symbol.
 * SELL is never gated so an existing position can still exit across an event.
 */
import type { MacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import type { MacroEventCalendarRow } from '../../infrastructure/db/schema'

export interface MacroEventGateInput {
  /** ISO datetime of the cron tick being evaluated (window is centered on this). */
  evalTimestamp: string
  /** SELL always approves — the gate only freezes new entries. */
  side: 'BUY' | 'SELL'
}

export interface MacroEventGateConfig {
  /** Freeze window before the event, in hours. Default 1. */
  freezeHoursBefore: number
  /** Freeze window after the event, in hours. Default 6, clamped to 6h by `sanitizeHours`. */
  freezeHoursAfter: number
  /** Freeze the full event_date when `event_time` is NULL. Default true. */
  freezeFullDayWhenTimeUnknown: boolean
}

export interface MacroEventGateDecision {
  approved: boolean
  /** Reject reason, e.g. `macro_event_gate: FOMC 2026-06-17 14:00ET` or `..._fetch_failed: <error>`. */
  reason?: string
  /** Event that caused the rejection, for operator UI / logs. */
  triggeringEvent?: { type: string; date: string; time: string | null }
}

export const DEFAULT_MACRO_GATE_CONFIG: MacroEventGateConfig = {
  freezeHoursBefore: 1,
  freezeHoursAfter: 6,
  freezeFullDayWhenTimeUnknown: true,
}

const MS_PER_HOUR = 3_600_000

/** Pure aside from `repo.fetchByDateRange`. Any repo/parse failure fails closed (reject). */
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

  // ±1 day around the ET eval date, not just the eval date itself: a freeze
  // window can straddle ET midnight, and this stays wide enough for any
  // freeze up to the sanitizeHours 6h cap.
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
    // Validated before either branch: the NULL-time branch below only does a
    // string equality check, so a malformed event_date would never match and
    // would silently pass (fail-open) instead of rejecting.
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
      const eventMs = etWallClockToUtcMs(row.eventDate, row.eventTime)
      if (eventMs === null) {
        // Skipping an unparseable row would let BUY through for that event —
        // reject instead of silently passing it.
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
      const delta = evalMs - eventMs
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

// Clamped to 6h: beyond that the ±1 day fetch window in evaluateMacroEventGate
// would no longer cover the freeze range.
function sanitizeHours(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < 0) return fallback
  if (value > 6) return 6
  return value
}

// en-CA formats as YYYY-MM-DD directly, avoiding a manual split of another locale's output.
function formatEtYmd(date: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(date)
}

// Date.parse alone would fail-open: JS Date silently normalizes an invalid
// calendar day (e.g. 2026-02-30 -> 2026-03-02), so round-trip through
// toISOString and compare against the input.
function isStrictYmd(ymd: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return false
  return new Date(ms).toISOString().slice(0, 10) === ymd
}

function shiftYmd(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return ymd
  const shifted = new Date(ms + days * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

// Converts event_date + event_time (both ET) to UTC ms. Does not special-case
// the DST transition hour itself — a ~1h error there is accepted rather than
// pulling in a full tz library for this POC gate.
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
  // Round-trip through toISOString to reject a nonexistent calendar day (e.g.
  // 2026-02-30) that JS Date would otherwise silently normalize.
  const roundTrip = new Date(naiveUtcMs).toISOString()
  if (roundTrip.slice(0, 10) !== eventDate) return null
  if (roundTrip.slice(11, 16) !== eventTime) return null
  const offsetMin = etOffsetMinutesAt(naiveUtcMs)
  // ET offset is negative (west of UTC), so subtracting it from the naive
  // UTC ms moves the time later, back to the true UTC instant.
  return naiveUtcMs - offsetMin * 60_000
}

// Probes America/New_York's UTC offset at a given instant via Intl (DST-aware).
function etOffsetMinutesAt(utcMs: number): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
    })
    const parts = fmt.formatToParts(new Date(utcMs))
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
    const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(tzName)
    if (!match) return -300 // Intl parse failure falls back to EST.
    const sign = match[1] === '-' ? -1 : 1
    const hours = Number(match[2])
    const mins = match[3] !== undefined ? Number(match[3]) : 0
    return sign * (hours * 60 + mins)
  } catch {
    return -300 // Intl unavailable falls back to EST.
  }
}
