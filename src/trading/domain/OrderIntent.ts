export type OrderSide = 'BUY' | 'SELL'

export interface OrderIntent {
  symbol: string
  side: OrderSide
  quantity: number
  price: number
  notional: number
}
