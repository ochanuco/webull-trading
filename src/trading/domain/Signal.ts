export type SignalAction = 'BUY' | 'SELL' | 'HOLD'

export interface Signal {
  action: SignalAction
  symbol: string
  quantity: number
  price: number
  reason: string
  generatedAt: string
}
