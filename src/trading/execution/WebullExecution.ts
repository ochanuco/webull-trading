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
  // #21: `WebullTradeClient` 経由でしか trade API に触れない。staging からの
  // 誤発注は client constructor で disable されているため、ここに来た時点で
  // production deploy + ENVIRONMENT=production の不変条件が満たされている。
  // 旧 `Pick<WebullHttpClient, 'placeOrder'>` 時代の narrowing は削除済 — 今は
  // WebullTradeClient 自体が placeOrder + isLiveTradingEnabled のみ持つ薄い
  // facade なので Pick で絞る意味がない (#21 Phase B 後 cleanup)。
  constructor(private readonly client: WebullTradeClient) {}

  async execute(intent: OrderIntent): Promise<ExecutionResult> {
    try {
      const response = await this.client.placeOrder(intent)
      return toExecutionResult(response)
    } catch (error) {
      // Preserve the upstream broker error when it's already a
      // BrokerRequestError (status + class). Rethrow as-is so callers see
      // the real 4xx/5xx status classification from brokerErrorForStatus.
      // TradeDisabledError は broker に到達してない (= ENVIRONMENT gate で止めた)
      // 状態を表すので、broker error として log に乗ると "broker rejected" と誤読
      // される。原クラスのまま再送出して両者を分離する。
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
