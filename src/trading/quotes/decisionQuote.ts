import { inferTradingMarket, isWithinStrategyWindow } from '../domain/tradingCalendar'
import type { QuoteSnapshot } from '../state/types'

/** A cached fetch timestamp alone must not make an old market price executable. */
export function freshDecisionQuote(
  symbol: string,
  quote: QuoteSnapshot | null,
  now: Date,
  maxAgeMs = 5 * 60_000,
): QuoteSnapshot | null {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 ||
      !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return null
  if (quote.source !== 'webull-snapshot' && quote.source !== 'yahoo-snapshot') return null
  const asOf = Date.parse(quote.asOf)
  const fetchedAt = Date.parse(quote.fetchedAt)
  const clock = now.getTime()
  if (![asOf, fetchedAt, clock].every(Number.isFinite) ||
      asOf > clock || fetchedAt > clock ||
      clock - asOf > maxAgeMs || clock - fetchedAt > maxAgeMs) return null
  const market = inferTradingMarket(symbol)
  if (!isWithinStrategyWindow(now, market, 0) ||
      !isWithinStrategyWindow(new Date(asOf), market, 0)) return null
  return quote
}
