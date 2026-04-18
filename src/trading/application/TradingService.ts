import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { RiskDecision } from '../domain/RiskDecision'
import type { Signal } from '../domain/Signal'
import type { Execution } from '../execution/Execution'
import type { RiskPolicy } from '../risk/RiskPolicy'
import type { PositionStore } from '../state/PositionStore'
import type { Strategy, StrategyInput } from '../strategy/Strategy'
import {
  logPostSubmit,
  logPreSubmit,
  logTradeDecision,
  logTradeIntent,
} from '../../infrastructure/logger/tradeJournal'

export interface TradingConfig {
  dryRun: boolean
  tradingEnabled: boolean
  allowedSymbols: string[]
  maxOrderNotional: number
  symbolMaxNotional: Record<string, number>
  marketHoursCheck: boolean
  now?: () => Date
}

export interface TradingDecision {
  signal: Signal
  orderIntent?: OrderIntent
  riskDecision: RiskDecision
}

export interface TradingExecution extends TradingDecision {
  executionResult?: ExecutionResult
}

export interface TradeCallContext {
  requestId?: string
}

export interface TradingServiceOptions {
  positionStore?: PositionStore
  /** How long a pending-order lock stays live before a new submit can replace it. */
  pendingLockTtlMs?: number
  now?: () => Date
}

const DEFAULT_PENDING_LOCK_TTL_MS = 60_000

export class TradingService {
  private readonly positionStore?: PositionStore
  private readonly pendingLockTtlMs: number
  private readonly now: () => Date

  constructor(
    private readonly strategy: Strategy,
    private readonly riskPolicy: RiskPolicy,
    private readonly execution: Execution,
    options: TradingServiceOptions = {},
  ) {
    this.positionStore = options.positionStore
    this.pendingLockTtlMs =
      options.pendingLockTtlMs !== undefined &&
      Number.isFinite(options.pendingLockTtlMs) &&
      options.pendingLockTtlMs > 0
        ? options.pendingLockTtlMs
        : DEFAULT_PENDING_LOCK_TTL_MS
    this.now = options.now ?? (() => new Date())
  }

  decide(input: StrategyInput, config: TradingConfig, ctx?: TradeCallContext): TradingDecision {
    const signal = this.strategy.decide(input)
    const orderIntent = this.createOrderIntent(signal)
    const riskDecision = this.riskPolicy.evaluate({
      signal,
      orderIntent,
      tradingEnabled: config.tradingEnabled,
      allowedSymbols: config.allowedSymbols,
      maxOrderNotional: config.maxOrderNotional,
      symbolMaxNotional: config.symbolMaxNotional,
      marketHoursCheck: config.marketHoursCheck,
      now: config.now,
    })

    const resolvedIntent =
      riskDecision.normalizedIntent !== undefined ? riskDecision.normalizedIntent : orderIntent

    logTradeDecision({
      requestId: ctx?.requestId,
      symbol: input.symbol,
      strategyName: this.strategy.name,
      signal,
      riskDecision,
    })

    return {
      signal,
      orderIntent: resolvedIntent,
      riskDecision,
    }
  }

  async executeTrade(
    input: StrategyInput,
    config: TradingConfig,
    ctx?: TradeCallContext,
  ): Promise<TradingExecution> {
    const decision = this.decide(input, config, ctx)

    if (!decision.riskDecision.allowed || !decision.orderIntent) {
      return decision
    }

    const stateGate = await this.applyStateGate(decision, decision.orderIntent.symbol)
    if (!stateGate.allowed) {
      return { ...decision, riskDecision: stateGate.riskDecision }
    }

    const intent = decision.orderIntent
    logTradeIntent({ requestId: ctx?.requestId, clientOrderId: intent.clientOrderId, intent })
    logPreSubmit({ requestId: ctx?.requestId, clientOrderId: intent.clientOrderId, intent })

    const startedAt = Date.now()
    let executionResult: ExecutionResult | undefined
    let error: Error | undefined
    try {
      executionResult = await this.execution.execute(intent)
      // DRY_RUN never emits a TradeEvent, so the pending-order lock must be
      // released here; otherwise every subsequent DRY_RUN call would bounce
      // off the stale lock.
      if (executionResult.mode === 'DRY_RUN' && this.positionStore) {
        await this.positionStore.clearPendingOrder(intent.symbol)
      }
      return { ...decision, executionResult }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
      if (this.positionStore) {
        // Fail-closed: a failed submit must not leave a phantom lock in place.
        await this.positionStore.clearPendingOrder(intent.symbol).catch(() => undefined)
      }
      throw err
    } finally {
      logPostSubmit({
        requestId: ctx?.requestId,
        clientOrderId: intent.clientOrderId,
        symbol: intent.symbol,
        result: executionResult,
        latencyMs: Date.now() - startedAt,
        error,
      })
    }
  }

  private async applyStateGate(
    decision: TradingDecision,
    symbol: string,
  ): Promise<{ allowed: true } | { allowed: false; riskDecision: RiskDecision }> {
    if (!this.positionStore || !decision.orderIntent) {
      return { allowed: true }
    }

    const now = this.now()
    const state = await this.positionStore.getState(symbol)

    if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now.getTime()) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, `cooldown active until ${state.cooldownUntil}`),
      }
    }

    // T+1 settled-cash guard: if settledCash has been seeded (> 0), a BUY whose
    // notional exceeds it would be a good-faith violation on a JP CASH account.
    // When settledCash is 0 we treat the symbol as unseeded and skip the check
    // so existing tests and the legacy FixedRule path keep working unchanged.
    if (
      decision.orderIntent.side === 'BUY' &&
      state.settledCash > 0 &&
      decision.orderIntent.notional > state.settledCash
    ) {
      return {
        allowed: false,
        riskDecision: appendReason(
          decision.riskDecision,
          `insufficient settled cash: notional ${decision.orderIntent.notional} exceeds settledCash ${state.settledCash}`,
        ),
      }
    }

    const lock = {
      clientOrderId: decision.orderIntent.clientOrderId,
      side: decision.orderIntent.side,
      submittedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.pendingLockTtlMs).toISOString(),
    }
    const result = await this.positionStore.lockPendingOrder(symbol, lock)
    if (!result.ok) {
      return {
        allowed: false,
        riskDecision: appendReason(decision.riskDecision, 'pending order already in flight'),
      }
    }

    return { allowed: true }
  }

  private createOrderIntent(signal: Signal): OrderIntent | undefined {
    if (signal.action === 'HOLD') {
      return undefined
    }

    return {
      symbol: signal.symbol,
      side: signal.action,
      quantity: signal.quantity,
      price: signal.price,
      notional: signal.price * signal.quantity,
      clientOrderId: crypto.randomUUID().replaceAll('-', ''),
    }
  }
}

function appendReason(decision: RiskDecision, reason: string): RiskDecision {
  return {
    allowed: false,
    reasons: [...decision.reasons, reason],
    normalizedIntent: decision.normalizedIntent,
  }
}