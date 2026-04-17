import { toExecutionResult } from '../../infrastructure/webull/mapper'
import type { WebullHttpClient } from '../../infrastructure/webull/WebullHttpClient'
import { BrokerRequestError } from '../../shared/errors'
import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { Execution } from './Execution'

export class WebullExecution implements Execution {
  constructor(private readonly client: Pick<WebullHttpClient, 'placeOrder'>) {}

  async execute(intent: OrderIntent): Promise<ExecutionResult> {
    try {
      const response = await this.client.placeOrder(intent)
      return toExecutionResult(response)
    } catch (error) {
      throw new BrokerRequestError('Webull order placement failed', 'placeOrder', { cause: error })
    }
  }
}
