import type { BarClient } from '../../infrastructure/quotes/BarClient'
import { logPostSubmit, logPreSubmit } from '../../infrastructure/logger/tradeJournal'
import { classifyBrokerErrorCause } from '../../infrastructure/notification/brokerErrorSurge'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import { isSellQtyExceedError } from '../../shared/errors'
import type { DecisionTraceStep } from '../domain/Signal'
import { inferTradingMarket } from '../domain/tradingCalendar'
import type { Execution } from '../execution/Execution'
import type { PositionStore } from '../state/PositionStore'
import type { SymbolState } from '../state/types'
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from './indicators'
import { computePullbackSizing } from './pullbackSizing'
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import {
  PullbackUptrendStrategy,
  TEST_DEFAULT_RULE,
  type SymbolRule,
} from './strategies/PullbackUptrendStrategy'
import { evaluateEarningsGate } from '../risk/earningsGate'
import {
  DEFAULT_MACRO_GATE_CONFIG,
  evaluateMacroEventGate,
  type MacroEventGateConfig,
} from '../risk/macroEventGate'
import type { VixRegimeFilterDecision } from '../risk/vixRegimeFilter'
import type { EarningsCalendarRepo } from '../../infrastructure/calendar/earningsCalendarRepo'
import type { MacroEventCalendarRepo } from '../../infrastructure/calendar/macroEventCalendarRepo'
import { evaluatePerSymbolRisk } from '../risk/perSymbolRiskGate'

const DEFAULT_BAR_LOOKBACK = 60

export interface PullbackSchedulerOptions {
  symbols: string[]
  equity: number
  barClient: BarClient
  positionStore: PositionStore
  execution: Execution
  strategy?: PullbackUptrendStrategy
  /**
   * Default rule used when neither `strategy` nor a per-symbol `rulesMap`
   * entry applies. Production path (runStrategyCron) loads this from
   * global_config in D1; tests can pass TEST_DEFAULT_RULE or a custom one.
   */
  defaultRule?: SymbolRule
  rulesMap?: Record<string, SymbolRule>
  symbolCapMap?: Record<string, number>
  barLookback?: number
  riskPerTradePct?: number
  pendingLockTtlMs?: number
  /**
   * Exchange lot size for this run (e.g. 100 for TSE). Default 1. Applied
   * uniformly to all symbols in this invocation — callers running mixed
   * markets should invoke the scheduler once per lot-size.
   */
  lotSize?: number
  /**
   * symbol → budget_alloc_pct (0<pct<=1)。指定 symbol は fixed-% 配分 sizing
   * (口座(円)単一プールに対する割合) に切替わる (#budget-jpy-base-fx)。
   * 未指定 symbol は従来の risk-% sizing。
   */
  symbolBudgetAllocPctMap?: Record<string, number>
  /**
   * 予算配分の基準額 = 口座総額 (円、`total_capital_jpy`)。budget 銘柄の sizing 基準。
   */
  budgetBasisJpy?: number
  /**
   * この run の symbol 通貨 1 単位 = 何円か (JPY run=1、USD run=USD/JPY レート)。
   * USD で FX 取得失敗時は undefined を渡し、budget 銘柄を fail-closed させる。
   */
  fxJpyPerSymbolCcy?: number
  /**
   * Per-symbol decision sink。HOLD / BUY / SELL / REJECT / ERROR の各 route で
   * 1 回ずつ呼ばれる。実装は D1 INSERT が典型 (#128)、テストは fake 注入可能。
   * 呼び出し側が失敗を throw しないのが前提 (logging failure isolation)。
   */
  onDecision?: (record: {
    symbol: string
    decision: 'BUY' | 'SELL' | 'HOLD' | 'REJECT' | 'ERROR'
    reason?: string
    price?: number
    indicatorsJson?: string
    /** BUY/SELL 成立時のみ設定。dashboard が trade_journal と JOIN する key (#143)。 */
    clientOrderId?: string
    trace?: DecisionTraceStep[]
  }) => Promise<void> | void
  /**
   * cron fire 単位の correlation id。emit 失敗時の構造化ログに含めることで
   * 「どの run で decision sink が落ちたか」を tail から追えるようにする
   * (CodeRabbit #132 follow-up)。runStrategyCron が scheduled() handler の
   * `crypto.randomUUID()` を渡す。
   */
  requestId?: string
  /**
   * Slack/Discord webhook 通知用 sink (#199)。BUY/SELL emit 時と cron error 時に
   * fire-and-forget で叩く。実装は失敗を握りつぶす責務 (silent fallback) なので
   * scheduler 側は `.catch()` を付けるだけで cron を blocking しない。
   */
  notifier?: Notifier
  /**
   * Per-symbol risk gate config (issue #138 — TradingService と unify)。未指定で
   * cron 経路を無 gate のままにできるよう、deps すべてが有効値なら gate 適用、
   * 一つでも欠けると skip にして既存挙動を保つ (POC 後方互換)。production
   * (`runStrategyCron`) は global_config / symbolUniverse から fully populate する。
   */
  perSymbolRisk?: PerSymbolRiskScheduleConfig
  /**
   * Webull SELL_QTY_EXCEED fallback resolver。SELL submit が
   * `OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY` (HTTP 417) で reject
   * された時に呼ばれる: broker portfolio から実 available qty を返し、
   * `available > 0 && available < intent.quantity` なら scheduler が
   * 全部売りで再 submit する (= 辻褄合わせ)。失敗時は throw でも null
   * 返却でも OK で、いずれの場合も元 SELL_QTY_EXCEED エラーが re-throw
   * される (fail-closed)。production (`runStrategyCron`) は
   * `WebullHttpClient.getPositions()` でラップして注入する。未注入なら
   * fallback は skip (= 既存挙動の元 error 再 throw、POC 後方互換)。
   *
   * Race window: getAvailableQty と SELL submit の間で broker side が
   * 動く可能性は POC 段階では許容。連続 reject は次の cron tick で
   * 再評価される。
   */
  sellFallback?: SellFallbackConfig
  /**
   * Earnings calendar gate (issue #196 1/3)。±N 営業日で BUY を凍結。
   * `repo` 未注入なら gate skip (POC 後方互換)。production
   * (`runStrategyCron`) が D1 から repo を作って渡す。
   */
  earningsGate?: EarningsScheduleConfig
  /**
   * Macro event gate (issue #196 2/3)。FOMC / CPI / NFP 等の発表 ±N 時間で
   * 全銘柄 BUY を凍結。`repo` 未注入なら skip (POC 後方互換)。earnings gate
   * より後ろで評価される (両方 reject なら earnings reason が先に確定する)。
   */
  macroEventGate?: MacroEventScheduleConfig
  /**
   * VIX regime filter decision (issue #196 3/3)。caller (`runStrategyCron`) が
   * cron tick 起動時に `^VIX` を fetch し `evaluateVixRegime` を呼んで作る。
   * scheduler は decision を受け取って:
   *   - sizeScale === 0 (critical): BUY 全 reject (reason: `risk: vix_critical: ...`)
   *   - 0 < sizeScale < 1 (warning): `intent.quantity = floor(qty * sizeScale)`
   *   - sizeScale === 1 (normal / unavailable): no-op
   * 未注入なら skip (POC 後方互換)。SELL は VIX 関係なく通す。
   */
  vixDecision?: VixRegimeFilterDecision
  /**
   * sanity_failed cooldown gate。直近 N 分以内に同 symbol で broker stub
   * fill (`resolveFilledPrice` が ratio guard で reject した) が観測されて
   * いた場合、新規 BUY を block する。9697 04/28 incident (30 min/6 fills 累積、
   * DO null のまま broker 側 600 株疑い) の再発防止 fail-closed gate。
   *
   * 未注入なら skip (POC 後方互換)。SELL は対象外 (= broker stub では起きない、
   * exit 経路を妨げないため)。
   */
  sanityFailedCooldown?: SanityFailedCooldownConfig
  now?: () => Date
}

