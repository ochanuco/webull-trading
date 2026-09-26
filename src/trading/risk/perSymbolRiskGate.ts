/**
 * Pure per-symbol entry/exit gate (one observability `console.warn` exception
 * when the spread guard is skipped for a bid/ask-less quote source).
 *
 * Unifies the guards previously duplicated between manual `/trade/execute`
 * (TradingService) and the cron scheduler. All gates except cooldown are
 * BUY-only: SELL/exit always proceeds through stale quotes, wide spreads,
 * large gaps, or an out-of-band JP price so a stop-out is never blocked by
 * bad market data.
 *
 * Inverse-pair evaluation needs the paired symbol's SymbolState fetched
 * synchronously by the caller and passed in as `inverseState`.
 */
import type { QuoteSnapshot, SymbolState } from '../state/types'
import { inferWebullMarket } from '../../infrastructure/webull/mapper'
import { YAHOO_QUOTE_SOURCE } from '../../infrastructure/quotes/YahooQuoteClient'
import { isWithinJpPriceBand } from './jpPriceBand'
import { computeSpreadPct } from './spreadGuard'

// Sources that structurally never return bid/ask (e.g. Yahoo's chart meta).
// Missing bid/ask here is expected, not anomalous, so the spread guard is
// skipped rather than fail-closed; any other source's missing bid/ask still
// fail-closes as a data anomaly.
const QUOTE_SOURCES_WITHOUT_BID_ASK: ReadonlySet<string> = new Set([YAHOO_QUOTE_SOURCE])

export interface PerSymbolRiskInput {
  symbol: string
  side: 'BUY' | 'SELL'
  /** Order limit price (used for JP price band). */
  intentPrice: number
  /** Order notional (qty × price), used for settled-cash gate. */
  intentNotional: number
  /** Latest known SymbolState for `symbol` (cooldown / position / lastQuote / settledCash). */
  state: SymbolState
  /**
   * Pre-fetched SymbolState for the inverse symbol (per `config.inversePairs`).
   * `null` when the symbol has no inverse mapping or fetch failed (fail-open
   * for inverse only — fetch errors are not the gate's responsibility).
   */
  inverseState?: SymbolState | null
  /** Wall clock for cooldown / freshness comparisons. */
  now: Date
}

export interface PerSymbolRiskConfig {
  /**
   * Symbol → inverse symbol map (already upper-cased keys). When BUY is
   * requested for `symbol` and `inverseState.position.qty > 0`, reject.
   */
  inversePairs: Record<string, string>
  /** Per-market spread limits as fractions of mid (e.g. 0.0025 = 0.25%). */
  spreadLimits: { US: number; JP: number }
  /** Max age (ms) of lastQuote.fetchedAt before it's treated as halted/stale. */
  staleQuoteMs: number
  /** Reject threshold for |lastQuote.price - position.avgPrice| / avgPrice. */
  gapRejectPct: number
  /**
   * Enable cooldown evaluation. The cron path's Strategy.decide() already
   * enforces cooldown, so it passes false; the manual TradingService path
   * passes true to keep its pre-existing behavior.
   */
  evaluateCooldown?: boolean
}

export interface PerSymbolRiskDecision {
  approved: boolean
  /** Only the first gate to reject is reported, even if several would. */
  reasons: string[]
}

const APPROVED: PerSymbolRiskDecision = Object.freeze({ approved: true, reasons: [] })

