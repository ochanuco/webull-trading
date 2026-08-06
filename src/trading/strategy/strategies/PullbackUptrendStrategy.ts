import type { DecisionTraceStep, EntryStatusSnapshot, HoldCause, Signal } from '../../domain/Signal'
import type { PendingOrderLock, PositionState } from '../../state/types'
import { deriveEntryStatusFromIndicators } from '../entryStatus'
import { resolveStopDistance } from '../stopDistance'

export interface PullbackIndicators {
  price: number
  sma50: number
  /**
   * 騰落率トレンド filter (entry condition)。**issue #318 で lookback を
   * 50d → 20d に短縮**。フィールド名は historical (storage/dashboard 互換)。
   */
  return50d: number
  /**
   * 押し目買いの reference high。**issue #318 で lookback を 20d → 10d に
   * 短縮**。フィールド名は historical (storage/dashboard 互換)。
   */
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
   * Minimum N-day return required to consider the stock in an uptrend.
   * Default 0.08. Set negative to effectively disable the filter.
   *
   * **issue #318**: lookback は indicators.ts で 20 営業日。フィールド名
   * (`minReturn50d`) は global_config 列名 / TS interface 互換のため historical
   * に維持。renaming は #318 follow-up で。
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
  /**
   * 過熱ガード (#strategy-overextension-guards)。`(price - sma50) / sma50` が
   * この比率を超える (= SMA50 から上方に乖離しすぎ) 局面では BUY を見送る。
   * 0.60 = +60%。強トレンドの初動も切るが、+3x レバ ETF の高値掴み
   * (mean-reversion ゾーンでの entry) を避ける fail-safe 側ガード。
   */
  maxSma50DeviationPct: number
  /**
   * ボラ過熱ガード。`atr20 / baselineAtr20` がこの比率を超える (= 直近ボラが
   * baseline 対比で膨らみすぎ) 局面では BUY を見送る。1.5 = baseline の 1.5 倍。
   * 既存の atr-floor (低ボラで size 半減) と対になる高ボラ側の上限。
   */
  maxAtrRatio: number
  /**
   * 再エントリー価格ガード (#reentry)。直前に手仕舞いした価格 (flat 時の
   * `lastExecutedPrice` = 前回売値) より、この倍率 × atr20 以上 **安く** ない限り
   * 同一銘柄を買い直さない。「良い利確の直後に同水準/上で買い戻して往復で削る」
   * whipsaw を価格軸で防ぐ (時間軸の cooldown = reconcileFills が全 exit で翌
   * 営業日まで、と対)。0 で無効。既定 1.0 (= 前回売値 −1ATR)。
   */
  reentryMinAtrBelowLastExit: number
  /**
   * 再エントリー価格ガードの有効窓 (営業日)。前回手仕舞いからこの日数**未満**の
   * 間だけ上のガードを適用し、それを過ぎたら無効化して通常のトレンド再 entry を
   * 妨げない (前回売値より高い新レグでの押し目買いを永久に塞がないため)。
   * 0 で無効。既定 3。
   */
  reentryGuardBusinessDays: number
  /**
   * Stop 幅の上限 = |avgPrice * takeProfitPct| * これ (#stop-rr-cap)。ATR 連動
   * stop が利確幅に対して一方的に広がるのを止め、銘柄ごとの R:R に下限を作る
   * (2.0 なら R:R >= 0.5)。0 で無効 (= ATR 連動そのまま)。pct stop は floor
   * なので、cap が名目 stop より狭くなる場合は名目が勝つ。
   */
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
  /**
   * 前回手仕舞い価格 (#reentry)。flat 時の `SymbolState.lastExecutedPrice`
   * (= 保有を閉じた SELL の約定価格) を渡す。null / 未設定なら価格ガード素通り。
   */
  lastExitPrice?: number | null
  /**
   * 前回手仕舞いからの経過営業日 (#reentry)。scheduler が `lastExitAt` から
   * market 別に算出して渡す。null なら価格ガード素通り (recency 判定不能)。
   */
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

