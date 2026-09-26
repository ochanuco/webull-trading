import {
  inferTradingMarket,
  isTradingDay,
  type TradingMarket,
} from '../domain/tradingCalendar'
import type { EarningsCalendarRepo } from '../../infrastructure/calendar/earningsCalendarRepo'

export interface EarningsGateInput {
  symbol: string
  /** ISO "YYYY-MM-DD"; the gate operates at day granularity, not time-of-day. */
  evalDate: string
  side: 'BUY' | 'SELL'
}

export interface EarningsGateConfig {
  /** Business days frozen on each side of the earnings date (0 = earnings day only). */
  freezeBusinessDays: number
}

export interface EarningsGateDecision {
  approved: boolean
  /** Reject reason as `earnings_within_${freezeBusinessDays}bd: ${earningsDate}` — parsed by the dashboard's localizeReason. */
  reason?: string
}

const DEFAULT_CONFIG: EarningsGateConfig = { freezeBusinessDays: 1 }

/**
 * Rejects BUY within `freezeBusinessDays` of a symbol's earnings date. SELL
 * always passes — gating exits would trap positions instead of protecting them.
 */
export async function evaluateEarningsGate(
  input: EarningsGateInput,
  repo: EarningsCalendarRepo,
  config: EarningsGateConfig = DEFAULT_CONFIG,
): Promise<EarningsGateDecision> {
  if (input.side === 'SELL') return { approved: true }

  const evalDay = parseYmdUtc(input.evalDate)
  if (evalDay === null) {
    return {
      approved: false,
      reason: `earnings_gate_invalid_eval_date: ${input.evalDate}`,
    }
  }

  const freeze = sanitizeFreezeDays(config.freezeBusinessDays)
  const market = inferTradingMarket(input.symbol)
  const windowFrom = shiftBusinessDays(evalDay, -freeze, market)
  const windowTo = shiftBusinessDays(evalDay, freeze, market)

  let rows: Awaited<ReturnType<EarningsCalendarRepo['fetchByRange']>>
  try {
    rows = await repo.fetchByRange(input.symbol, toYmd(windowFrom), toYmd(windowTo))
  } catch (err) {
    // Fail closed: a D1 outage must not look identical to "no earnings soon".
    const msg = err instanceof Error ? err.message : String(err)
    return {
      approved: false,
      reason: `earnings_gate_fetch_failed: ${msg}`,
    }
  }

  if (rows.length === 0) return { approved: true }

  // ISO dates sort lexicographically; scan for the min rather than trusting repo order.
  let nearest = rows[0]!.earningsDate
  for (const r of rows) {
    if (r.earningsDate < nearest) nearest = r.earningsDate
  }

  return {
    approved: false,
    reason: `earnings_within_${freeze}bd: ${nearest}`,
  }
}

// Capped at 30 business days (~6 weeks) so a misconfigured freeze can't lock out entries indefinitely.
function sanitizeFreezeDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIG.freezeBusinessDays
  if (value < 0) return DEFAULT_CONFIG.freezeBusinessDays
  if (value > 30) return 30
  return Math.floor(value)
}

const MS_PER_DAY = 86_400_000
const MAX_SHIFT_ITER = 90

// MAX_SHIFT_ITER bounds a pathological holiday run so this can't infinite-loop.
function shiftBusinessDays(from: Date, count: number, market: TradingMarket): Date {
  if (count === 0) return from
  const direction = count > 0 ? 1 : -1
  const remaining = Math.abs(count)
  let cursor = new Date(from.getTime())
  let shifted = 0
  for (let i = 0; i < MAX_SHIFT_ITER && shifted < remaining; i += 1) {
    cursor = new Date(cursor.getTime() + direction * MS_PER_DAY)
    if (isTradingDay(cursor, market)) shifted += 1
  }
  return cursor
}

function parseYmdUtc(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const ms = Date.parse(`${ymd}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return null
  return new Date(ms)
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
