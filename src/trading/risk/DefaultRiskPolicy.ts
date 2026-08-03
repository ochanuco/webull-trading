import type { RiskDecision } from '../domain/RiskDecision'
import { inferTradingMarket, isWithinStrategyWindow } from '../domain/tradingCalendar'
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
    const normalizedIntent = { ...input.orderIntent }
    const maxNotional = input.symbolMaxNotional[symbol] ?? input.maxOrderNotional

    if (!input.tradingEnabled) {
      reasons.push('trading is disabled')
    }

    if (!input.allowedSymbols.includes(symbol)) {
      reasons.push(`symbol ${input.orderIntent.symbol} is not allowed`)
    }

    // #656: 独自の US-only / 祝日非対応の時刻判定をやめ、tradingCalendar の市場別
    // (US/JP) レギュラーセッション判定 (祝日・半日取引対応) に委譲する。
    if (input.marketHoursCheck) {
      const market = inferTradingMarket(symbol)
      if (!isWithinStrategyWindow((input.now ?? defaultNow)(), market, 0)) {
        reasons.push(`market hours check failed: outside ${market} regular trading session`)
      }
    }

    if (normalizedIntent.notional > maxNotional) {
      reasons.push(
        `order notional ${normalizedIntent.notional} exceeds max ${maxNotional}`,
      )
    }

    return this.buildDecision(reasons, input, normalizedIntent)
  }

  private buildDecision(reasons: string[], input: RiskInput, normalizedIntent: RiskInput['orderIntent']): RiskDecision {
    if (reasons.length > 0) {
      return {
        allowed: false,
        reasons,
      }
    }

    return {
      allowed: true,
      reasons: [],
      normalizedIntent,
    }
  }
}

function defaultNow(): Date {
  return new Date()
}