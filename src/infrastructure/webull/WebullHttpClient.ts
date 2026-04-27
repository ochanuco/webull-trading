import type { OrderIntent } from '../../trading/domain/OrderIntent'
import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import type {
  WebullAccountDto,
  WebullOrderDetailDto,
  WebullPlaceOrderResponseDto,
  WebullPositionDto,
  WebullSubscriptionDto,
} from './dto'
import { toWebullPlaceOrderRequest } from './mapper'
import { WebullAuth } from './WebullAuth'

export interface WebullClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_API_BASE?: string
  /**
   * JP CASH account ID. On the Webull JP tenant this is a multi-currency
   * cash account that holds BOTH JPY and USD positions (the probe confirmed
   * pre-existing AAPL / NVDA / MSFT positions alongside 1570 / 7011), so
   * every order — US and JP — routes here. The US_MARGIN account was
   * dropped because leveraged ETFs (SOXL / SOXS) are rejected with
   * SECURITY_NOT_SUPPORT_MARGIN_TRADE regardless of margin_type, and we
   * have no intent to run margin-leveraged trades from this POC.
   */
  WEBULL_ACCOUNT_ID_JP_CASH?: string
}

interface WebullRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  multiplier?: number
  jitter?: number
}

interface WebullHttpClientOptions {
  auth: WebullAuth
  /** JP CASH account id — required. Receives every order (US + JP). */
  accountId?: string
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
  private readonly accountId: string | undefined

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
    this.accountId = options.accountId
  }

  async listSubscriptions(): Promise<WebullSubscriptionDto[]> {
    return this.request<WebullSubscriptionDto[]>('GET', '/app/subscriptions/list')
  }

  async getAccount(): Promise<WebullAccountDto> {
    return this.request<WebullAccountDto>('GET', '/account/profile', {
      query: { account_id: this.requireAccountId() },
    })
  }

  /**
   * Fetch the current status of a previously-placed order by its client-side
   * idempotency key.
   *
   * `/openapi/account/orders/detail` returns 404 on the JP UAT tenant, so we
   * fetch the first page of `/openapi/account/orders/history` and filter
   * client-side. If the order is older than that window the caller gets
   * `undefined`; a wider pagination sweep is out of scope for the MVP.
   */
  async findOrderByClientId(
    clientOrderId: string,
    pageSize = 50,
  ): Promise<WebullOrderDetailDto | undefined> {
    const page = await this.request<WebullOrderDetailDto[]>(
      'GET',
      '/openapi/account/orders/history',
      {
        query: { account_id: this.requireAccountId(), page_size: String(pageSize) },
      },
    )
    return page.find((entry) => entry.client_order_id === clientOrderId)
  }

  /**
   * Fetch the account's open positions. Used by the SELL_QTY_EXCEED fallback
   * in the cron path: when Webull rejects a SELL because the requested qty
   * is greater than `quantity_available` (e.g. DO state drifted above broker
   * truth), the scheduler re-fetches available qty here and retries the
   * SELL with the broker-side ground truth.
   *
   * TODO(#21): the live UAT endpoint name is not yet confirmed — using
   * `/openapi/account/positions/get` based on Webull OpenAPI naming
   * conventions. Update once the live response shape is verified.
   */
  async getPositions(): Promise<WebullPositionDto[]> {
    return this.request<WebullPositionDto[]>('GET', '/openapi/account/positions/get', {
      query: { account_id: this.requireAccountId() },
    })
  }

  async placeOrder(intent: OrderIntent): Promise<WebullPlaceOrderResponseDto> {
    // Single CASH account handles both US and JP (multi-currency cash
    // account). v2 endpoint — JP UAT rejects the v1 `/trade/order/place`
    // body shape with ILLEGAL_PARAMETER.
    return this.request<WebullPlaceOrderResponseDto>('POST', '/openapi/account/orders/place', {
      query: { account_id: this.requireAccountId() },
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
    let lastBody: string | undefined

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

      // Capture response body for error diagnostics. Webull typically returns
      // `{ code: "...", message: "..." }` JSON on errors, but some failures
      // come from upstream CDN / proxies as HTML or plain text (502 etc.), so
      // use `text()` rather than `json()` to keep the raw body either way.
      // Truncate to avoid memory blowup on huge HTML error pages.
      const bodyText = await readErrorBody(response)

      lastStatus = response.status
      lastBody = bodyText
      lastFailure = new Error(
        `Webull request failed with status ${response.status}: ${bodyText}`,
      )

      if (response.status >= 400 && response.status < 500) {
        // 4xx is the caller's fault or an auth/rate-limit problem — do not
        // retry. Map to the narrowest error subclass so downstream handlers
        // can treat 401/429 differently from 400. Include the response body
        // in the surfaced message so logs show why Webull rejected the
        // request (e.g. 417 with `ORDER_INVALID_QTY`) and so callers can
        // detect Webull-specific error codes like
        // `OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY` (used by the SELL
        // fallback in pullbackScheduler) by string-matching on the message.
        throw brokerErrorForStatus(
          response.status,
          `Webull request failed permanently with status ${response.status}: ${bodyText}`,
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
      // Retries exhausted on a 5xx. Surface as a server-class error so alerts
      // can distinguish "Webull is down" from "we sent a bad request". Include
      // the last response body so the log explains *why* the upstream gave up.
      throw brokerErrorForStatus(
        lastStatus,
        `Webull request failed after ${this.retry.maxAttempts} attempts with last status ${lastStatus}: ${lastBody ?? '<no body>'}`,
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

  private requireAccountId(): string {
    if (!this.accountId) {
      throw new BrokerRequestError(
        'Missing Webull account ID: set WEBULL_ACCOUNT_ID_JP_CASH',
        'webullAccountId',
      )
    }
    return this.accountId
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
    accountId: env.WEBULL_ACCOUNT_ID_JP_CASH,
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

/**
 * Read an upstream error response body for diagnostics. Use `text()` rather
 * than `json()` because non-JSON bodies are common (CDN HTML 502 pages, plain
 * text proxy errors). The body is truncated to keep log lines bounded — the
 * Webull error envelope `{code, message}` is well within this limit, and any
 * larger blob is most likely an HTML error page that is not worth keeping in
 * full.
 */
const ERROR_BODY_MAX_CHARS = 1000

async function readErrorBody(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return '<failed to read body>'
  }
  if (text.length === 0) {
    return '<empty body>'
  }
  if (text.length > ERROR_BODY_MAX_CHARS) {
    return `${text.slice(0, ERROR_BODY_MAX_CHARS)}...[truncated]`
  }
  return text
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