export interface SanityFailedCooldownConfig {
  /**
   * `symbol` (大文字) について、直近 `withinMs` 内に sanity_failed 系の
   * trade_journal row があるかを返す predicate。production は
   * `hasRecentSanityFailure(env.DB, ...)` で wrap、test は fake で注入する。
   * throw した場合は fail-closed (= cooldown 有効扱い) で BUY を reject。
   */
  check: (symbol: string) => Promise<boolean>
  /**
   * Operator 視認用の窓幅 (ms)。reject reason 文字列に埋め込むだけで、
   * 実際の cutoff は `check` 実装側が持つ (= 1 source of truth)。
   */
  withinMs: number
}

/**
 * Resolver for the SELL_QTY_EXCEED fallback. Returns the broker-side
 * `quantity_available` for the symbol (case-insensitive match), or `null`
 * if not held / not findable. Throwing here is treated the same as `null`
 * — the fallback is best-effort and never converts a SELL reject into a
 * different reject (the original SELL_QTY_EXCEED error is re-thrown).
 */
export interface SellFallbackConfig {
  getAvailableQty: (symbol: string) => Promise<number | null>
}

export interface EarningsScheduleConfig {
  repo: EarningsCalendarRepo
  /** ±N 営業日。default 1。 */
  freezeBusinessDays?: number
}

export interface MacroEventScheduleConfig {
  repo: MacroEventCalendarRepo
  /**
   * Gate config (freeze hours / full-day fallback)。Partial で渡せて、
   * 未指定の field は `DEFAULT_MACRO_GATE_CONFIG` (発表前 1h / 発表後 6h /
   * full-day=true) で補う。
   */
  config?: Partial<MacroEventGateConfig>
}

export interface PerSymbolRiskScheduleConfig {
  /**
   * BUY symbol → inverse symbol map。production は symbol_universe.inversePairs。
   * 大文字 key 前提で渡す。
   */
  inversePairs: Record<string, string>
  spreadLimits: { US: number; JP: number }
  staleQuoteMs: number
  gapRejectPct: number
}

