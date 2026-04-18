import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { RiskDecision } from '../../trading/domain/RiskDecision'
import type { Signal } from '../../trading/domain/Signal'

export type TradeEventType =
  | 'decision'
  | 'intent'
  | 'pre_submit'
  | 'post_submit'
  | 'fill'
  | 'exit'

export interface TradeJournalRecord {
  timestamp: string
  trade_event_type: TradeEventType
  request_id?: string
  client_order_id?: string
  order_id?: string
  symbol?: string
  strategy_name?: string
  signal_action?: Signal['action']
  signal_reason?: string
  risk_allowed?: boolean
  risk_reasons?: string[]
  side?: OrderIntent['side']
  quantity?: number
  limit_price?: number
  notional?: number
  latency_ms?: number
  broker_status?: string
  mode?: ExecutionResult['mode']
  submitted?: boolean
  filled_qty?: number
  filled_price?: number
  realized_pnl?: number
  hold_days?: number
  exit_reason?: 'TP' | 'SL' | 'TIME_STOP' | 'OTHER'
  error_class?: string
  error_message?: string
}

type LogSink = (line: string) => void

let sink: LogSink = (line) => {
  console.log(line)
}

/**
 * For tests only: redirect trade-journal output to a custom sink.
 * Returns a restore function that puts the previous sink back.
 */
export function setTradeJournalSink(next: LogSink): () => void {
  const previous = sink
  sink = next
  return () => {
    sink = previous
  }
}

function emit(record: TradeJournalRecord): void {
  sink(JSON.stringify(record))
}

export function logTradeDecision(input: {
  requestId?: string
  symbol: string
  strategyName: string
  signal: Signal
  riskDecision: RiskDecision
}): void {
  emit({
    timestamp: new Date().toISOString(),
    trade_event_type: 'decision',
    request_id: input.requestId,
    symbol: input.symbol,
    strategy_name: input.strategyName,
    signal_action: input.signal.action,
    signal_reason: input.signal.reason,
    risk_allowed: input.riskDecision.allowed,
    risk_reasons: input.riskDecision.reasons,
  })
}

export function logTradeIntent(input: {
  requestId?: string
  clientOrderId: string
  intent: OrderIntent
}): void {
  emit({
    timestamp: new Date().toISOString(),
    trade_event_type: 'intent',
    request_id: input.requestId,
    client_order_id: input.clientOrderId,
    symbol: input.intent.symbol,
    side: input.intent.side,
    quantity: input.intent.quantity,
    limit_price: input.intent.price,
    notional: input.intent.notional,
  })
}

export function logPreSubmit(input: {
  requestId?: string
  clientOrderId: string
  intent: OrderIntent
}): void {
  emit({
    timestamp: new Date().toISOString(),
    trade_event_type: 'pre_submit',
    request_id: input.requestId,
    client_order_id: input.clientOrderId,
    symbol: input.intent.symbol,
    side: input.intent.side,
    quantity: input.intent.quantity,
    limit_price: input.intent.price,
    notional: input.intent.notional,
  })
}

export function logPostSubmit(input: {
  requestId?: string
  clientOrderId: string
  symbol: string
  result?: ExecutionResult
  latencyMs?: number
  error?: Error
}): void {
  emit({
    timestamp: new Date().toISOString(),
    trade_event_type: 'post_submit',
    request_id: input.requestId,
    client_order_id: input.clientOrderId,
    symbol: input.symbol,
    order_id: input.result?.brokerOrderId,
    mode: input.result?.mode,
    submitted: input.result?.submitted,
    latency_ms: input.latencyMs,
    broker_status: input.result?.errorReason,
    error_class: input.error?.constructor.name,
    error_message: input.error?.message ? truncate(input.error.message, 200) : undefined,
  })
}

export function logFill(input: {
  clientOrderId?: string
  orderId?: string
  symbol: string
  filledQty?: number
  filledPrice?: number
  status?: string
}): void {
  emit({
    timestamp: new Date().toISOString(),
    trade_event_type: 'fill',
    client_order_id: input.clientOrderId,
    order_id: input.orderId,
    symbol: input.symbol,
    filled_qty: input.filledQty,
    filled_price: input.filledPrice,
    broker_status: input.status,
  })
}

export function logExit(input: {
  clientOrderId?: string
  orderId?: string
  symbol: string
  realizedPnl: number
  holdDays: number
  exitReason: NonNullable<TradeJournalRecord['exit_reason']>
}): void {
  emit({
    timestamp: new Date().toISOString(),
    trade_event_type: 'exit',
    client_order_id: input.clientOrderId,
    order_id: input.orderId,
    symbol: input.symbol,
    realized_pnl: input.realizedPnl,
    hold_days: input.holdDays,
    exit_reason: input.exitReason,
  })
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}
