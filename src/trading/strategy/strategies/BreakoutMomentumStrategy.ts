import type { DecisionTraceStep, Signal } from '../../domain/Signal'
import type { PendingOrderLock, PositionState } from '../../state/types'
import type { PullbackIndicatorSnapshot } from '../indicators'

/**
 * ブレイクアウト/モメンタム entry 戦略 (#momentum)。
 *
 * **現状は backtest 専用の dormant 実装**。`runStrategyCron` の live dispatch には
 * 一切繋がっておらず、`ENTRY_ENABLED_ROLES` にも載っていないので、本番で発注する
 * 経路は存在しない (fail-closed)。エッジ検証 (`scripts/backtest-momentum.ts`) で
 * 継続性・コスト後・押し目との相関を測る目的でのみ使う。
 *
 * 設計上の要点 (trading-strategist 設計 + red-team を反映):
 * - **3x レバ ETF には使わない** (vol drag・騙し3倍で却下)。1x 銘柄向け。
 * - **gate を自己矛盾させない**: 「新高値ブレイク」と「低ボラ要求」を同時に課さない
 *   (両立する局面が無く永久に発火しないため)。ATR 上限 gate は entry から外し、
 *   過熱 (SMA50 乖離) の上限だけで blowoff を弾く。
 * - **ブレイク基準は当日を除く終値20日高値** (`breakoutHigh20`)。当日含む high を
 *   流用すると自己参照で発火不能になる。
 * - exit は押し目と同型 (TP / ATR連動 stop / time-stop) だが preset は別 (高値圏
 *   entry なので stop 深め・保有短め)。
 */
export interface MomentumRule {
  /** Stop-loss as a fraction of avgPrice (negative)。高値圏 entry なので押し目より深め推奨。 */
  stopPct: number
  /** Take-profit as a fraction of avgPrice (positive)。 */
  takeProfitPct: number
  /** Time stop in business days。モメンタムは短期 (走らなければ早く撤退)。 */
  timeStopDays: number
  /** ATR multiplier for vol-adaptive stop。stopDistance = max(kAtr*atr20, |entry*stopPct|)。 */
  kAtr: number
  /** トレンド成立に必要な 20日リターン下限 (正)。 */
  minReturn: number
  /** ブレイク確認のバッファ (正、例 0.005 = +0.5%)。高値ジャストのノイズ抜けを弾く。 */
  breakoutBuffer: number
  /** 過熱ガード (blowoff のみ切る上限、例 0.6)。低ボラ要求はしない (自己矛盾回避)。 */
  maxSma50DeviationPct: number
  /** `price > sma50` を要求するか。 */
  requireAboveSma50: boolean
}

/** backtest / unit test 用のデフォルト (全数値 backtest 未検証の初期推定)。 */
export const TEST_DEFAULT_MOMENTUM_RULE: MomentumRule = Object.freeze({
  stopPct: -0.05,
  takeProfitPct: 0.1,
  timeStopDays: 7,
  kAtr: 2.5,
  minReturn: 0.04,
  breakoutBuffer: 0.005,
  maxSma50DeviationPct: 0.6,
  requireAboveSma50: true,
})

export interface MomentumInput {
  symbol: string
  indicators: PullbackIndicatorSnapshot
  position: PositionState | null
  pendingOrder: PendingOrderLock | null
  cooldownUntil: string | null
  holdBusinessDays: number
  /**
   * #reentry: pullback 戦略の再エントリー価格ガード用フィールド。momentum は
   * 使わないが、scheduler が両戦略へ同一 input オブジェクトを渡すため (union の
   * excess property check を通すため) optional で受けておく。
   */
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
    if (input.cooldownUntil && new Date(input.cooldownUntil).getTime() > now.getTime()) {
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

  // 過熱 (blowoff) 上限のみ。低ボラ要求はしない (新高値ブレイクと両立しないため)。
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

  // 当日を除く20日終値高値を buffer 込みで終値ブレイク。
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

  const pctStopDistance = Math.abs(position.avgPrice * rule.stopPct)
  const atrStopDistance =
    Number.isFinite(input.indicators.atr20) && input.indicators.atr20 > 0 ? rule.kAtr * input.indicators.atr20 : 0
  const stopDistance = Math.max(pctStopDistance, atrStopDistance)
  const effectiveStopPct = position.avgPrice > 0 ? -stopDistance / position.avgPrice : rule.stopPct
  if (pnlPct <= effectiveStopPct) {
    trace.push(step('exit.stop_loss', true, pnlPct, '<=', effectiveStopPct))
    return sell(input, position, `stop-loss hit: pnl ${pnlPct.toFixed(4)} <= ${effectiveStopPct.toFixed(4)}`, trace)
  }

  if (input.holdBusinessDays >= rule.timeStopDays) {
    trace.push(step('exit.time_stop', true, input.holdBusinessDays, '>=', rule.timeStopDays))
    return sell(input, position, `time-stop hit: held ${input.holdBusinessDays}d >= ${rule.timeStopDays}d`, trace)
  }
  return hold(input, `holding: pnl ${pnlPct.toFixed(4)} within (${rule.stopPct}, ${rule.takeProfitPct})`, trace)
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

// momentum 固有の trace 識別子 → 日本語ラベル。識別子 (`entry.breakout` 等) は
// decision_log 互換のため英語据え置きで、表示文字列のみ日本語化する (#trace-readability)。
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