export function evaluatePerSymbolRisk(
  input: PerSymbolRiskInput,
  config: PerSymbolRiskConfig,
): PerSymbolRiskDecision {
  const { state, side, symbol, now, intentNotional, intentPrice } = input

  if (config.evaluateCooldown && state.cooldownUntil) {
    const until = new Date(state.cooldownUntil).getTime()
    if (Number.isFinite(until) && until > now.getTime()) {
      return reject(`cooldown active until ${state.cooldownUntil}`)
    }
  }

  if (side === 'BUY' && state.settledCash > 0 && intentNotional > state.settledCash) {
    return reject(
      `insufficient settled cash: notional ${intentNotional} exceeds settledCash ${state.settledCash}`,
    )
  }

  // Keeps a regime-hedge pair (e.g. SOXL/SOXS) from being held both-long at
  // once, which would be structurally dead money — one side must SELL out
  // before the other's BUY is allowed through.
  if (side === 'BUY') {
    const inverseSymbol = config.inversePairs[symbol.toUpperCase()]
    if (inverseSymbol && input.inverseState) {
      const inversePos = input.inverseState.position
      if (inversePos !== null && inversePos.qty > 0) {
        return reject(
          `inverse-pair exposure: ${inverseSymbol} position (qty ${inversePos.qty}) blocks BUY ${symbol}`,
        )
      }
    }
  }

  if (side === 'BUY' && state.lastQuote) {
    const ageMs = now.getTime() - new Date(state.lastQuote.fetchedAt).getTime()
    if (!Number.isFinite(ageMs) || ageMs > config.staleQuoteMs) {
      return reject(
        `halt or stale quote: lastQuote ${state.lastQuote.fetchedAt} exceeds staleQuoteMs ${config.staleQuoteMs}`,
      )
    }
  }

  if (side === 'BUY') {
    const spreadReason = evaluateSpreadGate(symbol, state.lastQuote, config.spreadLimits, now)
    if (spreadReason !== null) {
      return reject(spreadReason)
    }
  }

  if (side === 'BUY') {
    const gapReason = evaluateGap(state, config.gapRejectPct)
    if (gapReason !== null) {
      return reject(gapReason)
    }
  }

  if (
    side === 'BUY' &&
    inferWebullMarket(symbol) === 'JP' &&
    state.lastQuote &&
    !isWithinJpPriceBand(state.lastQuote.price, intentPrice)
  ) {
    return reject(
      `JP price band: order price ${intentPrice} outside band for reference ${state.lastQuote.price}`,
    )
  }

  return APPROVED
}

function reject(reason: string): PerSymbolRiskDecision {
  return { approved: false, reasons: [reason] }
}

function evaluateSpreadGate(
  symbol: string,
  lastQuote: QuoteSnapshot | null,
  limits: { US: number; JP: number },
  now: Date,
): string | null {
  if (lastQuote === null) return null
  const bid = lastQuote.bid
  const ask = lastQuote.ask
  if (bid === undefined || ask === undefined) {
    if (QUOTE_SOURCES_WITHOUT_BID_ASK.has(lastQuote.source)) {
      // Logged because this is a safety guard being relaxed, not a routine skip.
      console.warn(
        JSON.stringify({
          event: 'spread_guard_skipped_no_bidask',
          symbol,
          source: lastQuote.source,
        }),
      )
      return null
    }
    return 'spread unknown, bid/ask missing'
  }
  const market = inferWebullMarket(symbol)
  const limit = market === 'JP' ? limits.JP : limits.US
  const spreadPct = computeSpreadPct(bid, ask)
  if (spreadPct === null) {
    return 'spread invalid: crossed book, non-finite, or non-positive bid/ask'
  }
  if (spreadPct > limit) {
    // An unscheduled market closure isn't representable in the trading
    // calendar and slips past the session-window gate; this reject is the
    // backstop, and appending quote staleness lets the reason alone hint
    // "stale book, market likely closed" without a separate lookup.
    return `spread ${(spreadPct * 100).toFixed(3)}% exceeds ${market} limit ${(limit * 100).toFixed(3)}%${formatQuoteStaleness(lastQuote.asOf, now)}`
  }
  return null
}

// Clock skew producing a negative age is clamped to 0.0h.
function formatQuoteStaleness(asOf: string | undefined, now: Date): string {
  if (!asOf) return ''
  const asOfMs = new Date(asOf).getTime()
  if (!Number.isFinite(asOfMs)) return ''
  const staleHours = Math.max(0, (now.getTime() - asOfMs) / 3_600_000)
  return ` (quote asOf ${asOf}, ${staleHours.toFixed(1)}h stale)`
}

function evaluateGap(state: SymbolState, thresholdPct: number): string | null {
  const position = state.position
  const quote = state.lastQuote
  if (!position || !quote) return null
  if (!Number.isFinite(position.avgPrice) || position.avgPrice <= 0) return null
  const gap = (quote.price - position.avgPrice) / position.avgPrice
  if (Math.abs(gap) > thresholdPct) {
    return `gap re-eval: |${gap.toFixed(4)}| > ${thresholdPct} (avgPrice ${position.avgPrice} vs quote ${quote.price})`
  }
  return null
}
