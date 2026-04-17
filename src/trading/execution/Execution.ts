import type { ExecutionResult } from '../domain/ExecutionResult'
import type { OrderIntent } from '../domain/OrderIntent'

export interface Execution {
  execute(intent: OrderIntent): Promise<ExecutionResult>
}
