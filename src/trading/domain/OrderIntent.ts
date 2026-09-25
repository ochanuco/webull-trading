export type OrderSide = 'BUY' | 'SELL'

export interface OrderIntent {
  symbol: string
  side: OrderSide
  quantity: number
  price: number
  notional: number
  /** Broker-facing idempotency key, generated once and carried through decision → submit → fill for audit correlation. */
  clientOrderId: string
}
