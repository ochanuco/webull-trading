import type { Signal } from '../../domain/Signal'
import type { PendingOrderLock, PositionState } from '../../state/types'

export interface PullbackIndicators {
  price: number
  sma50: number
  return50d: number
  high20d: number
  atr20: number
  baselineAtr20: number
}

export interface SymbolRule {
  /** Stop-loss as a fraction of avgPrice (negative). Default -0.04. */
  stopPct: number
  /** Take-profit as a fraction of avgPrice (positive). Default 0.07. */
  takeProfitPct: number
  /** Time stop in business days. Default 10. */
  timeStopDays: number
  /** Pullback range: closer to 0 bound. Default -0.03. */
  pullbackMax: number
  /** Pullback range: deeper bound. Default -0.06. */
  pullbackMin: number
}

export const DEFAULT_RULE: SymbolRule = Object.freeze({
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
})

/**
 * 3x leveraged ETFs (SOXL / SOXS / TQQQ / SQQQ ...): tighter stop, shorter
 * time stop to avoid volatility-drag + path-dependency decay.
 */
export const LEVERAGED_RULE: SymbolRule = Object.freeze({
  stopPct: -0.03,
  takeProfitPct: 0.07,
  timeStopDays: 5,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
})

export interface PullbackInput {
  symbol: string
  indicators: PullbackIndicators
  position: PositionState | null
  pendingOrder: PendingOrderLock | null
  cooldownUntil: string | null
  /** Business days elapsed since position.openedAt. 0 when position is null. */
  holdBusinessDays: number
  now: Date
}

export class PullbackUptrendStrategy {
  readonly name = 'PullbackUptrendStrategy'

  constructor(private readonly rules: Record<string, SymbolRule> = {}) {}

  resolveRule(symbol: string): SymbolRule {
    const override = this.rules[symbol.toUpperCase()]
    return override ?? DEFAULT_RULE
  }

  decide(input: PullbackInput): Signal {
    const rule = this.resolveRule(input.symbol)
    const now = input.now

    if (input.pendingOrder !== null) {
      return hold(input, 'pending order in flight')
    }
    if (input.cooldownUntil && new Date(input.cooldownUntil).getTime() > now.getTime()) {
      return hold(input, `cooldown active until ${input.cooldownUntil}`)
    }

    if (input.position !== null) {
      return this.exitDecision(input, input.position, rule)
    }
    return this.entryDecision(input, rule)
  }

  private exitDecision(input: PullbackInput, position: PositionState, rule: SymbolRule): Signal {
    const pnlPct = (input.indicators.price - position.avgPrice) / position.avgPrice

    if (pnlPct >= rule.takeProfitPct) {
      return sell(input, position, `take-profit hit: pnl ${pnlPct.toFixed(4)} >= ${rule.takeProfitPct}`)
    }
    if (pnlPct <= rule.stopPct) {
      return sell(input, position, `stop-loss hit: pnl ${pnlPct.toFixed(4)} <= ${rule.stopPct}`)
    }
    if (input.holdBusinessDays >= rule.timeStopDays) {
      return sell(
        input,
        position,
        `time-stop hit: held ${input.holdBusinessDays}d >= ${rule.timeStopDays}d`,
      )
    }
    return hold(input, `holding: pnl ${pnlPct.toFixed(4)} within (${rule.stopPct}, ${rule.takeProfitPct})`)
  }

  private entryDecision(input: PullbackInput, rule: SymbolRule): Signal {
    const ind = input.indicators
    if (ind.return50d <= 0.08) {
      return hold(input, `50d return ${ind.return50d.toFixed(4)} <= 0.08 trend threshold`)
    }
    if (ind.price <= ind.sma50) {
      return hold(input, `price ${ind.price} <= sma50 ${ind.sma50}`)
    }
    if (ind.high20d <= 0) {
      return hold(input, 'invalid 20d high')
    }
    const pullback = (ind.price - ind.high20d) / ind.high20d
    if (pullback > rule.pullbackMax) {
      return hold(input, `pullback ${pullback.toFixed(4)} > ${rule.pullbackMax} (not deep enough)`)
    }
    if (pullback < rule.pullbackMin) {
      return hold(input, `pullback ${pullback.toFixed(4)} < ${rule.pullbackMin} (too deep)`)
    }
    return buy(input, `pullback ${pullback.toFixed(4)} in uptrend (50d return ${ind.return50d.toFixed(4)})`)
  }
}

function hold(input: PullbackInput, reason: string): Signal {
  return {
    action: 'HOLD',
    symbol: input.symbol,
    quantity: 0,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
  }
}

function buy(input: PullbackInput, reason: string): Signal {
  // Quantity is resolved by the sizing module (pullbackSizing.ts); signal
  // carries 0 here so downstream code knows to compute it.
  return {
    action: 'BUY',
    symbol: input.symbol,
    quantity: 0,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
  }
}

function sell(input: PullbackInput, position: PositionState, reason: string): Signal {
  return {
    action: 'SELL',
    symbol: input.symbol,
    quantity: position.qty,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
  }
}
