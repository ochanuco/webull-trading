import type { BarClient } from '../../infrastructure/quotes/BarClient'
import { logPostSubmit, logPreSubmit } from '../../infrastructure/logger/tradeJournal'
import type { Notifier } from '../../infrastructure/notification/Notifier'
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
import { decideBucketGate } from '../risk/bucketExposureGate'
import { evaluateEarningsGate } from '../risk/earningsGate'
import type { EarningsCalendarRepo } from '../../infrastructure/calendar/earningsCalendarRepo'
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
   * symbol → bucket tag ('semi' 等)。同一 bucket の open position 合計
   * notional を bucketCapMap で clamp する。未指定 symbol は個別判定。
   */
  symbolBucketMap?: Record<string, string>
  /**
   * bucket → 合計 notional 上限 (単一 currency の absolute 値)。呼び出し側
   * (runStrategyCron) が NAV × exposure_pct で算出する。
   */
  bucketCapMap?: Record<string, number>
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
   * Earnings calendar gate (issue #196 1/3)。±N 営業日で BUY を凍結。
   * `repo` 未注入なら gate skip (POC 後方互換)。production
   * (`runStrategyCron`) が D1 から repo を作って渡す。
   */
  earningsGate?: EarningsScheduleConfig
  now?: () => Date
}

export interface EarningsScheduleConfig {
  repo: EarningsCalendarRepo
  /** ±N 営業日。default 1。 */
  freezeBusinessDays?: number
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

  // Bucket pre-scan: sum the open-position notional per bucket across all
  // symbols in this run so the BUY gate can refuse an entry that would push
  // the bucket over `bucketCapMap[bucket]`. Skipped entirely when no bucket
  // map provided. Quote source: lastQuote ?? avgPrice — cron runs at :15 so
  // quote feed (*/5) should have populated lastQuote already; avgPrice is a
  // safe fallback that just charges bucket at cost basis.
  const bucketExposure: Record<string, number> = {}
  if (options.symbolBucketMap && options.bucketCapMap) {
    for (const sym of options.symbols) {
      const bucket = options.symbolBucketMap[sym.toUpperCase()]
      if (!bucket) continue
      try {
        const s = await options.positionStore.getState(sym.toUpperCase())
        if (s.position !== null && s.position.qty > 0) {
          const px = s.lastQuote?.price ?? s.position.avgPrice
          if (Number.isFinite(px) && px > 0) {
            bucketExposure[bucket] = (bucketExposure[bucket] ?? 0) + s.position.qty * px
          }
        }
      } catch {
        // Pre-scan failure for one symbol shouldn't block the rest of the
        // scheduler. The per-symbol loop below will retry getState and
        // surface errors in `summary.errors`.
      }
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
      const notional = sizing.quantity * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${sizing.quantity}, price=${indicators.price})`
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
      const bucket = options.symbolBucketMap?.[upper]
      const bucketDecision = decideBucketGate({
        bucket,
        currentExposure: bucket ? bucketExposure[bucket] ?? 0 : 0,
        addNotional: notional,
        cap: bucket ? options.bucketCapMap?.[bucket] : undefined,
      })
      if (!bucketDecision.allowed) {
        const reason = bucketDecision.reason ?? 'bucket cap'
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({
          symbol: upper,
          decision: 'REJECT',
          reason,
          price: indicators.price,
          indicatorsJson: JSON.stringify(indicators),
          trace: appendTrace(signal.trace, traceStep('risk.bucket_cap', false, notional, '<=', bucket ? options.bucketCapMap?.[bucket] ?? null : null, reason)),
        })
        continue
      }
      if (bucket && bucketDecision.newExposure !== undefined) {
        bucketExposure[bucket] = bucketDecision.newExposure
      }
      intent = buildIntent(upper, 'BUY', sizing.quantity, indicators.price)
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
    const startedAt = Date.now()
    try {
      result = await options.execution.execute(intent)
    } catch (error) {
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
        cause: 'broker submit',
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

    try {
      logPostSubmit({
        clientOrderId: intent.clientOrderId,
        symbol: upper,
        result,
        latencyMs: Date.now() - startedAt,
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

    // Increment counters only after successful execution.
    if (intent.side === 'BUY') {
      summary.buys += 1
    } else {
      summary.sells += 1
    }
    await emitDecision({
      symbol: upper,
      decision: intent.side,
      reason: signal.reason,
      price: intent.price,
      indicatorsJson: JSON.stringify(indicators),
      clientOrderId: intent.clientOrderId,
      trace: appendTrace(signal.trace, traceStep('broker.submit', true, result.mode, '==', 'submitted')),
      order: {
        side: intent.side,
        quantity: intent.quantity,
        notional: intent.notional,
      },
    })

    // SELL の realizedPnl は state.position.avgPrice (existing) と
    // intent.price (exit) の差から推定。BUY 時は undefined。avgPrice が無い
    // SELL は不正経路 (上で reject 済) なので発生しないはずだが defensive。
    const realizedPnl =
      intent.side === 'SELL' && state.position && Number.isFinite(state.position.avgPrice)
        ? (intent.price - state.position.avgPrice) * intent.quantity
        : undefined
    emitNotify({
      type: 'TRADE',
      side: intent.side,
      symbol: upper,
      qty: intent.quantity,
      price: intent.price,
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
  'risk.bucket_cap': '同グループ建玉上限内',
  'risk.earnings_calendar': '決算日カレンダーゲート',
  'risk.per_symbol_gate': '銘柄別リスクゲート',
  'broker.submit': '証券会社への発注送信',
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
