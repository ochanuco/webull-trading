export type SignalAction = 'BUY' | 'SELL' | 'HOLD'

export type GeneratedAtIso = string

export interface Signal {
  action: SignalAction
  symbol: string
  quantity: number
  price: number
  reason: string
  generatedAtIso: GeneratedAtIso
}