export interface PullbackRunSummary {
  evaluated: number
  buys: number
  sells: number
  holds: number
  rejected: Array<{ symbol: string; reason: string }>
  errors: Array<{ symbol: string; message: string }>
  /**
   * One JSON-copyable record per symbol decision. This mirrors
   * strategy_decision_log so a single cron run can be analyzed without
   * reconstructing context from scattered log lines.
   */
  decisions: PullbackDecisionTrace[]
  /**
   * VIX regime filter decision applied to this run (issue #196 3/3)。
   * `vixDecision` option を渡された時のみ set される (POC 後方互換)。
   * cron summary log / dashboard で「この run でどの regime で動いていたか」
   * を可視化するために残す。
   */
  vix?: VixRegimeFilterDecision
}

export interface PullbackDecisionTrace {
  symbol: string
  decision: 'BUY' | 'SELL' | 'HOLD' | 'REJECT' | 'ERROR'
  reason?: string
  price?: number
  indicatorsJson?: string
  trace?: DecisionTraceStep[]
  clientOrderId?: string | null
  order?: {
    side: 'BUY' | 'SELL'
    quantity: number
    notional: number
  }
}

/**
 * Drives PullbackUptrendStrategy across the ALLOWED_SYMBOLS universe on a
 * daily cadence: pulls daily bars, computes indicators, reads DO state,
 * resolves quantity via `computePullbackSizing`, then submits through the
 * provided {@link Execution}. The scheduler itself is transport-agnostic —
 * {@link src/index.ts} wires it to a Workers cron trigger.
 */
