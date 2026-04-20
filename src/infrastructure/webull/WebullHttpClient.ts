import type { OrderIntent } from '../../trading/domain/OrderIntent'
import { BrokerRequestError } from '../../shared/errors'
import type {
  WebullAccountDto,
  WebullMarket,
  WebullOrderDetailDto,
  WebullPlaceOrderResponseDto,
  WebullSubscriptionDto,
} from './dto'
import { inferWebullMarket, toWebullPlaceOrderRequest } from './mapper'
import { WebullAuth } from './WebullAuth'

export interface WebullClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_API_BASE?: string
  /**
   * Per-market account IDs. Webull issues separate accounts per market
   * (JP CASH for JP equities, US_MARGIN for US equities) and each order
   * must route through the matching one — a JPY account silently rejects
   * USD-denominated orders.
   */
  WEBULL_ACCOUNT_ID_JP_CASH?: string
  WEBULL_ACCOUNT_ID_US_MARGIN?: string
}

export interface WebullAccountIdMap {
  jp?: string
  us?: string
}

interface WebullRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  multiplier?: number
  jitter?: number
}

interface WebullHttpClientOptions {
  auth: WebullAuth
  /** Per-market account IDs. Supply at least one. */
  accountIds: WebullAccountIdMap
  baseUrl?: string
  timeoutMs?: number
  retry?: WebullRetryOptions
  fetchFn?: typeof fetch
}

export class WebullHttpClient {
  private readonly baseUrl: string
  private readonly host: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly retry: Required<WebullRetryOptions>
  private readonly accountIds: WebullAccountIdMap

  constructor(private readonly options: WebullHttpClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.sandbox.webull.hk').replace(/\/+$/, '')
    this.host = new URL(this.baseUrl).host
    this.timeoutMs = options.timeoutMs ?? 5000
    // Workers の global `fetch` はメソッド呼び出し扱いで `this` を globalThis
    // にひも付けないと "Illegal invocation" で落ちる。明示的に bind しておく。
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.retry = {
      maxAttempts: options.retry?.maxAttempts ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 200,
      multiplier: options.retry?.multiplier ?? 2,
      jitter: options.retry?.jitter ?? 0.25,
    }
    this.accountIds = options.accountIds
  }

  async listSubscriptions(): Promise<WebullSubscriptionDto[]> {
    return this.request<WebullSubscriptionDto[]>('GET', '/app/subscriptions/list')
  }

  async getAccount(): Promise<WebullAccountDto> {
    return this.request<WebullAccountDto>('GET', '/account/profile', {
      query: { account_id: this.requireAnyAccountId() },
    })
  }

  /**
   * Fetch the current status of a previously-placed order by its client-side
   * idempotency key.
   *
   * `/openapi/account/orders/detail` returns 404 on the JP UAT tenant our
   * `WEBULL_API_BASE` resolves to; `/openapi/account/orders/history` is the
   * only working lookup. It returns a paginated array — we fetch the first
   * page (default 10) and filter client-side. If the order is older than the
   * last page, the caller gets `undefined` and should fall back to a wider
   * pagination sweep (out of scope for the MVP admin endpoint).
   */
  async findOrderByClientId(
    clientOrderId: string,
    pageSize = 50,
  ): Promise<WebullOrderDetailDto | undefined> {
    // The order could have been placed against either account. Query every
    // configured account and return the first hit.
    const configured = this.configuredAccountIds()
    if (configured.length === 0) {
      // Mirror placeOrder / getAccount: surface misconfiguration loudly
      // rather than returning `undefined` (which would be indistinguishable
      // from "order not in the recent history window" at the call site).
      throw new BrokerRequestError(
        'Missing Webull account IDs: set WEBULL_ACCOUNT_ID_JP_CASH and/or WEBULL_ACCOUNT_ID_US_MARGIN',
        'webullAccountId',
      )
    }
    const pages = await Promise.all(
      configured.map((accountId) =>
        this.request<WebullOrderDetailDto[]>('GET', '/openapi/account/orders/history', {
          query: { account_id: accountId, page_size: String(pageSize) },
        }),
      ),
    )
    for (const page of pages) {
      const hit = page.find((entry) => entry.client_order_id === clientOrderId)
      if (hit) return hit
    }
    return undefined
  }

