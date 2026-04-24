import type { BarClient } from '../../infrastructure/quotes/BarClient'
import { logPostSubmit, logPreSubmit } from '../../infrastructure/logger/tradeJournal'
import { inferTradingMarket } from '../domain/tradingCalendar'
import type { Execution } from '../execution/Execution'
import type { PositionStore } from '../state/PositionStore'
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
  }) => Promise<void> | void
  now?: () => Date
}

export interface PullbackRunSummary {
  evaluated: number
  buys: number
  sells: number
  holds: number
  rejected: Array<{ symbol: string; reason: string }>
  errors: Array<{ symbol: string; message: string }>
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
  }

  // Logging helper: sink が投げても本体を落とさない (logging failure isolation)。
  const emitDecision = async (record: Parameters<NonNullable<typeof options.onDecision>>[0]): Promise<void> => {
    if (!options.onDecision) return
    try {
      await options.onDecision(record)
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'on_decision_sink_failed',
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
    try {
      bars = await options.barClient.getDailyBars(symbol, lookback)
    } catch (error) {
      summary.errors.push({ symbol: upper, message: messageOf(error) })
      await emitDecision({ symbol: upper, decision: 'ERROR', reason: `bar fetch: ${messageOf(error)}` })
      continue
    }

    const indicators = computePullbackIndicators(bars)
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
        const reason = `sizing rejected: ${sizing.capReason ?? 'zero qty'}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price, indicatorsJson: JSON.stringify(indicators) })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
        continue
      }
      const notional = sizing.quantity * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${sizing.quantity}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
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
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price, indicatorsJson: JSON.stringify(indicators) })
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
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
        continue
      }
      if (!Number.isFinite(state.position.qty) || state.position.qty <= 0) {
        const reason = `invalid position qty: ${state.position.qty}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
        continue
      }
      if (!Number.isFinite(indicators.price) || indicators.price <= 0) {
        const reason = `invalid price: ${indicators.price}`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
        continue
      }
      const notional = state.position.qty * indicators.price
      if (!Number.isFinite(notional) || notional <= 0) {
        const reason = `invalid notional: ${notional} (qty=${state.position.qty}, price=${indicators.price})`
        summary.rejected.push({ symbol: upper, reason })
        await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
        continue
      }
      intent = buildIntent(upper, 'SELL', state.position.qty, indicators.price)
    }

    const expiresAtMs = now().getTime() + pendingLockTtlMs
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now().getTime()) {
      const reason = `invalid expiresAt computed from pendingLockTtlMs: ${pendingLockTtlMs}`
      summary.rejected.push({ symbol: upper, reason })
      await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
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
      await emitDecision({ symbol: upper, decision: 'REJECT', reason, price: indicators.price })
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
        reason: `broker 送信エラー: ${messageOf(error)}`,
        price: indicators.price,
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

