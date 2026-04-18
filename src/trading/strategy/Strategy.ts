import type { Signal } from '../domain/Signal'

export interface StrategyInput {
  symbol: string
  price: number
  quantity: number
}

export interface Strategy {
  readonly name: string
  decide(input: StrategyInput): Signal
}