  async placeOrder(intent: OrderIntent): Promise<WebullPlaceOrderResponseDto> {
    // Route to the market-matching account. Placing a USD order on a JPY
    // CASH account results in silent rejection (#97).
    const market = inferWebullMarket(intent.symbol)
    // v2 endpoint. JP UAT / newer Webull deployments reject the v1
    // `/trade/order/place` + `stock_order` body with ILLEGAL_PARAMETER.
    return this.request<WebullPlaceOrderResponseDto>('POST', '/openapi/account/orders/place', {
      query: { account_id: this.requireAccountId(market) },
      body: toWebullPlaceOrderRequest(intent),
    })
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    {
      query,
      body,
    }: {
      query?: Record<string, string>
      body?: unknown
    } = {},
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const resolvedUrl = buildRequestUrl(this.baseUrl, path, query)
    let lastFailure: Error | undefined
    let lastStatus: number | undefined

    let authHeaders: Record<string, string>
    try {
      authHeaders = await this.options.auth.createHeaders({
        method,
        path: resolvedUrl.pathname,
        query,
        body: payload,
        host: resolvedUrl.host,
        // Webull SDK sets x-version=v1 for the documented trade/account routes.
        version: 'v1',
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull authentication failed: ${error instanceof Error ? error.message : String(error)}`,
        `${method} ${path}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      let response: Response | undefined

      try {
        const headers = {
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...authHeaders,
        }

        timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)

        response = await this.fetchFn(resolvedUrl.href, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        })
      } catch (error) {
        const normalizedError = normalizeFetchError(error, this.timeoutMs)
        lastFailure = normalizedError ?? undefined
        lastStatus = undefined // Clear stale status when no response is received

        if (normalizedError === null) {
          throw error
        }
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
        }
      }

      if (response === undefined) {
        if (attempt < this.retry.maxAttempts) {
          const delayMs = getRetryDelayMs({
            attempt,
            baseDelayMs: this.retry.baseDelayMs,
            multiplier: this.retry.multiplier,
            jitter: this.retry.jitter,
          })
          if (delayMs > 0) {
            await wait(delayMs)
          }
          continue
        }

        break
      }

      if (response.ok) {
        return (await response.json()) as T
      }

      lastStatus = response.status
      lastFailure = new Error(`Webull request failed with status ${response.status}`)

      if (response.status >= 400 && response.status < 500) {
        throw new BrokerRequestError(
          `Webull request failed permanently with status ${response.status}`,
          `${method} ${path}`,
          { cause: lastFailure },
        )
      }

      if (attempt < this.retry.maxAttempts) {
        const delayMs = getRetryDelayMs({
          attempt,
          baseDelayMs: this.retry.baseDelayMs,
          multiplier: this.retry.multiplier,
          jitter: this.retry.jitter,
        })
        if (delayMs > 0) {
          await wait(delayMs)
        }
      }
    }

    if (lastStatus !== undefined) {
      throw new BrokerRequestError(
        `Webull request failed after ${this.retry.maxAttempts} attempts with last status ${lastStatus}`,
        `${method} ${path}`,
        { cause: lastFailure },
      )
    }

    if (lastFailure) {
      throw new BrokerRequestError(
        `Webull request failed after ${this.retry.maxAttempts} attempts: ${lastFailure.message}`,
        `${method} ${path}`,
        { cause: lastFailure },
      )
    }

    throw new BrokerRequestError(
      `Webull request failed after ${this.retry.maxAttempts} attempts`,
      `${method} ${path}`,
    )
  }

  private requireAccountId(market: WebullMarket): string {
    const key: keyof WebullAccountIdMap = market === 'JP' ? 'jp' : 'us'
    const id = this.accountIds[key]
    if (!id) {
      throw new BrokerRequestError(`Missing Webull account ID for market=${market}`, 'webullAccountId')
    }
    return id
  }

  private requireAnyAccountId(): string {
    const id = this.accountIds.jp ?? this.accountIds.us
    if (!id) {
      throw new BrokerRequestError('Missing Webull account ID', 'webullAccountId')
    }
    return id
  }

  private configuredAccountIds(): string[] {
    return [this.accountIds.jp, this.accountIds.us].filter((x): x is string => !!x)
  }
}

export function createWebullHttpClient(
  env: WebullClientEnv,
  options?: { fetchFn?: typeof fetch; timeoutMs?: number; retry?: WebullRetryOptions },
): WebullHttpClient {
  return new WebullHttpClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
    }),
    accountIds: {
      jp: env.WEBULL_ACCOUNT_ID_JP_CASH,
      us: env.WEBULL_ACCOUNT_ID_US_MARGIN,
    },
    baseUrl: env.WEBULL_API_BASE,
    timeoutMs: options?.timeoutMs,
    retry: options?.retry,
    fetchFn: options?.fetchFn,
  })
}

function normalizeFetchError(error: unknown, timeoutMs: number): Error | null {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error(`Webull request timed out after ${timeoutMs}ms`)
  }

  return error instanceof Error ? error : null
}

function getRetryDelayMs({
  attempt,
  baseDelayMs,
  multiplier,
  jitter,
}: {
  attempt: number
  baseDelayMs: number
  multiplier: number
  jitter: number
}): number {
  const exponentialDelay = baseDelayMs * multiplier ** (attempt - 1)
  const jitterFactor = jitter <= 0 ? 1 : 1 + (Math.random() * 2 - 1) * jitter
  return Math.max(0, Math.round(exponentialDelay * jitterFactor))
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function buildRequestUrl(baseUrl: string, path: string, query?: Record<string, string>): URL {
  const url = new URL(path, `${baseUrl}/`)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }

  return url
}