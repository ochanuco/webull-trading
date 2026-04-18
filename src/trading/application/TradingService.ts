import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { RiskDecision } from '../domain/RiskDecision'
import type { Signal } from '../domain/Signal'
import type { Execution } from '../execution/Execution'
import type { RiskPolicy } from '../risk/RiskPolicy'
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

export class TradingService {
  constructor(
    private readonly strategy: Strategy,
    private readonly riskPolicy: RiskPolicy,
    private readonly execution: Execution,
  ) {}

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

    const intent = decision.orderIntent
    logTradeIntent({ requestId: ctx?.requestId, clientOrderId: intent.clientOrderId, intent })
    logPreSubmit({ requestId: ctx?.requestId, clientOrderId: intent.clientOrderId, intent })

    const startedAt = Date.now()
    let executionResult: ExecutionResult | undefined
    let error: Error | undefined
    try {
      executionResult = await this.execution.execute(intent)
      return { ...decision, executionResult }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))
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
