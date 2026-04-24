import type { DecisionTraceStep, Signal } from '../../domain/Signal'
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
  /**
   * Minimum 50-day return required to consider the stock in an uptrend.
   * Default 0.08. Set negative to effectively disable the filter.
   */
  minReturn50d: number
  /**
   * Require `price > sma50` before entering. Default true. Set false in
   * demo / frequent-cycle mode so entry doesn't depend on trend direction.
   */
  requireAboveSma50: boolean
  /**
   * ATR multiplier for vol-adaptive stop sizing。
   *   stopDistance = max(kAtr * atr20, |entry * stopPct|)
   * POC 推奨域 1.5–2.5。
   */
  kAtr: number
}

/**
 * Test-only default. Production path loads Pullback defaults from D1
 * (global_config.pullback_default_*) — see runStrategyCron. Unit tests
 * that don't plumb a D1 fixture can use this to instantiate the strategy.
 */
export const TEST_DEFAULT_RULE: SymbolRule = Object.freeze({
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.0,
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

  constructor(
    private readonly defaultRule: SymbolRule,
    private readonly rules: Record<string, SymbolRule> = {},
  ) {}

  resolveRule(symbol: string): SymbolRule {
    const override = this.rules[symbol.toUpperCase()]
    return override ?? this.defaultRule
  }

  decide(input: PullbackInput): Signal {
    const rule = this.resolveRule(input.symbol)
    const now = input.now
    const trace: DecisionTraceStep[] = []

    if (input.pendingOrder !== null) {
      trace.push(step('guard.pending_order_absent', false, true, 'not_exists', false, 'pending order in flight'))
      return hold(input, 'pending order in flight', trace)
    }
    trace.push(step('guard.pending_order_absent', true, false, 'not_exists', false))

    if (input.cooldownUntil && new Date(input.cooldownUntil).getTime() > now.getTime()) {
      trace.push(step('guard.cooldown_inactive', false, input.cooldownUntil, '<=', now.toISOString(), 'cooldown active'))
      return hold(input, `cooldown active until ${input.cooldownUntil}`, trace)
    }
    trace.push(step('guard.cooldown_inactive', true, input.cooldownUntil, '<=', now.toISOString()))

    if (input.position !== null) {
      trace.push(step('route.position_open', true, input.position.qty, '>', 0))
      return this.exitDecision(input, input.position, rule, trace)
    }
    trace.push(step('route.position_open', false, 0, '>', 0))
    return this.entryDecision(input, rule, trace)
  }

  private exitDecision(
    input: PullbackInput,
    position: PositionState,
    rule: SymbolRule,
    trace: DecisionTraceStep[],
  ): Signal {
    const pnlPct = (input.indicators.price - position.avgPrice) / position.avgPrice

    if (pnlPct >= rule.takeProfitPct) {
      trace.push(step('exit.take_profit', true, pnlPct, '>=', rule.takeProfitPct))
      return sell(input, position, `take-profit hit: pnl ${pnlPct.toFixed(4)} >= ${rule.takeProfitPct}`, trace)
    }
    trace.push(step('exit.take_profit', false, pnlPct, '>=', rule.takeProfitPct))

    if (pnlPct <= rule.stopPct) {
      trace.push(step('exit.stop_loss', true, pnlPct, '<=', rule.stopPct))
      return sell(input, position, `stop-loss hit: pnl ${pnlPct.toFixed(4)} <= ${rule.stopPct}`, trace)
    }
    trace.push(step('exit.stop_loss', false, pnlPct, '<=', rule.stopPct))

    if (input.holdBusinessDays >= rule.timeStopDays) {
      trace.push(step('exit.time_stop', true, input.holdBusinessDays, '>=', rule.timeStopDays))
      return sell(
        input,
        position,
        `time-stop hit: held ${input.holdBusinessDays}d >= ${rule.timeStopDays}d`,
        trace,
      )
    }
    trace.push(step('exit.time_stop', false, input.holdBusinessDays, '>=', rule.timeStopDays))
    trace.push(step('exit.hold_position', true, pnlPct, 'between', [rule.stopPct, rule.takeProfitPct]))
    return hold(input, `holding: pnl ${pnlPct.toFixed(4)} within (${rule.stopPct}, ${rule.takeProfitPct})`, trace)
  }

  private entryDecision(input: PullbackInput, rule: SymbolRule, trace: DecisionTraceStep[]): Signal {
    const ind = input.indicators
    if (ind.return50d <= rule.minReturn50d) {
      trace.push(step('entry.trend_50d_return', false, ind.return50d, '>', rule.minReturn50d))
      return hold(input, `50d return ${ind.return50d.toFixed(4)} <= ${rule.minReturn50d} trend threshold`, trace)
    }
    trace.push(step('entry.trend_50d_return', true, ind.return50d, '>', rule.minReturn50d))

    if (rule.requireAboveSma50 && ind.price <= ind.sma50) {
      trace.push(step('entry.above_sma50', false, ind.price, '>', ind.sma50))
      return hold(input, `price ${ind.price} <= sma50 ${ind.sma50}`, trace)
    }
    trace.push(step('entry.above_sma50', true, ind.price, '>', ind.sma50, rule.requireAboveSma50 ? undefined : 'disabled by rule'))

    if (ind.high20d <= 0) {
      trace.push(step('entry.high20d_valid', false, ind.high20d, '>', 0))
      return hold(input, 'invalid 20d high', trace)
    }
    trace.push(step('entry.high20d_valid', true, ind.high20d, '>', 0))

    const pullback = (ind.price - ind.high20d) / ind.high20d
    if (pullback > rule.pullbackMax) {
      trace.push(step('entry.pullback_not_too_shallow', false, pullback, '<=', rule.pullbackMax))
      return hold(input, `pullback ${pullback.toFixed(4)} > ${rule.pullbackMax} (not deep enough)`, trace)
    }
    trace.push(step('entry.pullback_not_too_shallow', true, pullback, '<=', rule.pullbackMax))

    if (pullback < rule.pullbackMin) {
      trace.push(step('entry.pullback_not_too_deep', false, pullback, '>=', rule.pullbackMin))
      return hold(input, `pullback ${pullback.toFixed(4)} < ${rule.pullbackMin} (too deep)`, trace)
    }
    trace.push(step('entry.pullback_not_too_deep', true, pullback, '>=', rule.pullbackMin))
    trace.push(step('entry.adopt_buy', true, pullback, 'between', [rule.pullbackMin, rule.pullbackMax]))
    return buy(input, `pullback ${pullback.toFixed(4)} in uptrend (50d return ${ind.return50d.toFixed(4)})`, trace)
  }
}

function hold(input: PullbackInput, reason: string, trace: DecisionTraceStep[]): Signal {
  return {
    action: 'HOLD',
    symbol: input.symbol,
    quantity: 0,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
    trace,
  }
}

function buy(input: PullbackInput, reason: string, trace: DecisionTraceStep[]): Signal {
  // Quantity is resolved by the sizing module (pullbackSizing.ts); signal
  // carries 0 here so downstream code knows to compute it.
  return {
    action: 'BUY',
    symbol: input.symbol,
    quantity: 0,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
    trace,
  }
}

function sell(
  input: PullbackInput,
  position: PositionState,
  reason: string,
  trace: DecisionTraceStep[],
): Signal {
  return {
    action: 'SELL',
    symbol: input.symbol,
    quantity: position.qty,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
    trace,
  }
}

function step(
  label: string,
  passed: boolean,
  actual?: DecisionTraceStep['actual'],
  operator?: DecisionTraceStep['operator'],
  threshold?: DecisionTraceStep['threshold'],
  message?: string,
): DecisionTraceStep {
  return {
    label,
    label_ja: labelJa(label),
    passed,
    ...(actual !== undefined ? { actual } : {}),
    ...(operator !== undefined ? { operator } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(message !== undefined ? { message } : {}),
  }
}

function labelJa(label: string): string {
  return TRACE_LABEL_JA[label] ?? label
}

const TRACE_LABEL_JA: Record<string, string> = {
  'guard.pending_order_absent': '未約定注文がない',
  'guard.cooldown_inactive': 'クールダウン中ではない',
  'route.position_open': '建玉を保有中',
  'entry.trend_50d_return': '50日騰落率が上昇トレンド条件を満たす',
  'entry.above_sma50': '株価が50日移動平均線を上回る',
  'entry.high20d_valid': '直近20日高値が有効',
  'entry.pullback_not_too_shallow': '押し目が浅すぎない',
  'entry.pullback_not_too_deep': '押し目が深すぎない',
  'entry.adopt_buy': '買い採用',
  'exit.take_profit': '利確条件を満たす',
  'exit.stop_loss': '損切り条件を満たす',
  'exit.time_stop': '時間切れ手仕舞い条件を満たす',
  'exit.hold_position': '保有継続条件内',
}
