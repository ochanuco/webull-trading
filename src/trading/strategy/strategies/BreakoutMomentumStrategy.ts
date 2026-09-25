import type { DecisionTraceStep, Signal } from '../../domain/Signal'
import type { PendingOrderLock, PositionState } from '../../state/types'
import type { PullbackIndicatorSnapshot } from '../indicators'
import { resolveStopDistance } from '../stopDistance'

/**
 * Breakout/momentum entry strategy. Not wired into `runStrategyCron`'s live
 * dispatch or `ENTRY_ENABLED_ROLES` — backtest-only (`scripts/backtest-momentum.ts`)
 * until edge is validated. 1x symbols only, not 3x leveraged ETFs (vol drag).
 *
 * The entry gate deliberately has no low-volatility requirement: combined
 * with "new high breakout" it would never both be true, so the ATR check
 * only caps overheating (SMA50 deviation), not volatility itself.
 */
export interface MomentumRule {
  /** Fraction of avgPrice (negative). Deeper than the pullback strategy's since entry is already extended. */
  stopPct: number
  /** Fraction of avgPrice (positive). */
  takeProfitPct: number
  /** Business days. Short — momentum that stalls should be cut quickly. */
  timeStopDays: number
  /** ATR multiplier for vol-adaptive stop: stopDistance = max(kAtr*atr20, |entry*stopPct|). */
  kAtr: number
  /** Minimum 20-day return required to treat the trend as established. */
  minReturn: number
  /** Fraction above breakoutHigh20 required to confirm (e.g. 0.005 = +0.5%), filtering noise right at the high. */
  breakoutBuffer: number
  /** Blowoff cap on SMA50 deviation (e.g. 0.6). Not a low-volatility floor — see class doc. */
  maxSma50DeviationPct: number
  /** Whether to require `price > sma50`. */
  requireAboveSma50: boolean
  /** Cap on stop width as a multiple of |avgPrice * takeProfitPct|, same meaning as the pullback strategy's. 0 disables. */
  maxStopToTpRatio: number
}

/** Backtest/unit-test defaults — initial estimates, not yet backtest-validated. */
export const TEST_DEFAULT_MOMENTUM_RULE: MomentumRule = Object.freeze({
  stopPct: -0.05,
  takeProfitPct: 0.1,
  timeStopDays: 7,
  kAtr: 2.5,
  minReturn: 0.04,
  breakoutBuffer: 0.005,
  maxSma50DeviationPct: 0.6,
  requireAboveSma50: true,
  maxStopToTpRatio: 2.0,
})

export interface MomentumInput {
  symbol: string
  indicators: PullbackIndicatorSnapshot
  position: PositionState | null
  pendingOrder: PendingOrderLock | null
  cooldownUntil: string | null
  holdBusinessDays: number
  /** Unused by momentum; accepted because the scheduler passes one shared input shape to both strategies. */
  lastExitPrice?: number | null
  businessDaysSinceExit?: number | null
  now: Date
}

export class BreakoutMomentumStrategy {
  readonly name = 'BreakoutMomentumStrategy'

  constructor(
    private readonly defaultRule: MomentumRule,
    private readonly rules: Record<string, MomentumRule> = {},
  ) {}

  resolveRule(symbol: string): MomentumRule {
    return this.rules[symbol.toUpperCase()] ?? this.defaultRule
  }

  decide(input: MomentumInput): Signal {
    const rule = this.resolveRule(input.symbol)
    const now = input.now
    const trace: DecisionTraceStep[] = []

    if (input.pendingOrder !== null) {
      trace.push(step('guard.pending_order_absent', false, true, 'not_exists', false, 'pending order in flight'))
      return hold(input, 'pending order in flight', trace)
    }
    if (input.position === null && input.cooldownUntil && new Date(input.cooldownUntil).getTime() > now.getTime()) {
      trace.push(step('guard.cooldown_inactive', false, input.cooldownUntil, '<=', now.toISOString(), 'cooldown active'))
      return hold(input, `cooldown active until ${input.cooldownUntil}`, trace)
    }
    if (input.position !== null) {
      return exitDecision(input, input.position, rule, trace)
    }
    return entryDecision(input, rule, trace)
  }
}

