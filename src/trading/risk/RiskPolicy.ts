import type { OrderIntent } from '../domain/OrderIntent'
import type { RiskDecision } from '../domain/RiskDecision'
import type { Signal } from '../domain/Signal'

export interface RiskInput {
  signal: Signal
  orderIntent?: OrderIntent
  tradingEnabled: boolean
  allowedSymbols: string[]
  maxOrderNotional: number
}

export interface RiskPolicy {
  evaluate(input: RiskInput): RiskDecision
}