export async function runPullbackScheduler(
  options: PullbackSchedulerOptions,
): Promise<PullbackRunSummary> {
  const now = options.now ?? (() => new Date())
  const lookback = options.barLookback ?? DEFAULT_BAR_LOOKBACK
  const strategy =
    options.strategy ??
    new PullbackUptrendStrategy(options.defaultRule ?? TEST_DEFAULT_RULE, options.rulesMap ?? {})
  const pendingLockTtlMs = options.pendingLockTtlMs ?? 60_000
  if (typeof pendingLockTtlMs !== 'number' || !Number.isFinite(pendingLockTtlMs) || pendingLockTtlMs <= 0) {
    throw new Error(`pendingLockTtlMs must be a finite positive number, got: ${pendingLockTtlMs}`)
  }

  const summary: PullbackRunSummary = {
    evaluated: 0,
    buys: 0,
    sells: 0,
    holds: 0,
    rejected: [],
    errors: [],
    decisions: [],
    ...(options.vixDecision !== undefined ? { vix: options.vixDecision } : {}),
  }

  // Notifier helper: fire-and-forget。Notifier 実装側で silent fallback する
  // 約束だが、念のため二重 catch して cron を絶対に落とさない (#199)。
  const emitNotify = (event: Parameters<NonNullable<typeof options.notifier>['notify']>[0]): void => {
    if (!options.notifier) return
    try {
      const p = options.notifier.notify(event)
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        ;(p as Promise<unknown>).catch((err) => {
          console.warn(
            JSON.stringify({
              event: 'notifier_emit_failed',
              requestId: options.requestId ?? null,
              message: err instanceof Error ? err.message : String(err),
            }),
          )
        })
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'notifier_emit_failed',
          requestId: options.requestId ?? null,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  // Logging helper: sink が投げても本体を落とさない (logging failure isolation)。
  const emitDecision = async (
    record: Parameters<NonNullable<typeof options.onDecision>>[0] & {
      order?: PullbackDecisionTrace['order']
    },
  ): Promise<void> => {
    summary.decisions.push({
      symbol: record.symbol,
      decision: record.decision,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      ...(record.price !== undefined ? { price: record.price } : {}),
      ...(record.indicatorsJson !== undefined ? { indicatorsJson: record.indicatorsJson } : {}),
      ...(record.trace !== undefined ? { trace: record.trace } : {}),
      ...(record.clientOrderId !== undefined ? { clientOrderId: record.clientOrderId } : {}),
      ...(record.order !== undefined ? { order: record.order } : {}),
    })
    if (!options.onDecision) return
    try {
      const { order: _order, ...dbRecord } = record
      await options.onDecision(dbRecord)
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'on_decision_sink_failed',
          requestId: options.requestId ?? null,
          symbol: record.symbol,
          decision: record.decision,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  for (const symbol of options.symbols) {
    summary.evaluated += 1
    const upper = symbol.toUpperCase()
    let bars: DailyBar[]
    let intradayPrice: number | null = null
    try {
      // Daily と intraday は別エンドポイント。並行で叩いて intraday 失敗は
      // null fallback (= daily close 採用、既存挙動と等価)。daily 失敗は致命
      // (indicators が出ない) なので throw のまま。
      const dailyP = options.barClient.getDailyBars(symbol, lookback)
      const intradayP = options.barClient.getIntradayBars
        ? options.barClient.getIntradayBars(symbol, '60m').catch(() => [])
        : Promise.resolve([])
      const [dailyBars, intradayBars] = await Promise.all([dailyP, intradayP])
      bars = dailyBars
      // 最新 1h bar の close を fill 価格として使う。chart UI も同じ
      // intraday endpoint を見ているので BUY pin と candle がズレない。
      const lastIntraday = intradayBars[intradayBars.length - 1]
      intradayPrice = lastIntraday ? lastIntraday.close : null
    } catch (error) {
      summary.errors.push({ symbol: upper, message: messageOf(error) })
      await emitDecision({ symbol: upper, decision: 'ERROR', reason: `bar fetch: ${messageOf(error)}` })
      emitNotify({ type: 'ERROR', symbol: upper, message: messageOf(error), cause: 'bar fetch' })
      continue
    }

    const indicators = computePullbackIndicators(bars, intradayPrice)
    if (!indicators) {
      summary.rejected.push({ symbol: upper, reason: 'insufficient bars for indicators' })
      await emitDecision({ symbol: upper, decision: 'REJECT', reason: 'insufficient bars for indicators' })
      continue
    }

    const state = await options.positionStore.getState(upper)
    const market = inferTradingMarket(upper)
    const holdBusinessDays =
      state.position !== null
        ? computeHoldBusinessDays(state.position.openedAt, now(), market)
        : 0

    const signal = strategy.decide({
      symbol: upper,
      indicators,
      position: state.position,
      pendingOrder: state.pendingOrder,
      cooldownUntil: state.cooldownUntil,
      holdBusinessDays,
      now: now(),
    })

    if (signal.action === 'HOLD') {
      summary.holds += 1
      await emitDecision({
        symbol: upper,
        decision: 'HOLD',
        reason: signal.reason,
        price: indicators.price,
        indicatorsJson: JSON.stringify(indicators),
        trace: signal.trace,
      })
      continue
    }

    // sanity_failed cooldown gate (incident: 9697 04/28 で 30 min / 6 BUY 累積、
    // DO null / broker 側 600 株疑い)。直近 N 分以内に同 symbol で broker stub
    // fill が観測されていれば新規 BUY を block する。SELL は対象外 (broker stub
    // では起きない、exit を妨げない)。signal.action === 'BUY' のみ評価し、
    // intent build / sizing 計算より前で短絡させる (= 不要な計算を避ける)。
    // check が throw した場合は fail-closed (= cooldown 有効扱い) — DB read
    // 失敗で BUY を通すと incident 再発リスクが残るため。
    if (signal.action === 'BUY' && options.sanityFailedCooldown) {
      let cooledDown = false
      try {
        cooledDown = await options.sanityFailedCooldown.check(upper)
      } catch (err) {
        cooledDown = true
        console.warn(
          JSON.stringify({
            event: 'sanity_failed_cooldown_check_failed',
            requestId: options.requestId ?? null,
            symbol: upper,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      if (cooledDown) {
        const minutes = Math.round(options.sanityFailedCooldown.withinMs / 60_000)
        const reason = `risk: sanity_failed cooldown active (recent broker stub fill within ${minutes}min)`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.sanity_failed_cooldown', false, undefined, undefined, undefined, reason),
          ),
        })
        continue
      }
    }

    let intent: OrderIntent
    if (signal.action === 'BUY') {
      const rule = strategy.resolveRule(upper)
      const sizing = computePullbackSizing({
        equity: options.equity,
        entryPrice: indicators.price,
        stopPct: rule.stopPct,
        atr20: indicators.atr20,
        baselineAtr20: indicators.baselineAtr20,
        symbolCap: options.symbolCapMap?.[upper],
        riskPerTradePct: options.riskPerTradePct,
        lotSize: options.lotSize,
        kAtr: rule.kAtr,
        budgetAllocPct: options.symbolBudgetAllocPctMap?.[upper],
        budgetBasisJpy: options.budgetBasisJpy,
        fxJpyPerSymbolCcy: options.fxJpyPerSymbolCcy,
      })
      if (sizing.quantity <= 0) {
        const reason = buildSizingRejectReason(sizing, {
          lotSize: options.lotSize ?? 1,
          entryPrice: indicators.price,
        })
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('sizing.quantity_positive', false, sizing.quantity, '>', 0, sizing.capReason)),
        })
        continue
      }
      // VIX regime filter (issue #196 3/3) — sizing 直後に適用。
      //   - critical (sizeScale === 0): BUY 全 reject
      //   - warning (0 < sizeScale < 1): qty = floor(qty * sizeScale / lot) * lot
      //   - normal (sizeScale === 1): no-op
      // SELL は VIX 関係なく通すため、ここで scaling しても OK (BUY 経路だけ)。
      let scaledQuantity = sizing.quantity
      if (options.vixDecision) {
        if (options.vixDecision.sizeScale === 0) {
          // critical: BUY 全 reject。decision.reason をそのまま乗せて操作者に
          // 「VIX で止めた」を明示する (localizeReason が日本語化)。
          const reason = `risk: ${options.vixDecision.reason}`
          summary.rejected.push({ symbol: upper, reason })
          await emitDecision({
            symbol: upper,
            decision: 'REJECT',
            reason,
            price: indicators.price,
            indicatorsJson: JSON.stringify(indicators),
            trace: appendTrace(
              signal.trace,
              traceStep('risk.vix_regime', false, options.vixDecision.vix ?? null, '<=', null, options.vixDecision.reason),
            ),
          })
          continue
        }
        if (options.vixDecision.sizeScale < 1) {
          // warning: qty を `floor(qty * scale / lot) * lot` で lot に揃える。
          // lot=1 の US 株は単純な floor、lot=100 の JP 株は単元未満で 0 になり得る。
          // 結果が 0 になった場合は次の `scaledQuantity <= 0` reject で拾う。
          const lot = options.lotSize ?? 1
          const rawScaled = sizing.quantity * options.vixDecision.sizeScale
          scaledQuantity = lot > 1
            ? Math.floor(rawScaled / lot) * lot
            : Math.floor(rawScaled)
          if (scaledQuantity <= 0) {
            const reason = `risk: ${options.vixDecision.reason} (qty rounded to 0, lot=${lot})`
            summary.rejected.push({ symbol: upper, reason })
            await emitDecision({
              symbol: upper,
              decision: 'REJECT',
              reason,
              price: indicators.price,
              indicatorsJson: JSON.stringify(indicators),
              trace: appendTrace(
                signal.trace,
                traceStep(
                  'risk.vix_regime',
                  false,
                  scaledQuantity,
                  '>',
                  0,
                  `${options.vixDecision.reason}; qty 0 after lot round`,
                ),
              ),
            })
            continue
          }
        }
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.price_valid', false, indicators.price, '>', 0)),
        })
        continue
      }
      const notional = scaledQuantity * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${scaledQuantity}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.notional_valid', false, notional, '>', 0)),
        })
        continue
      }
      intent = buildIntent(upper, 'BUY', scaledQuantity, indicators.price)
    } else {
      // SELL: close the full open position.
      if (state.position === null) {
        const reason = 'SELL without position'
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.sell_position_exists', false, false, 'exists', true)),
        })
        continue
      }
      if (!Number.isFinite(state.position.qty) || state.position.qty <= 0) {
        const reason = `invalid position qty: ${state.position.qty}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.position_qty_valid', false, state.position.qty, '>', 0)),
        })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.price_valid', false, indicators.price, '>', 0)),
        })
        continue
      }
      const notional = state.position.qty * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${state.position.qty}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('scheduler.notional_valid', false, notional, '>', 0)),
        })
        continue
      }
      intent = buildIntent(upper, 'SELL', state.position.qty, indicators.price)
    }

    // Earnings calendar gate (issue #196 1/3)。BUY の場合のみ評価し、
    // ±N 営業日内に earnings_calendar 行があれば reject。SELL は撤退路を
    // 妨げないよう gate 対象外。`earningsGate` 未注入なら skip (POC 後方互換)。
    // perSymbolRisk より先に評価することで、broker / spread 系より上位の
    // 「そもそもエントリしない」判断として cron 経路から見える。
    if (options.earningsGate && intent.side === 'BUY') {
      const evalDate = now().toISOString().slice(0, 10)
      const earningsDecision = await evaluateEarningsGate(
        { symbol: upper, evalDate, side: 'BUY' },
        options.earningsGate.repo,
        { freezeBusinessDays: options.earningsGate.freezeBusinessDays ?? 1 },
      )
      if (!earningsDecision.approved) {
        const reason = `risk: ${earningsDecision.reason ?? 'earnings_gate'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.earnings_calendar', false, undefined, undefined, undefined, earningsDecision.reason),
          ),
        })
        continue
      }
    }

    // Macro event gate (issue #196 2/3)。FOMC / CPI / NFP 等の発表 ±N 時間
    // (default 1h) は全銘柄 BUY を凍結する。earnings gate より後で評価する
    // ので、両方 reject なら earnings reason が先に確定する (task 指定の
    // 優先順位)。`macroEventGate` 未注入なら skip (POC 後方互換)。
    if (options.macroEventGate && intent.side === 'BUY') {
      const evalTimestamp = now().toISOString()
      const macroDecision = await evaluateMacroEventGate(
        { evalTimestamp, side: 'BUY' },
        options.macroEventGate.repo,
        { ...DEFAULT_MACRO_GATE_CONFIG, ...(options.macroEventGate.config ?? {}) },
      )
      if (!macroDecision.approved) {
        const reason = `risk: ${macroDecision.reason ?? 'macro_event_gate'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(
            signal.trace,
            traceStep('risk.macro_event', false, undefined, undefined, undefined, macroDecision.reason),
          ),
        })
        continue
      }
    }

    // Per-symbol risk gate (issue #138)。manual `/trade/execute` (TradingService)
    // と同じ pure function を呼ぶことで gate parity を取る。perSymbolRisk が
    // 未注入の場合は POC 後方互換で skip。Inverse pair の SymbolState は同期
    // pure 関数で要求されるため、BUY のみ事前 fetch する。
    if (options.perSymbolRisk) {
      let inverseState: SymbolState | null = null
      const inverseSymbol =
        intent.side === 'BUY' ? options.perSymbolRisk.inversePairs[upper] : undefined
      if (inverseSymbol) {
        try {
          inverseState = await options.positionStore.getState(inverseSymbol)
        } catch {
          // fetch 失敗は inverse gate fail-open。inverse 銘柄の state read 失敗
          // で BUY ごと止めると universe 全体が連鎖 reject になり得るため、
          // 他の gate (settled cash / spread / freshness など) に任せる。
          inverseState = null
        }
      }
      const riskDecision = evaluatePerSymbolRisk(
        {
          symbol: upper,
          side: intent.side,
          intentPrice: intent.price,
          intentNotional: intent.notional,
          state,
          inverseState,
          now: now(),
        },
        {
          inversePairs: options.perSymbolRisk.inversePairs,
          spreadLimits: options.perSymbolRisk.spreadLimits,
          staleQuoteMs: options.perSymbolRisk.staleQuoteMs,
          gapRejectPct: options.perSymbolRisk.gapRejectPct,
          // Strategy.decide() が cooldown を既に評価しているので冗長 (両者
          // 同義)。重複させても挙動は変わらないが、cron 経路では skip。
          evaluateCooldown: false,
        },
      )
      if (!riskDecision.approved) {
        const reason = `risk: ${riskDecision.reasons.join(', ')}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('risk.per_symbol_gate', false, undefined, undefined, undefined, riskDecision.reasons.join(', '))),
        })
        continue
      }
    }

    const expiresAtMs = now().getTime() + pendingLockTtlMs
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
      const reason = `invalid expiresAt computed from pendingLockTtlMs: ${pendingLockTtlMs}`
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'REJECT',
        reason,
        price: indicators.price,
        trace: appendTrace(signal.trace, traceStep('scheduler.pending_lock_expiry_valid', false, expiresAtMs, '>', now().getTime())),
      })
      continue
    }
    const lockResult = await options.positionStore.lockPendingOrder(upper, {
      clientOrderId: intent.clientOrderId,
      side: intent.side,
      submittedAt: now().toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    })
    if (!lockResult.ok) {
      const reason = 'pending order already in flight'
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({
        symbol: upper,
        decision: 'REJECT',
        reason,
        price: indicators.price,
        trace: appendTrace(signal.trace, traceStep('scheduler.pending_lock_acquired', false, false, '==', true)),
      })
      continue
    }

    // Journal the pre_submit so reconcileFills (which scans
    // trade_journal.post_submit with broker_status IS NULL) can pick up
    // the cron-placed order. Without this, cron orders bypass the
    // journal entirely and are invisible to reconcile.
    //
    // Logging is isolated in its own try/catch — if the logger sink
    // (D1 write) throws, we must still proceed to execute + release
    // the pending lock, otherwise the lock leaks and the symbol gets
    // stuck.
    try {
      logPreSubmit({ clientOrderId: intent.clientOrderId, intent })
    } catch (logError) {
      console.error(
        JSON.stringify({
          event: 'cron_log_pre_submit_failed',
          symbol: upper,
          clientOrderId: intent.clientOrderId,
          message: logError instanceof Error ? logError.message : String(logError),
        }),
      )
    }

    let result: ExecutionResult | undefined
    let executedIntent: OrderIntent = intent
    let fallbackApplied = false
    const startedAt = Date.now()
    try {
      result = await options.execution.execute(intent)
    } catch (error) {
      // SELL_QTY_EXCEED fallback: Webull rejected the SELL because qty >
      // broker-side `quantity_available`. This usually means DO state has
      // drifted above broker truth (#215 reconcile race). Fetch the actual
      // available qty and retry the SELL with that — i.e. close out
      // whatever the broker actually still holds, so the next cron tick
      // sees a clean slate. If anything in the fallback fails, re-throw
      // the original error path (no silent recovery).
      const fallbackResult =
        intent.side === 'SELL' && options.sellFallback && isSellQtyExceedError(error)
          ? await tryFallbackSell({
              originalIntent: intent,
              error,
              upper,
              symbol,
              execution: options.execution,
              positionStore: options.positionStore,
              sellFallback: options.sellFallback,
              requestId: options.requestId,
            })
          : null
      if (fallbackResult) {
        result = fallbackResult.result
        executedIntent = fallbackResult.intent
        fallbackApplied = true
      } else {
        await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
        summary.errors.push({
          symbol: upper,
          message: messageOf(error),
        })
        await emitDecision({
          symbol: upper,
          decision: 'ERROR',
          // DB には英語 canonical で保存。表示層 (localizeReason) で日本語化。
          reason: `broker submit error: ${messageOf(error)}`,
          price: indicators.price,
          trace: appendTrace(signal.trace, traceStep('broker.submit', false, messageOf(error), '==', 'submitted')),
        })
        emitNotify({
          type: 'ERROR',
          symbol: upper,
          message: messageOf(error),
          // surge detector が cause で count するため (#209)、broker submit
          // failure を 4xx / 429 / 5xx / other に分類する。`null` (= broker
          // error ではない) なら legacy の `'broker submit'` に戻す。
          cause: classifyBrokerErrorCause(error) ?? 'broker submit',
        })
        try {
          logPostSubmit({
            clientOrderId: intent.clientOrderId,
            symbol: upper,
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error : new Error(String(error)),
          })
        } catch (logError) {
          console.error(
            JSON.stringify({
              event: 'cron_log_post_submit_failed',
              symbol: upper,
              clientOrderId: intent.clientOrderId,
              message: logError instanceof Error ? logError.message : String(logError),
            }),
          )
        }
        continue
      }
    }

    try {
      logPostSubmit({
        clientOrderId: executedIntent.clientOrderId,
        symbol: upper,
        result,
        latencyMs: Date.now() - startedAt,
      })
    } catch (logError) {
      console.error(
        JSON.stringify({
          event: 'cron_log_post_submit_failed',
          symbol: upper,
          clientOrderId: executedIntent.clientOrderId,
          message: logError instanceof Error ? logError.message : String(logError),
        }),
      )
    }

    // SELL_QTY_EXCEED fallback succeeded → DO state currently lies above
    // broker truth (the very reason we hit the fallback). Force-reset
    // `position=null` so the next cron tick doesn't try to SELL phantom
    // shares again. We deliberately bypass `recordFill` here because the
    // executed qty < DO qty would leave a non-zero remainder.
    if (fallbackApplied) {
      try {
        await options.positionStore.overridePosition(upper, {
          qty: 0,
          avgPrice: 0,
          openedAt: null,
          reason: `sell_qty_fallback: closed at broker available qty (originalIntentQty=${intent.quantity}, executedQty=${executedIntent.quantity})`,
          requestId: options.requestId ?? null,
        })
      } catch (resetError) {
        console.error(
          JSON.stringify({
            event: 'sell_qty_fallback_reset_failed',
            requestId: options.requestId ?? null,
            symbol: upper,
            message: resetError instanceof Error ? resetError.message : String(resetError),
          }),
        )
      }
    }

    // Increment counters only after successful execution.
    if (executedIntent.side === 'BUY') {
      summary.buys += 1
    } else {
      summary.sells += 1
    }
    await emitDecision({
      symbol: upper,
      decision: executedIntent.side,
      reason: fallbackApplied
        ? `sell_qty_fallback: ${signal.reason} (originalQty=${intent.quantity}, executedQty=${executedIntent.quantity})`
        : signal.reason,
      price: executedIntent.price,
      indicatorsJson: JSON.stringify(indicators),
      clientOrderId: executedIntent.clientOrderId,
      trace: appendTrace(
        signal.trace,
        traceStep('broker.submit', true, result.mode, '==', 'submitted'),
        ...(fallbackApplied
          ? [
              traceStep(
                'broker.sell_qty_fallback',
                true,
                executedIntent.quantity,
                '==',
                intent.quantity,
                'broker available qty で再 submit',
              ),
            ]
          : []),
      ),
      order: {
        side: executedIntent.side,
        quantity: executedIntent.quantity,
        notional: executedIntent.notional,
      },
    })

    // SELL の realizedPnl は state.position.avgPrice (existing) と
    // executedIntent.price (exit) の差から推定。BUY 時は undefined。avgPrice
    // が無い SELL は不正経路 (上で reject 済) なので発生しないはずだが defensive。
    // fallback で qty が変わった場合も executedIntent.quantity を使うので
    // realized PnL は実 SELL 数量分のみ。
    const realizedPnl =
      executedIntent.side === 'SELL' && state.position && Number.isFinite(state.position.avgPrice)
        ? (executedIntent.price - state.position.avgPrice) * executedIntent.quantity
        : undefined
    emitNotify({
      type: 'TRADE',
      side: executedIntent.side,
      symbol: upper,
      qty: executedIntent.quantity,
      price: executedIntent.price,
      ...(realizedPnl !== undefined ? { realizedPnl } : {}),
      mode: result.mode,
    })

    if (result.mode === 'DRY_RUN') {
      // No broker event will clear the lock; release it eagerly.
      await options.positionStore.clearPendingOrder(upper).catch(() => undefined)
    }
  }

  return summary
}