function entryDecision(input: MomentumInput, rule: MomentumRule, trace: DecisionTraceStep[]): Signal {
  const ind = input.indicators

  if (ind.return50d <= rule.minReturn) {
    trace.push(step('entry.trend_20d_return', false, ind.return50d, '>', rule.minReturn))
    return hold(input, `20d return ${ind.return50d.toFixed(4)} <= ${rule.minReturn} trend threshold`, trace)
  }
  trace.push(step('entry.trend_20d_return', true, ind.return50d, '>', rule.minReturn))

  if (rule.requireAboveSma50 && ind.price <= ind.sma50) {
    trace.push(step('entry.above_sma50', false, ind.price, '>', ind.sma50))
    return hold(input, `price ${ind.price} <= sma50 ${ind.sma50}`, trace)
  }
  trace.push(step('entry.above_sma50', true, ind.price, '>', ind.sma50))

  const sma50Deviation = ind.sma50 > 0 ? (ind.price - ind.sma50) / ind.sma50 : 0
  if (sma50Deviation > rule.maxSma50DeviationPct) {
    trace.push(step('entry.not_blowoff', false, sma50Deviation, '<=', rule.maxSma50DeviationPct))
    return hold(input, `sma50 deviation ${sma50Deviation.toFixed(4)} > ${rule.maxSma50DeviationPct} (blowoff)`, trace)
  }
  trace.push(step('entry.not_blowoff', true, sma50Deviation, '<=', rule.maxSma50DeviationPct))

  if (!(ind.breakoutHigh20 > 0)) {
    trace.push(step('entry.breakout_high_valid', false, ind.breakoutHigh20, '>', 0))
    return hold(input, 'invalid breakoutHigh20', trace)
  }
  trace.push(step('entry.breakout_high_valid', true, ind.breakoutHigh20, '>', 0))

  const breakoutLevel = ind.breakoutHigh20 * (1 + rule.breakoutBuffer)
  if (ind.price < breakoutLevel) {
    trace.push(step('entry.breakout', false, ind.price, '>=', breakoutLevel))
    return hold(input, `price ${ind.price.toFixed(4)} < breakout level ${breakoutLevel.toFixed(4)}`, trace)
  }
  trace.push(step('entry.breakout', true, ind.price, '>=', breakoutLevel))
  trace.push(step('entry.adopt_buy', true, ind.price, '>=', breakoutLevel))
  return buy(input, `breakout: price ${ind.price.toFixed(4)} >= ${breakoutLevel.toFixed(4)} (20d high ${ind.breakoutHigh20.toFixed(4)}, 20d return ${ind.return50d.toFixed(4)})`, trace)
}

function exitDecision(
  input: MomentumInput,
  position: PositionState,
  rule: MomentumRule,
  trace: DecisionTraceStep[],
): Signal {
  const pnlPct = (input.indicators.price - position.avgPrice) / position.avgPrice

  if (pnlPct >= rule.takeProfitPct) {
    trace.push(step('exit.take_profit', true, pnlPct, '>=', rule.takeProfitPct))
    return sell(input, position, `take-profit hit: pnl ${pnlPct.toFixed(4)} >= ${rule.takeProfitPct}`, trace)
  }

  const stop = resolveStopDistance({
    price: position.avgPrice,
    stopPct: rule.stopPct,
    takeProfitPct: rule.takeProfitPct,
    atr20: input.indicators.atr20,
    kAtr: rule.kAtr,
    maxStopToTpRatio: rule.maxStopToTpRatio,
  })
  const effectiveStopPct = stop.effectiveStopPct
  if (pnlPct <= effectiveStopPct) {
    trace.push(step('exit.stop_loss', true, pnlPct, '<=', effectiveStopPct))
    return sell(
      input,
      position,
      `stop-loss hit: pnl ${pnlPct.toFixed(4)} <= ${effectiveStopPct.toFixed(4)} (${stop.dominant}, dist ${stop.distance.toFixed(2)})`,
      trace,
    )
  }

  if (input.holdBusinessDays >= rule.timeStopDays) {
    trace.push(step('exit.time_stop', true, input.holdBusinessDays, '>=', rule.timeStopDays))
    return sell(input, position, `time-stop hit: held ${input.holdBusinessDays}d >= ${rule.timeStopDays}d`, trace)
  }
  return hold(
    input,
    `holding: pnl ${pnlPct.toFixed(4)} within (${effectiveStopPct.toFixed(4)}, ${rule.takeProfitPct})`,
    trace,
  )
}

function hold(input: MomentumInput, reason: string, trace: DecisionTraceStep[]): Signal {
  return { action: 'HOLD', symbol: input.symbol, quantity: 0, price: input.indicators.price, reason, generatedAtIso: input.now.toISOString(), trace }
}
function buy(input: MomentumInput, reason: string, trace: DecisionTraceStep[]): Signal {
  return { action: 'BUY', symbol: input.symbol, quantity: 0, price: input.indicators.price, reason, generatedAtIso: input.now.toISOString(), trace }
}
function sell(input: MomentumInput, position: PositionState, reason: string, trace: DecisionTraceStep[]): Signal {
  return { action: 'SELL', symbol: input.symbol, quantity: position.qty, price: input.indicators.price, reason, generatedAtIso: input.now.toISOString(), trace }
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

// Identifiers stay English for decision_log compat; only the display string is localized.
const TRACE_LABEL_JA: Record<string, string> = {
  'guard.pending_order_absent': '未約定注文がない',
  'guard.cooldown_inactive': 'クールダウン中ではない',
  'entry.trend_20d_return': '20日騰落率が上昇トレンド条件を満たす',
  'entry.above_sma50': '株価が50日移動平均線を上回る',
  'entry.not_blowoff': '移動平均からの上方乖離が過大でない (吹き上げでない)',
  'entry.breakout_high_valid': '当日除く直近20日高値が有効',
  'entry.breakout': '株価が直近20日高値をブレイク',
  'entry.adopt_buy': '買い採用',
  'exit.take_profit': '利確条件を満たす',
  'exit.stop_loss': '損切り条件を満たす',
  'exit.time_stop': '時間切れ手仕舞い条件を満たす',
}
