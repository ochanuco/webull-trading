import { toExecutionResult } from '../../infrastructure/webull/mapper'
import type { WebullTradeClient } from '../../infrastructure/webull/WebullTradeClient'
import { BrokerRequestError } from '../../shared/errors'
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { Execution } from './Execution'

export class WebullExecution implements Execution {
  // #21: `WebullTradeClient` 経由でしか trade API に触れない。staging からの
  // 誤発注は client constructor で disable されているため、ここに来た時点で
  // production deploy + ENVIRONMENT=production の不変条件が満たされている。
  constructor(private readonly client: Pick<WebullTradeClient, 'placeOrder'>) {}

  async execute(intent: OrderIntent): Promise<ExecutionResult> {
    try {
      const response = await this.client.placeOrder(intent)
      return toExecutionResult(response)
    } catch (error) {
      // Preserve the upstream broker error when it's already a
      // BrokerRequestError (status + class). Rethrow as-is so callers see
      // the real 4xx/5xx status classification from brokerErrorForStatus.
      if (error instanceof BrokerRequestError) {
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