/**
 * SELL_QTY_EXCEED fallback inner. Returns the successful execution result
 * + the (possibly resized) intent that was actually submitted. Returns
 * `null` when the fallback can't or shouldn't run — the caller treats
 * `null` as "go re-throw the original error path".
 *
 * Conservative invariants:
 *   - `available <= 0` → null (nothing to sell, original 417 stands)
 *   - `available >= intent.quantity` → null (broker truth >= our intent;
 *     the 417 was unexpected and we shouldn't paper over it)
 *   - retry submit throws → null (don't substitute a different error)
 *   - resolver throws / returns NaN → null
 *
 * The successful path emits one structured `sell_qty_fallback_submitted`
 * audit log so the run is reconstructable from log tail. clientOrderId is
 * regenerated for the retry so it doesn't collide with the original
 * (rejected) submission's idempotency key.
 */
async function tryFallbackSell(args: {
  originalIntent: OrderIntent
  error: unknown
  upper: string
  symbol: string
  execution: Execution
  positionStore: PositionStore
  sellFallback: SellFallbackConfig
  requestId?: string
}): Promise<{ result: ExecutionResult; intent: OrderIntent } | null> {
  let available: number | null
  try {
    available = await args.sellFallback.getAvailableQty(args.upper)
  } catch (resolverErr) {
    console.warn(
      JSON.stringify({
        event: 'sell_qty_fallback_resolver_failed',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        message: resolverErr instanceof Error ? resolverErr.message : String(resolverErr),
      }),
    )
    return null
  }
  if (available === null || !Number.isFinite(available) || available <= 0) {
    return null
  }
  if (available >= args.originalIntent.quantity) {
    // Broker says we have at least as much as we tried to SELL — the 417
    // contradicts that, so the situation is something else (transient,
    // race, broker bug). Don't fabricate a reduced SELL.
    return null
  }
  const fallbackIntent: OrderIntent = {
    ...args.originalIntent,
    quantity: available,
    notional: available * args.originalIntent.price,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
  try {
    const result = await args.execution.execute(fallbackIntent)
    console.log(
      JSON.stringify({
        event: 'sell_qty_fallback_submitted',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        originalClientOrderId: args.originalIntent.clientOrderId,
        fallbackClientOrderId: fallbackIntent.clientOrderId,
        originalQty: args.originalIntent.quantity,
        fallbackQty: fallbackIntent.quantity,
        price: fallbackIntent.price,
      }),
    )
    return { result, intent: fallbackIntent }
  } catch (retryErr) {
    console.warn(
      JSON.stringify({
        event: 'sell_qty_fallback_retry_failed',
        requestId: args.requestId ?? null,
        symbol: args.upper,
        originalClientOrderId: args.originalIntent.clientOrderId,
        fallbackClientOrderId: fallbackIntent.clientOrderId,
        message: retryErr instanceof Error ? retryErr.message : String(retryErr),
      }),
    )
    return null
  }
}

function buildIntent(symbol: string, side: 'BUY' | 'SELL', qty: number, price: number): OrderIntent {
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`buildIntent: invalid qty=${qty} for ${symbol}`)
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`buildIntent: invalid price=${price} for ${symbol}`)
  }
  const notional = qty * price
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error(`buildIntent: invalid notional=${notional} for ${symbol} (qty=${qty}, price=${price})`)
  }
  return {
    symbol,
    side,
    quantity: qty,
    price,
    notional,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendTrace(
  trace: DecisionTraceStep[] | undefined,
  ...steps: DecisionTraceStep[]
): DecisionTraceStep[] {
  return [...(trace ?? []), ...steps]
}

function traceStep(
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
  'sizing.quantity_positive': '発注数量が1株/1単元以上ある',
  'scheduler.price_valid': '株価が有効',
  'scheduler.notional_valid': '発注金額が有効',
  'scheduler.sell_position_exists': '売却対象の建玉がある',
  'scheduler.position_qty_valid': '建玉数量が有効',
  'scheduler.pending_lock_expiry_valid': '注文ロック期限が有効',
  'scheduler.pending_lock_acquired': '注文ロックを取得できた',
  'risk.earnings_calendar': '決算日カレンダーゲート',
  'risk.macro_event': 'マクロイベントゲート',
  'risk.per_symbol_gate': '銘柄別リスクゲート',
  'risk.vix_regime': 'VIX レジーム判定',
  'risk.sanity_failed_cooldown': 'sanity_failed cooldown (broker stub 疑い)',
  'broker.submit': '証券会社への発注送信',
  'broker.sell_qty_fallback': 'SELL 数量超過時の broker available qty 再 submit',
}

/**
 * Build an operator-actionable reject reason from a sizing failure。
 * 単に capReason を出すと「なぜ失敗したか / 何を直せばよいか」が見えない
 * (例: `lot-size-round` だけでは raw qty も stop も予算も分からない)。
 * 失敗 route ごとに diagnostic 値を埋め込む。localizeReason 側が regex で
 * 日本語化する。
 */
function buildSizingRejectReason(
  sizing: import('./pullbackSizing').PullbackSizingResult,
  ctx: { lotSize: number; entryPrice: number },
): string {
  const cr = sizing.capReason
  if (cr === 'lot-size-round') {
    const raw = sizing.rawQuantity ?? 0
    const stop = sizing.stopDistance ?? 0
    return `sizing rejected: lot-size-round (raw qty ${raw} < lot ${ctx.lotSize}, stop ${stop.toFixed(2)}, entry ${ctx.entryPrice})`
  }
  if (cr === 'insufficient-risk-budget') {
    const budget = sizing.riskBudget ?? 0
    return `sizing rejected: insufficient-risk-budget (budget ${budget.toFixed(2)})`
  }
  if (cr === 'invalid-stop') {
    const stop = sizing.stopDistance ?? 0
    return `sizing rejected: invalid-stop (stopDistance ${stop})`
  }
  return `sizing rejected: ${cr ?? 'zero qty'}`
}
