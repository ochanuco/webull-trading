import {
  createWebullHttpClient,
  type WebullClientEnv,
  type WebullHttpClient,
} from './WebullHttpClient'
import type {
  WebullAccountBalanceDto,
  WebullAccountDto,
  WebullOrderDetailDto,
  WebullPositionDto,
  WebullSubscriptionDto,
} from './dto'

/**
 * Read-only facade over {@link WebullHttpClient}; `placeOrder` is deliberately
 * not exposed here so read-path code cannot call it by accident — Webull JP's
 * 1-user-1-app constraint means staging and prod share one API key, so this
 * gate has to hold at the type level, not just by runtime convention.
 */
export class WebullReadClient {
  constructor(private readonly http: WebullHttpClient) {}

  listSubscriptions(): Promise<WebullSubscriptionDto[]> {
    return this.http.listSubscriptions()
  }

  getAccount(): Promise<WebullAccountDto> {
    return this.http.getAccount()
  }

  getAccountBalance(): Promise<WebullAccountBalanceDto> {
    return this.http.getAccountBalance()
  }

  findOrderByClientId(
    clientOrderId: string,
    opts?: { maxPages?: number; pageSize?: number },
  ): Promise<WebullOrderDetailDto | undefined> {
    return this.http.findOrderByClientId(clientOrderId, opts)
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
