export const TRADE_EVENT_TYPES = ['ORDER_PLACED', 'ORDER_FILLED', 'ORDER_CANCELED'] as const
export type TradeEventType = (typeof TRADE_EVENT_TYPES)[number]

export const TRADE_STATUSES = ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED'] as const
export type TradeStatus = (typeof TRADE_STATUSES)[number]

export function isTradeEventType(value: string): value is TradeEventType {
  return (TRADE_EVENT_TYPES as readonly string[]).includes(value)
}

export function isTradeStatus(value: string): value is TradeStatus {
  return (TRADE_STATUSES as readonly string[]).includes(value)
}

export interface TradeEvent {
  eventType: TradeEventType
  orderId: string
  symbol: string
  status: TradeStatus
  filledQty?: number
  rawPayload: unknown
  receivedAt: string
}
