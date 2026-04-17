import type { Signal } from '../domain/Signal'

export interface StrategyInput {
  symbol: string
  price: number
  quantity: number
}

export interface Strategy {
  decide(input: StrategyInput): Signal
}
