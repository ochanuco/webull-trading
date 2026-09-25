import type { DecisionTraceStep, EntryStatusSnapshot, HoldCause, Signal } from '../../domain/Signal'
import type { PendingOrderLock, PositionState } from '../../state/types'
import { deriveEntryStatusFromIndicators } from '../entryStatus'
import { resolveStopDistance } from '../stopDistance'

export interface PullbackIndicators {
  price: number
  sma50: number
  /** 20-day return (trend filter). Named `return50d` for storage/dashboard compat. */
  return50d: number
  /** 10-day reference high for pullback entries. Named `high20d` for storage/dashboard compat. */
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
   * Minimum 20-day return required to consider the stock in an uptrend
   * (lookback lives in indicators.ts). Default 0.08; negative disables the
   * filter. Named `minReturn50d` for global_config column / interface compat.
   */
  minReturn50d: number
  /**
   * Require `price > sma50` before entering. Default true. Set false in
   * demo / frequent-cycle mode so entry doesn't depend on trend direction.
   */
  requireAboveSma50: boolean
  /** ATR multiplier for vol-adaptive stop sizing: stopDistance = max(kAtr * atr20, |entry * stopPct|). POC-recommended range 1.5–2.5. */
  kAtr: number
  /** Blowoff guard: skip BUY when `(price - sma50) / sma50` exceeds this (0.60 = +60%). Cuts strong early trends too, but avoids chasing a 3x leveraged ETF into a mean-reversion zone. */
  maxSma50DeviationPct: number
  /** Skip BUY when `atr20 / baselineAtr20` exceeds this (1.5 = 1.5x baseline) — the high-volatility counterpart to the atr-floor sizing cut on the low side. */
  maxAtrRatio: number
  /**
   * Re-entry price guard: within the window, re-buying is blocked unless
   * price is at least this many ATRs below the last exit price
   * (`SymbolState.lastExecutedPrice`). Blocks a whipsaw round-trip right
   * after a good exit — the price-axis counterpart to reconcileFills' next-
   * business-day time cooldown. 0 disables. Default 1.0 (last exit − 1 ATR).
   */
  reentryMinAtrBelowLastExit: number
  /**
   * Business days the re-entry price guard stays active after an exit; once
   * elapsed, a higher new-leg pullback re-entry is no longer blocked. 0
   * disables. Default 3.
   */
  reentryGuardBusinessDays: number
  /** Cap on stop width as a multiple of |avgPrice * takeProfitPct| (2.0 → R:R >= 0.5), so an ATR-driven stop can't widen without bound. 0 disables. The pct-stop floor still wins if it's narrower than the cap. */
  maxStopToTpRatio: number
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
  maxSma50DeviationPct: 0.6,
  maxAtrRatio: 1.5,
  reentryMinAtrBelowLastExit: 1.0,
  reentryGuardBusinessDays: 3,
  maxStopToTpRatio: 2.0,
})

export interface PullbackInput {
  symbol: string
  indicators: PullbackIndicators
  position: PositionState | null
  pendingOrder: PendingOrderLock | null
  cooldownUntil: string | null
  /** Business days elapsed since position.openedAt. 0 when position is null. */
  holdBusinessDays: number
  /** Last closing SELL's fill price (`SymbolState.lastExecutedPrice`) while flat. Null/unset passes the re-entry price guard through. */
  lastExitPrice?: number | null
  /** Business days since the last exit, computed per-market by the scheduler from `lastExitAt`. Null passes the guard through (recency unknown). */
  businessDaysSinceExit?: number | null
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

    if (input.position === null && input.cooldownUntil && new Date(input.cooldownUntil).getTime() > now.getTime()) {
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
    trace.push(step('exit.stop_loss', false, pnlPct, '<=', effectiveStopPct))

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
    // Shows effectiveStopPct, not the nominal rule.stopPct — the ATR/cap-
    // adjusted value is what actually triggers, and showing nominal would
    // mislead an operator reading the reason string.
    trace.push(
      step('exit.hold_position', true, pnlPct, 'between', [effectiveStopPct, rule.takeProfitPct]),
    )
    return hold(
      input,
      `holding: pnl ${pnlPct.toFixed(4)} within (${effectiveStopPct.toFixed(4)}, ${rule.takeProfitPct})`,
      trace,
    )
  }

