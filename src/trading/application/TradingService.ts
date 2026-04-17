import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { RiskDecision } from '../domain/RiskDecision'
import type { Signal } from '../domain/Signal'
import type { Execution } from '../execution/Execution'
import type { RiskPolicy } from '../risk/RiskPolicy'
import type { Strategy, StrategyInput } from '../strategy/Strategy'

export interface TradingConfig {
  tradingEnabled: boolean
  allowedSymbols: string[]
  maxOrderNotional: number
}

export interface TradingDecision {
  signal: Signal
  orderIntent?: OrderIntent
  riskDecision: RiskDecision
}

export interface TradingExecution extends TradingDecision {
  executionResult?: ExecutionResult
}

export class TradingService {
  constructor(
    private readonly strategy: Strategy,
    private readonly riskPolicy: RiskPolicy,
    private readonly execution: Execution,
  ) {}

  decide(input: StrategyInput, config: TradingConfig): TradingDecision {
    const signal = this.strategy.decide(input)
    const orderIntent = this.createOrderIntent(signal)
    const riskDecision = this.riskPolicy.evaluate({
      signal,
      orderIntent,
      tradingEnabled: config.tradingEnabled,
      allowedSymbols: config.allowedSymbols,
      maxOrderNotional: config.maxOrderNotional,
    })

    return {
      signal,
      orderIntent: riskDecision.normalizedIntent,
      riskDecision,
    }
  }

  async executeTrade(input: StrategyInput, config: TradingConfig): Promise<TradingExecution> {
    const decision = this.decide(input, config)

    if (!decision.riskDecision.allowed || !decision.orderIntent) {
      return decision
    }

    const executionResult = await this.execution.execute(decision.orderIntent)

    return {
      ...decision,
      executionResult,
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
    }
  }
}
