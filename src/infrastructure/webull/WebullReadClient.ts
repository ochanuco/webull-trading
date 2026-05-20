import {
  createWebullHttpClient,
  type WebullClientEnv,
  type WebullHttpClient,
} from './WebullHttpClient'
import type {
  WebullAccountDto,
  WebullOrderDetailDto,
  WebullPositionDto,
  WebullSubscriptionDto,
} from './dto'

/**
 * Read-only facade over {@link WebullHttpClient} (#21)。trade API への access を
 * `WebullTradeClient` に一本化する設計の片割れで、こちらは副作用のない GET 系
 * (positions / orders history / account profile / subscriptions) のみを expose。
 * `placeOrder` は型レベルで触れない (= read 用途のコードが誤って write を呼ぶ
 * 事故を防ぐ。Webull JP の 1 user = 1 app 制約で staging/prod が同じ API key を
 * 共有するため、コード側の type system で write を gate する)。
 */
export class WebullReadClient {
  constructor(private readonly http: WebullHttpClient) {}

  listSubscriptions(): Promise<WebullSubscriptionDto[]> {
    return this.http.listSubscriptions()
  }

  getAccount(): Promise<WebullAccountDto> {
    return this.http.getAccount()
  }

  findOrderByClientId(
    clientOrderId: string,
    pageSize?: number,
  ): Promise<WebullOrderDetailDto | undefined> {
    return this.http.findOrderByClientId(clientOrderId, pageSize)
  }

  getPositions(): Promise<WebullPositionDto[]> {
    return this.http.getPositions()
  }

  getAvailableQtyForSymbol(symbol: string): Promise<number | null> {
    return this.http.getAvailableQtyForSymbol(symbol)
  }
}

export function createWebullReadClient(
  env: WebullClientEnv,
  options?: Parameters<typeof createWebullHttpClient>[1],
): WebullReadClient {
  return new WebullReadClient(createWebullHttpClient(env, options))
}
