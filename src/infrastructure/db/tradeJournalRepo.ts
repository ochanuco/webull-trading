import { and, eq, gte, like, or, sql } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import type { TradeJournalRecord } from '../logger/tradeJournal'
import { tradeJournal, type TradeJournalInsert } from './schema'

export type TradeJournalDb = DrizzleD1Database

/** Wraps a Worker `env.DB` (D1Database) into a drizzle-typed client. */
export function createDb(d1: D1Database): TradeJournalDb {
  return drizzle(d1)
}

/** Append a journal record. Intended to be called from a log sink. */
export async function insertJournalRecord(
  db: TradeJournalDb,
  record: TradeJournalRecord,
): Promise<void> {
  await db.insert(tradeJournal).values(toInsertRow(record))
}

/**
 * Returns true when at least one trade_journal row for `symbol` within the
 * last `withinMs` ms has a `state_apply_error` indicating a sanity failure
 * (broker stub fill detected by `resolveFilledPrice`'s ratio guard) or the
 * `repair_skipped_invalid_row` variant emitted by `reconcileFills`'s repair
 * mode for the same root cause.
 *
 * Designed for the cron BUY-side cooldown (issue: 9697 04/28 06 fills
 * incident) — when a sanity failure was just observed, the broker side may
 * have already accumulated phantom shares, while the DO position remains
 * null. Letting cron continue to BUY in that window stacks positions
 * silently. This helper is the predicate for `runPullbackScheduler`'s
 * `sanityFailedCooldown` gate.
 *
 * Both markers are checked because PR #225 changed the repair path so that
 * an earlier `sanity_failed` row may be overwritten by `repair_skipped_invalid_row`
 * on the next reconcile attempt — either marker is evidence of the same
 * underlying broker-stub condition.
 */
export async function hasRecentSanityFailure(
  d1: D1Database,
  symbol: string,
  withinMs: number,
  options?: { now?: () => Date },
): Promise<boolean> {
  if (!Number.isFinite(withinMs) || withinMs <= 0) return false
  const db = createDb(d1)
  const nowFn = options?.now ?? (() => new Date())
  const cutoff = new Date(nowFn().getTime() - withinMs).toISOString()
  const upper = symbol.toUpperCase()
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(tradeJournal)
    .where(
      and(
        eq(tradeJournal.symbol, upper),
        gte(tradeJournal.timestamp, cutoff),
        or(
          like(tradeJournal.stateApplyError, '%sanity_failed%'),
          like(tradeJournal.stateApplyError, '%repair_skipped_invalid_row%'),
        ),
      ),
    )
  const first = rows[0]
  return (first?.count ?? 0) > 0
}

function toInsertRow(r: TradeJournalRecord): TradeJournalInsert {
  return {
    timestamp: r.timestamp,
    tradeEventType: r.trade_event_type,
    requestId: r.request_id ?? null,
    clientOrderId: r.client_order_id ?? null,
    orderId: r.order_id ?? null,
    symbol: r.symbol ?? null,
    strategyName: r.strategy_name ?? null,
    signalAction: r.signal_action ?? null,
    signalReason: r.signal_reason ?? null,
    riskAllowed: r.risk_allowed ?? null,
    riskReasons: r.risk_reasons ? JSON.stringify(r.risk_reasons) : null,
    side: r.side ?? null,
    quantity: r.quantity ?? null,
    limitPrice: r.limit_price ?? null,
    notional: r.notional ?? null,
    latencyMs: r.latency_ms ?? null,
    brokerStatus: r.broker_status ?? null,
    mode: r.mode ?? null,
    submitted: r.submitted ?? null,
    filledQty: r.filled_qty ?? null,
    filledPrice: r.filled_price ?? null,
    realizedPnl: r.realized_pnl ?? null,
    holdDays: r.hold_days ?? null,
    exitReason: r.exit_reason ?? null,
    errorClass: r.error_class ?? null,
    errorMessage: r.error_message ?? null,
  }
}
