export interface TradeEvent {
  eventType: string
  orderId: string
  symbol: string
  status: string
  filledQty?: number
  rawPayload: unknown
  receivedAt: string
}
