import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'
import type { Execution } from './Execution'

export class MockExecution implements Execution {
  async execute(_intent: OrderIntent): Promise<ExecutionResult> {
    return {
      mode: 'DRY_RUN',
      submitted: true,
      brokerOrderId: `mock-${crypto.randomUUID()}`,
    }
  }
}
