import type { TradeEvent } from '../domain/TradeEvent'

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
    const record: TradeEventAuditRecord = {
      source: 'trade-event',
      eventType: event.eventType.trim(),
      orderId: event.orderId.trim(),
      symbol: event.symbol.trim().toUpperCase(),
      status: event.status.trim(),
      receivedAt: event.receivedAt,
    }

    if (event.filledQty !== undefined) {
      record.filledQty = event.filledQty
    }

    this.log(JSON.stringify(record))
  }
}
