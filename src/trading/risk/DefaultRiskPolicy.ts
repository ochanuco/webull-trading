import type { RiskDecision } from '../domain/RiskDecision'
import type { RiskInput, RiskPolicy } from './RiskPolicy'

export class DefaultRiskPolicy implements RiskPolicy {
  evaluate(input: RiskInput): RiskDecision {
    if (!input.orderIntent) {
      return {
        allowed: true,
        reasons: [],
      }
    }

    const reasons: string[] = []

    if (!input.tradingEnabled) {
      reasons.push('trading is disabled')
    }

    if (!input.allowedSymbols.includes(input.orderIntent.symbol.toUpperCase())) {
      reasons.push(`symbol ${input.orderIntent.symbol} is not allowed`)
    }

    if (input.orderIntent.notional > input.maxOrderNotional) {
      reasons.push(
        `order notional ${input.orderIntent.notional} exceeds max ${input.maxOrderNotional}`,
      )
    }

    return this.buildDecision(reasons, input)
  }

  private buildDecision(reasons: string[], input: RiskInput): RiskDecision {
    if (reasons.length > 0) {
      return {
        allowed: false,
        reasons,
      }
    }

    return {
      allowed: true,
      reasons: [],
      normalizedIntent: input.orderIntent,
    }
  }
}