    // ATR 連動 stop (#exit-atr) + R:R cap (#stop-rr-cap)。距離の決定は
    // `resolveStopDistance` に一本化 (sizing と同式)。
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
    // #stop-rr-cap: 表示する下限は名目 `stopPct` ではなく **実効 stop**。
    // ATR / cap で動く値なので、名目を出すと operator が「-8% で切れる」と
    // 誤読する (実際は -10.7% だった等)。
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

    // 再エントリー価格ガード (#reentry): 前回手仕舞い (前回売値) から
    // reentryGuardBusinessDays 営業日以内は、前回売値より reentryMinAtrBelowLastExit
    // × atr20 以上 安い水準でなければ BUY を見送る。良い利確直後の同水準/高値
    // 買い戻し (往復で削る whipsaw) を価格軸で止める。窓を過ぎる or 経過日数
    // すら不明 (一度も exit していない) は fail-open (通常のトレンド再 entry を
    // 妨げない)。ただし窓内なのに前回売値だけ不明 (#660 移行期) は例外的に
    // fail-closed — 下の early block を参照。
    const lastExitPrice = input.lastExitPrice ?? null
    const bdSinceExit = input.businessDaysSinceExit ?? null
    const reentryWindowConfigured = rule.reentryMinAtrBelowLastExit > 0 && rule.reentryGuardBusinessDays > 0

    // #660: 移行期 fail-closed。lastExitAt は既に本番 DO にあるが lastExitPrice
    // は新規フィールドなので、deploy 直前の guard 窓内 (reentryGuardBusinessDays
    // 未満) に exit した銘柄は lastExitAt はあるのに lastExitPrice が無い状態に
    // なりうる。これを従来通り fail-open (ガード不活性) にすると、まさに
    // ガードで守るべき窓内で無防備に買い直せてしまう。窓内かどうかは
    // lastExitAt 由来の bdSinceExit だけで判定できるので、価格不明でも窓内は
    // entry を保留する。恒久 block ではなく窓経過 (bdSinceExit >=
    // reentryGuardBusinessDays) で自然解除。lastExitAt も無い (=一度も exit
    // していない、または旧 state のまま) 銘柄は従来どおり無条件で通す。
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

    // #658: ここから先の 7 gate は entryDistance.ts の EntryGateKey と一対一で
    // 対応する「setup の質」ゲート (行動可否 guard ではない)。HALF 昇格の検討
    // 対象になり得るので、HOLD を返す際は holdCause='entry_gate' と 4 段階判定
    // スナップショットを同梱する。scheduler 側の再導出を廃止した対価として、
    // HOLD ごとに deriveEntryStatusFromIndicators (7 gate の再評価 1 回) を呼ぶ
    // (#658)。

    if (ind.return50d <= rule.minReturn50d) {
      trace.push(step('entry.trend_50d_return', false, ind.return50d, '>', rule.minReturn50d))
      // #318: lookback は 20 営業日 (フィールド名は historical)。reason は人間
      // 向け表示なので「20d return」と書いて誤読を避ける。
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

    // 過熱ガード (#strategy-overextension-guards): trend は成立していても SMA50 から
    // 上方に乖離しすぎた blowoff では押し目買いを見送る (+3x の高値掴み回避)。
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

    // ボラ過熱ガード: 直近 ATR が baseline 対比で膨らみすぎた regime 破綻局面の
    // entry を抑制。baseline 不明 (<=0) のときは gate を素通り (情報不足で止めない)。
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
      // #318: lookback は 10 営業日 (フィールド名は historical)。
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

/**
 * `cause` の既定値は 'guard' (#658, fail-closed)。行動可否 guard
 * (position / pendingOrder / cooldown / 再エントリー価格ガード) 由来の HOLD は
 * すべてこの既定に乗る — HALF 昇格は絶対禁止なので、明示的に 'entry_gate' を
 * 渡した呼び出し元 (setup の質を測る 7 gate) だけが昇格の検討対象になる。
 */
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
  // #318: trace 識別子 (`entry.trend_50d_return` / `entry.high20d_valid`) は
  // 既存 decision_log と互換維持のため据え置き。**表示文字列のみ実 lookback に
  // 合わせて 20日 / 10日 と表記**。
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