  private entryDecision(input: PullbackInput, rule: SymbolRule, trace: DecisionTraceStep[]): Signal {
    const ind = input.indicators

    const lastExitPrice = input.lastExitPrice ?? null
    const bdSinceExit = input.businessDaysSinceExit ?? null
    const reentryWindowConfigured = rule.reentryMinAtrBelowLastExit > 0 && rule.reentryGuardBusinessDays > 0

    // Exception to the guard's normal fail-open-when-unknown behavior below:
    // a symbol can have bdSinceExit (from lastExitAt) but no lastExitPrice
    // yet (the field's rollout lagged lastExitAt). Treating that as
    // fail-open would leave exactly the window the guard exists to cover
    // unprotected, so within the window it holds on unknown price too;
    // outside the window (or with no exit on record at all) it's fail-open.
    if (
      reentryWindowConfigured &&
      lastExitPrice === null &&
      bdSinceExit !== null &&
      bdSinceExit < rule.reentryGuardBusinessDays
    ) {
      trace.push(
        step(
          'entry.reentry_below_last_exit',
          false,
          ind.price,
          '<=',
          ind.price,
          `exit price unknown (legacy state) within guard window (${bdSinceExit}bd since exit)`,
        ),
      )
      return hold(
        input,
        `re-entry guard: exit price unknown (legacy state), within ${rule.reentryGuardBusinessDays}bd guard window (${bdSinceExit}bd since exit)`,
        trace,
      )
    }

    const reentryGuardActive =
      reentryWindowConfigured &&
      lastExitPrice !== null &&
      Number.isFinite(lastExitPrice) &&
      lastExitPrice > 0 &&
      bdSinceExit !== null &&
      bdSinceExit < rule.reentryGuardBusinessDays &&
      Number.isFinite(ind.atr20) &&
      ind.atr20 > 0
    if (reentryGuardActive) {
      const reentryCeiling = lastExitPrice! - rule.reentryMinAtrBelowLastExit * ind.atr20
      if (ind.price > reentryCeiling) {
        trace.push(step('entry.reentry_below_last_exit', false, ind.price, '<=', reentryCeiling, `within ${bdSinceExit}bd of last exit ${lastExitPrice}`))
        return hold(
          input,
          `re-entry guard: price ${ind.price} > last exit ${lastExitPrice} - ${rule.reentryMinAtrBelowLastExit}*ATR(${ind.atr20.toFixed(2)}) = ${reentryCeiling.toFixed(2)} (${bdSinceExit}bd since exit)`,
          trace,
        )
      }
      trace.push(step('entry.reentry_below_last_exit', true, ind.price, '<=', reentryCeiling))
    } else {
      trace.push(step('entry.reentry_below_last_exit', true, ind.price, '<=', ind.price, 'guard inactive'))
    }

    // The gates below are "setup quality" gates (one-to-one with
    // entryDistance.ts's EntryGateKey), not action guards — they're HALF-
    // promotion candidates, so their HOLDs carry holdCause='entry_gate' plus
    // a fresh deriveEntryStatusFromIndicators snapshot for the scheduler.

    if (ind.return50d <= rule.minReturn50d) {
      trace.push(step('entry.trend_50d_return', false, ind.return50d, '>', rule.minReturn50d))
      return hold(
        input,
        `20d return ${ind.return50d.toFixed(4)} <= ${rule.minReturn50d} trend threshold`,
        trace,
        'entry_gate',
        deriveEntryStatusFromIndicators(ind, rule),
      )
    }
    trace.push(step('entry.trend_50d_return', true, ind.return50d, '>', rule.minReturn50d))

    if (rule.requireAboveSma50 && ind.price <= ind.sma50) {
      trace.push(step('entry.above_sma50', false, ind.price, '>', ind.sma50))
      return hold(
        input,
        `price ${ind.price} <= sma50 ${ind.sma50}`,
        trace,
        'entry_gate',
        deriveEntryStatusFromIndicators(ind, rule),
      )
    }
    trace.push(step('entry.above_sma50', true, ind.price, '>', ind.sma50, rule.requireAboveSma50 ? undefined : 'disabled by rule'))

    const sma50Deviation = ind.sma50 > 0 ? (ind.price - ind.sma50) / ind.sma50 : 0
    if (sma50Deviation > rule.maxSma50DeviationPct) {
      trace.push(step('entry.not_overextended', false, sma50Deviation, '<=', rule.maxSma50DeviationPct))
      return hold(
        input,
        `sma50 deviation ${sma50Deviation.toFixed(4)} > ${rule.maxSma50DeviationPct} (overextended)`,
        trace,
        'entry_gate',
        deriveEntryStatusFromIndicators(ind, rule),
      )
    }
    trace.push(step('entry.not_overextended', true, sma50Deviation, '<=', rule.maxSma50DeviationPct))

    // baseline <= 0 (unknown) passes the gate rather than blocking on missing data.
    const atrRatio = ind.baselineAtr20 > 0 ? ind.atr20 / ind.baselineAtr20 : 0
    if (atrRatio > rule.maxAtrRatio) {
      trace.push(step('entry.vol_not_elevated', false, atrRatio, '<=', rule.maxAtrRatio))
      return hold(
        input,
        `atr ratio ${atrRatio.toFixed(2)} > ${rule.maxAtrRatio} (volatility elevated)`,
        trace,
        'entry_gate',
        deriveEntryStatusFromIndicators(ind, rule),
      )
    }
    trace.push(step('entry.vol_not_elevated', true, atrRatio, '<=', rule.maxAtrRatio))

    if (ind.high20d <= 0) {
      trace.push(step('entry.high20d_valid', false, ind.high20d, '>', 0))
      return hold(input, 'invalid 10d high', trace, 'entry_gate', deriveEntryStatusFromIndicators(ind, rule))
    }
    trace.push(step('entry.high20d_valid', true, ind.high20d, '>', 0))

    const pullback = (ind.price - ind.high20d) / ind.high20d
    if (pullback > rule.pullbackMax) {
      trace.push(step('entry.pullback_not_too_shallow', false, pullback, '<=', rule.pullbackMax))
      return hold(
        input,
        `pullback ${pullback.toFixed(4)} > ${rule.pullbackMax} (not deep enough)`,
        trace,
        'entry_gate',
        deriveEntryStatusFromIndicators(ind, rule),
      )
    }
    trace.push(step('entry.pullback_not_too_shallow', true, pullback, '<=', rule.pullbackMax))

    if (pullback < rule.pullbackMin) {
      trace.push(step('entry.pullback_not_too_deep', false, pullback, '>=', rule.pullbackMin))
      return hold(
        input,
        `pullback ${pullback.toFixed(4)} < ${rule.pullbackMin} (too deep)`,
        trace,
        'entry_gate',
        deriveEntryStatusFromIndicators(ind, rule),
      )
    }
    trace.push(step('entry.pullback_not_too_deep', true, pullback, '>=', rule.pullbackMin))
    trace.push(step('entry.adopt_buy', true, pullback, 'between', [rule.pullbackMin, rule.pullbackMax]))
    return buy(input, `pullback ${pullback.toFixed(4)} in uptrend (20d return ${ind.return50d.toFixed(4)})`, trace)
  }
}

