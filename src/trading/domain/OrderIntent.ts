export type OrderSide = 'BUY' | 'SELL'

export interface OrderIntent {
  symbol: string
  side: OrderSide
  quantity: number
  price: number
  notional: number
  /**
   * Broker-facing idempotency key. Generated once when the intent is
   * constructed so the same id flows through decision → submit → fill
   * for audit correlation.
   */
  clientOrderId: string
}
