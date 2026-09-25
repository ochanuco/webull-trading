import { toExecutionResult } from '../../infrastructure/webull/mapper'
import {
  TradeDisabledError,
  type WebullTradeClient,
} from '../../infrastructure/webull/WebullTradeClient'
import { BrokerRequestError } from '../../shared/errors'
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { Execution } from './Execution'

export class WebullExecution implements Execution {
  // No environment guard here: WebullTradeClient.placeOrder itself throws
  // TradeDisabledError when ENVIRONMENT !== 'production'.
  constructor(private readonly client: WebullTradeClient) {}

  async execute(intent: OrderIntent): Promise<ExecutionResult> {
    try {
      const response = await this.client.placeOrder(intent)
      return toExecutionResult(response)
    } catch (error) {
      // Rethrow unchanged: wrapping TradeDisabledError would make a gate
      // stop (order never reached the broker) look like a broker rejection.
      if (error instanceof BrokerRequestError || error instanceof TradeDisabledError) {
        throw error
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new BrokerRequestError(
        `Webull order placement failed: ${detail}`,
        'placeOrder',
        { cause: error instanceof Error ? error : undefined },
      )
    }
  }
}