/** Defaults `cause` to 'guard' so only callers that explicitly pass 'entry_gate' (the setup-quality gates) are HALF-promotion candidates. */
function hold(
  input: PullbackInput,
  reason: string,
  trace: DecisionTraceStep[],
  cause: HoldCause = 'guard',
  entryStatus?: EntryStatusSnapshot,
): Signal {
  return {
    action: 'HOLD',
    symbol: input.symbol,
    quantity: 0,
    price: input.indicators.price,
    reason,
    generatedAtIso: input.now.toISOString(),
    trace,
    holdCause: cause,
    ...(entryStatus !== undefined ? { entryStatus } : {}),
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
  'route.position_open': '保有中',
  'entry.reentry_below_last_exit': '前回売値からの再エントリー間隔・値幅が十分',
  // Identifiers stay historical for decision_log compat; only the display strings use the real 20d/10d lookbacks.
  'entry.trend_50d_return': '20日騰落率が上昇トレンド条件を満たす',
  'entry.above_sma50': '株価が50日移動平均線を上回る',
  'entry.not_overextended': '移動平均からの上方乖離が過大でない',
  'entry.vol_not_elevated': 'ボラティリティが過熱していない',
  'entry.high20d_valid': '直近10日高値が有効',
  'entry.pullback_not_too_shallow': '押し目が浅すぎない',
  'entry.pullback_not_too_deep': '押し目が深すぎない',
  'entry.adopt_buy': '買い採用',
  'exit.take_profit': '利確条件を満たす',
  'exit.stop_loss': '損切り条件を満たす',
  'exit.time_stop': '時間切れ手仕舞い条件を満たす',
  'exit.hold_position': '保有継続条件内',
}
