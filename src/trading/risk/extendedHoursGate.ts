/**
 * Extended-hours (premarket) gate: scales BUY size from the same-day premarket
 * observation written by `extendedHoursScheduler`. SELL always passes —
 * premarket's thin volume and wide spreads are too weak a signal to force an exit.
 *
 * Unlike `newsShockGate`/`newsShockDecision`, the pure evaluation and the D1
 * read live in one file here: this gate only reads one table's latest row per
 * symbol, not `newsShockGate`'s multi-probe/baseline/tone composite, so the
 * split isn't worth the extra file.
 */
import { isTradingDay } from '../domain/tradingCalendar'
import { formatNyYmd } from '../../infrastructure/calendar/usMarketCalendar'
import {
  createExtendedHoursObservationDb,
  createExtendedHoursObservationRepo,
} from '../../infrastructure/db/extendedHoursObservationRepo'

/** Bounded so a premarket warning doesn't carry the morning's caution into the afternoon. */
export const GATE_VALID_MINUTES_AFTER_OPEN = 120

// Duplicated from tradingCalendar's MARKET_SESSION.US — keep in sync if that changes.
const US_OPEN_ET_MINUTES = 9 * 60 + 30

type ExtendedHoursGateAction = 'reduce_entry' | 'block_entry'

export interface ExtendedHoursGateDecision {
  action: ExtendedHoursGateAction
  /** BUY qty multiplier: reduce_entry=0.5 / block_entry=0. */
  multiplier: number
  reason: string
}

// Same pattern as isNewsShockGateReady: probing sqlite_master before querying
// avoids a fail-closed cascade on un-migrated preview/dev environments.
export async function isExtendedHoursGateReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='extended_hours_observation' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/**
 * Pure — maps an observation status to a gate decision. NORMAL/UNKNOWN
 * return null (fail-open; not included in the decision map) rather than
 * fail-closed, deferring to `assessPreMarket`'s own stale/missing handling.
 * STOP_AT_OPEN_CANDIDATE blocks entirely rather than reducing, since a fresh
 * BUY there risks an immediate stop-out at the open.
 */
export function extendedHoursStatusToDecision(status: string): ExtendedHoursGateDecision | null {
  if (status === 'WARNING') {
    return {
      action: 'reduce_entry',
      multiplier: 0.5,
      reason: 'extended_hours: WARNING (premarket gap/stop proximity)',
    }
  }
  if (status === 'STOP_AT_OPEN_CANDIDATE') {
    return {
      action: 'block_entry',
      multiplier: 0,
      reason: 'extended_hours: STOP_AT_OPEN_CANDIDATE (premarket below effective stop)',
    }
  }
  return null
}

/**
 * Pure — whether `now` falls within US open through
 * {@link GATE_VALID_MINUTES_AFTER_OPEN} minutes after. ET wall-clock comes
 * from `Intl.DateTimeFormat` for automatic DST handling, same approach as
 * `tradingCalendar.evaluateStrategyWindow`; since the window sits entirely in
 * ET morning hours it can't cross midnight, so there's no UTC/ET calendar-day
 * mismatch to guard against.
 */
export function isWithinExtendedHoursGateWindow(now: Date): boolean {
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
  const etMinutes = (hour % 24) * 60 + minute // hour12:false can return '24'; % 24 normalizes it
  return (
    etMinutes >= US_OPEN_ET_MINUTES && etMinutes < US_OPEN_ET_MINUTES + GATE_VALID_MINUTES_AFTER_OPEN
  )
}

/**
 * Reads today's (NY session) latest observation per symbol from
 * `extended_hours_observation` and returns symbol (uppercased) → decision.
 * Never fetches — this module only reads what `extendedHoursScheduler`
 * already wrote. Outside the valid window it returns an empty map without
 * touching D1, since the fresh 15-minute strategy tick shouldn't pay for a
 * read that can't produce a decision.
 */
export async function loadExtendedHoursGateDecisions(
  db: D1Database,
  now: Date,
): Promise<Map<string, ExtendedHoursGateDecision>> {
  const decisions = new Map<string, ExtendedHoursGateDecision>()
  if (!isWithinExtendedHoursGateWindow(now)) return decisions
  const repo = createExtendedHoursObservationRepo(createExtendedHoursObservationDb(db))
  const rows = await repo.latestPerSymbol(formatNyYmd(now))
  for (const row of rows) {
    const decision = extendedHoursStatusToDecision(row.status)
    if (decision) decisions.set(row.symbol.toUpperCase(), decision)
  }
  return decisions
}
