import type { TradeEvent } from '../domain/TradeEvent'
import { logFill } from '../../infrastructure/logger/tradeJournal'

export interface TradeEventAuditRecord {
  source: 'trade-event'
  eventType: string
  orderId: string
  symbol: string
  status: string
  filledQty?: number
  receivedAt: string
}

export class TradeEventHandler {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async handle(event: TradeEvent): Promise<void> {
    const orderId = event.orderId.trim()
    const symbol = event.symbol.trim().toUpperCase()
    const status = event.status.trim()

    const record: TradeEventAuditRecord = {
      source: 'trade-event',
      eventType: event.eventType.trim(),
      orderId,
      symbol,
      status,
      receivedAt: event.receivedAt,
    }

    if (event.filledQty !== undefined) {
      record.filledQty = event.filledQty
    }

    this.log(JSON.stringify(record))

    // Emit a parallel trade-journal line so a single query by client_order_id
    // can reconstruct the full decision → fill lifecycle.
    const clientOrderId = readClientOrderId(event.rawPayload)
    const filledPrice = readFilledPrice(event.rawPayload)

    logFill({
      clientOrderId,
      orderId,
      symbol,
      filledQty: event.filledQty,
      filledPrice,
      status,
    })
  }
}

function readClientOrderId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload.client_order_id ?? payload.clientOrderId
  return typeof value === 'string' ? value : undefined
}

function readFilledPrice(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload.filled_price ?? payload.filledPrice ?? payload.price
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
