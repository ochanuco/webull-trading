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
