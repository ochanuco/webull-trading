import type { Signal } from '../../domain/Signal'
import type { Strategy, StrategyInput } from '../Strategy'

export class FixedRuleStrategy implements Strategy {
  constructor(
    private readonly buyBelow: number,
    private readonly sellAbove: number,
  ) {}

  decide(input: StrategyInput): Signal {
    const action = this.resolveAction(input.price)

    return {
      action,
      symbol: input.symbol,
      quantity: input.quantity,
      price: input.price,
      reason: this.buildReason(action, input.price),
      generatedAt: new Date().toISOString(),
    }
  }

  private resolveAction(price: number): Signal['action'] {
    if (price <= this.buyBelow) {
      return 'BUY'
    }
    if (price >= this.sellAbove) {
      return 'SELL'
    }
    return 'HOLD'
  }

  private buildReason(action: Signal['action'], price: number): string {
    if (action === 'BUY') {
      return `price ${price} is at or below buy threshold ${this.buyBelow}`
    }
    if (action === 'SELL') {
      return `price ${price} is at or above sell threshold ${this.sellAbove}`
    }
    return `price ${price} is between buy threshold ${this.buyBelow} and sell threshold ${this.sellAbove}`
  }
}
