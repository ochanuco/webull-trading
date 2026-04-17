export type ExecutionMode = 'DRY_RUN' | 'LIVE'

export interface ExecutionResult {
  mode: ExecutionMode
  submitted: boolean
  brokerOrderId?: string
  errorReason?: string
}