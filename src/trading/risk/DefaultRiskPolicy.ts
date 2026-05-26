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
    const normalizedIntent = { ...input.orderIntent }
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

const NY_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function getNyTimeParts(now: Date): { weekday: number; minutes: number } {
  const parts = NY_TIME_FORMATTER.formatToParts(now)
  let weekday = -1
  let hour = -1
  let minute = -1
  for (const part of parts) {
    if (part.type === 'weekday') {
      weekday = WEEKDAY_TO_INDEX[part.value] ?? -1
    } else if (part.type === 'hour') {
      // Intl returns "24" for midnight when hour12 is false on some runtimes; normalize to 0.
      const parsed = Number.parseInt(part.value, 10)
      hour = parsed === 24 ? 0 : parsed
    } else if (part.type === 'minute') {
      minute = Number.parseInt(part.value, 10)
    }
  }
  return { weekday, minutes: hour * 60 + minute }
}

function isWithinUsEquityRegularTradingHours(now: Date): boolean {
  const { weekday, minutes } = getNyTimeParts(now)
  if (weekday === 0 || weekday === 6) {
    return false
  }
  // US equity regular session: 09:30–16:00 America/New_York (DST handled by Intl).
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}