import type { RiskDecision } from '../domain/RiskDecision'
import type { RiskInput, RiskPolicy } from './RiskPolicy'

export class DefaultRiskPolicy implements RiskPolicy {
  evaluate(input: RiskInput): RiskDecision {
    if (!input.orderIntent) {
      return {
        allowed: false,
        reasons: ['orderIntent is missing'],
      }
    }

    const reasons: string[] = []
    const symbol = input.orderIntent.symbol.toUpperCase()
    const maxNotional = input.symbolMaxNotional[symbol] ?? input.maxOrderNotional

    if (!input.tradingEnabled) {
      reasons.push('trading is disabled')
    }

    if (!input.allowedSymbols.includes(symbol)) {
      reasons.push(`symbol ${input.orderIntent.symbol} is not allowed`)
    }

    if (input.marketHoursCheck && !isWithinUsEquityRegularTradingHours((input.now ?? defaultNow)())) {
      reasons.push('market hours check failed: outside US equity regular trading hours')
    }

    if (input.orderIntent.notional > maxNotional) {
      reasons.push(
        `order notional ${input.orderIntent.notional} exceeds max ${maxNotional}`,
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

function defaultNow(): Date {
  return new Date()
}

function isWithinUsEquityRegularTradingHours(now: Date): boolean {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }

  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  // TODO(Phase 5): handle DST accurately
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60
}
