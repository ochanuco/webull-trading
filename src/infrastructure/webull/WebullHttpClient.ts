import type { OrderIntent } from '../../trading/domain/OrderIntent'
import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import type {
  WebullAccountBalanceDto,
  WebullAccountDto,
  WebullOrderDetailDto,
  WebullOrderHistoryWrapperDto,
  WebullPlaceOrderResponseDto,
  WebullPositionDto,
  WebullSubscriptionDto,
} from './dto'
import { toWebullPlaceOrderRequest, type PlaceOrderSchemaVersion } from './mapper'
import { WebullAuth } from './WebullAuth'

export interface WebullClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  /**
   * Trade API host. JP prod: `api.webull.co.jp`. JP UAT (one ALB fronting
   * trade/quotes/events): `jp-openapi-alb.uat.webullbroker.com`. Falls back
   * to `DEFAULT_TRADE_API_BASE` when unset/blank.
   */
  WEBULL_TRADE_API_BASE?: string
  /** x-access-token issued via 2FA; emitted as a header only, never part of the signature. */
  WEBULL_ACCESS_TOKEN?: string
  /**
   * JP CASH account ID — a multi-currency cash account holding both JPY and
   * USD positions, so every order (US and JP) routes here. US_MARGIN was
   * rejected: leveraged ETFs (SOXL/SOXS) get SECURITY_NOT_SUPPORT_MARGIN_TRADE
   * on it regardless of margin_type, and this POC runs no margin trades.
   */
  WEBULL_ACCOUNT_ID_JP_CASH?: string
  /**
   * Path override for staged migration to the new OpenAPI routes:
   *   /openapi/account/positions      → /openapi/assets/positions
   *   /openapi/account/orders/history → /openapi/trade/order/history
   *   /openapi/account/orders/place   → /openapi/trade/order/place
   * Both old and new paths return 200; default stays on the old path.
   */
  WEBULL_PATH_POSITIONS?: string
  WEBULL_PATH_ORDERS_HISTORY?: string
  WEBULL_PATH_ORDERS_PLACE?: string
  /** Account Balance path override; default `/openapi/account/balance` (v1). */
  WEBULL_PATH_ACCOUNT_BALANCE?: string
  /**
   * x-version sent to trade/account routes. Both old and new paths accept
   * v1 (default); 'v2' is opt-in. Invalid/unset values fall back to 'v1'.
   */
  WEBULL_TRADE_VERSION?: string
  /** Place Order body schema: 'v1' (default) or 'v2'. Invalid values fall back to 'v1'. */
  WEBULL_PLACE_ORDER_SCHEMA?: string
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
  baseUrl: string
  timeoutMs?: number
  retry?: WebullRetryOptions
  fetchFn?: typeof fetch
  /** Endpoint path overrides for staged migration to the new OpenAPI routes; default is the old path. */
  positionsPath?: string
  ordersHistoryPath?: string
  ordersPlacePath?: string
  /** Default v1 `/openapi/account/balance`; pair with tradeVersion='v2' to point at `/openapi/assets/balance` (same shape). */
  accountBalancePath?: string
  /** x-version for trade/account routes. Both old and new paths accept v1; 'v2' is opt-in. */
  tradeVersion?: string
  /** See {@link PlaceOrderSchemaVersion} for the v1/v2 body differences. */
  placeOrderSchema?: PlaceOrderSchemaVersion
}

const DEFAULT_POSITIONS_PATH = '/openapi/account/positions'
const DEFAULT_ORDERS_HISTORY_PATH = '/openapi/account/orders/history'
const DEFAULT_ORDERS_PLACE_PATH = '/openapi/account/orders/place'
const DEFAULT_ACCOUNT_BALANCE_PATH = '/openapi/account/balance'
const DEFAULT_TRADE_VERSION = 'v1'
const DEFAULT_PLACE_ORDER_SCHEMA: PlaceOrderSchemaVersion = 'v1'
/**
 * JP production trade host — public per the SDK's region config
 * (webull-openapi-python-sdk `endpoints.json`, region=jp). UAT's host isn't
 * public, so it's env-overridden via `WEBULL_TRADE_API_BASE` instead.
 */
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'

export class WebullHttpClient {
  private readonly baseUrl: string
  private readonly host: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly retry: Required<WebullRetryOptions>
  private readonly accountId: string | undefined
  private readonly positionsPath: string
  private readonly ordersHistoryPath: string
  private readonly ordersPlacePath: string
  private readonly accountBalancePath: string
  private readonly tradeVersion: string
  private readonly placeOrderSchema: PlaceOrderSchemaVersion

  constructor(private readonly options: WebullHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.host = new URL(this.baseUrl).host
    this.timeoutMs = options.timeoutMs ?? 5000
    // Unbound global fetch throws "Illegal invocation" in Workers.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.retry = {
      maxAttempts: options.retry?.maxAttempts ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 200,
      multiplier: options.retry?.multiplier ?? 2,
      jitter: options.retry?.jitter ?? 0.25,
    }
    this.accountId = options.accountId
    this.positionsPath = options.positionsPath ?? DEFAULT_POSITIONS_PATH
    this.ordersHistoryPath = options.ordersHistoryPath ?? DEFAULT_ORDERS_HISTORY_PATH
    this.ordersPlacePath = options.ordersPlacePath ?? DEFAULT_ORDERS_PLACE_PATH
    this.accountBalancePath = options.accountBalancePath ?? DEFAULT_ACCOUNT_BALANCE_PATH
    this.tradeVersion = options.tradeVersion ?? DEFAULT_TRADE_VERSION
    this.placeOrderSchema = options.placeOrderSchema ?? DEFAULT_PLACE_ORDER_SCHEMA
  }

  async listSubscriptions(): Promise<WebullSubscriptionDto[]> {
    return this.request<WebullSubscriptionDto[]>('GET', '/app/subscriptions/list')
  }

  async getAccount(): Promise<WebullAccountDto> {
    return this.request<WebullAccountDto>('GET', '/account/profile', {
      query: { account_id: this.requireAccountId() },
    })
  }

  /** `account_currency_assets[]` carries buying_power per currency; used by the pre-trade gate. */
  async getAccountBalance(): Promise<WebullAccountBalanceDto> {
    return this.request<WebullAccountBalanceDto>('GET', this.accountBalancePath, {
      query: { account_id: this.requireAccountId() },
    })
  }

  /**
   * Finds a previously-placed order by its client-side idempotency key.
   * `/openapi/account/orders/detail` 404s on the JP UAT tenant, so this
   * sweeps `/openapi/account/orders/history` instead and filters
   * client-side. Normalizes both the legacy flat shape and the newer
   * `{orders: [...]}` wrapper via {@link normalizeOrderHistoryRow}.
   */
  async findOrderByClientId(
    clientOrderId: string,
    opts: { maxPages?: number; pageSize?: number } = {},
  ): Promise<WebullOrderDetailDto | undefined> {
    const pageSize = opts.pageSize ?? 50
    const maxPages = Math.max(1, opts.maxPages ?? 1)
    const accountId = this.requireAccountId()
    for (let page = 1; page <= maxPages; page += 1) {
      const rows = await this.request<unknown[]>(
        'GET',
        this.ordersHistoryPath,
        {
          query: {
            account_id: accountId,
            page_size: String(pageSize),
            page: String(page),
          },
        },
      )
      if (!Array.isArray(rows)) return undefined
      for (const raw of rows) {
        const normalized = normalizeOrderHistoryRow(
          raw as WebullOrderHistoryWrapperDto | WebullOrderDetailDto,
        )
        if (normalized.client_order_id === clientOrderId) return normalized
      }
      // Short page means we've hit the tail of broker history — stop instead
      // of paying for a request we know won't match.
      if (rows.length < pageSize) return undefined
    }
    return undefined
  }

  /**
   * Powers the SELL_QTY_EXCEED fallback: when Webull rejects a SELL because
   * the requested qty exceeds `available_quantity` (e.g. DO state drifted
   * above broker truth), the scheduler re-fetches here and retries against
   * broker-side ground truth.
   */
  async getPositions(): Promise<WebullPositionDto[]> {
    return this.request<WebullPositionDto[]>('GET', this.positionsPath, {
      query: { account_id: this.requireAccountId() },
    })
  }

  /**
   * Resolves broker-side `available_quantity` for a symbol, keeping the DTO
   * interpretation (case-insensitive match, string→number parsing) inside
   * the infrastructure layer so callers only see `number | null`.
   */
  async getAvailableQtyForSymbol(symbol: string): Promise<number | null> {
    const target = symbol.toUpperCase()
    const positions = await this.getPositions()
    const match = positions.find((p) => (p.symbol ?? '').toUpperCase() === target)
    if (!match) return null
    const raw = match.available_quantity
    if (raw === undefined || raw === null || raw === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  async placeOrder(intent: OrderIntent): Promise<WebullPlaceOrderResponseDto> {
    // v2 moves account_id into the body (new docs); v1 keeps it in the query.
    const accountId = this.requireAccountId()
    const body = toWebullPlaceOrderRequest(intent, this.placeOrderSchema, accountId)
    const query: Record<string, string> =
      this.placeOrderSchema === 'v2' ? {} : { account_id: accountId }
    return this.request<WebullPlaceOrderResponseDto>('POST', this.ordersPlacePath, {
      query,
      body,
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
        // Both old and new OpenAPI routes accept v1; v2 is opt-in via WEBULL_TRADE_VERSION.
        version: this.tradeVersion,
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

      const bodyText = await readErrorBody(response)

      lastStatus = response.status
      lastBody = bodyText
      lastFailure = new Error(
        `Webull request failed with status ${response.status}: ${bodyText}`,
      )

      if (response.status >= 400 && response.status < 500) {
        // Not retried — caller/auth/rate-limit fault. The body stays in the
        // message so callers can string-match broker codes like
        // OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY (used by the SELL fallback).
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
      // Server-class error after exhausting retries — lets alerts distinguish
      // "Webull is down" from a bad request; body explains why it gave up.
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
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    retry?: WebullRetryOptions
    /** Runtime-resolved token (from resolveAccessToken); overrides env.WEBULL_ACCESS_TOKEN when provided. */
    accessToken?: string
  },
): WebullHttpClient {
  // Overrides must be absolute paths starting with '/' — otherwise a caller
  // could smuggle a full URL and bypass WEBULL_TRADE_API_BASE entirely.
  const trim = (v: string | undefined): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (t.length === 0) return undefined
    if (!t.startsWith('/')) return undefined
    return t
  }
  // Strict allow-list: an arbitrary value here breaks broker auth signing.
  const validateVersion = (v: string | undefined): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (t === 'v1' || t === 'v2') return t
    return undefined
  }
  // Strict allow-list: an arbitrary value here sends a broken body schema and corrupts the order.
  const validateOrderSchema = (v: string | undefined): PlaceOrderSchemaVersion | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (t === 'v1' || t === 'v2') return t
    return undefined
  }
  const baseUrl = env.WEBULL_TRADE_API_BASE?.trim() || DEFAULT_TRADE_API_BASE
  return new WebullHttpClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
      accessToken: options?.accessToken ?? env.WEBULL_ACCESS_TOKEN,
    }),
    accountId: env.WEBULL_ACCOUNT_ID_JP_CASH,
    baseUrl,
    timeoutMs: options?.timeoutMs,
    retry: options?.retry,
    fetchFn: options?.fetchFn,
    positionsPath: trim(env.WEBULL_PATH_POSITIONS),
    ordersHistoryPath: trim(env.WEBULL_PATH_ORDERS_HISTORY),
    ordersPlacePath: trim(env.WEBULL_PATH_ORDERS_PLACE),
    accountBalancePath: trim(env.WEBULL_PATH_ACCOUNT_BALANCE),
    tradeVersion: validateVersion(env.WEBULL_TRADE_VERSION),
    placeOrderSchema: validateOrderSchema(env.WEBULL_PLACE_ORDER_SCHEMA),
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
 * Reads the error body as text, not JSON — Webull errors are usually
 * `{code, message}` JSON, but upstream CDN/proxy failures can return HTML or
 * plain text. Truncated so a large HTML error page doesn't blow up the log line.
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

/**
 * Normalizes both the legacy flat order-history shape and the newer
 * `{client_order_id, combo_type, orders: [...]}` wrapper into the flat DTO
 * callers expect. Combo/multi-leg orders are out of scope, so only
 * `orders[0]` is used. Empty/missing `orders[]` returns `{}` rather than a
 * partial row (client_order_id only) — a partial row would false-match in
 * findOrderByClientId's coid comparison.
 */
function normalizeOrderHistoryRow(
  raw: WebullOrderHistoryWrapperDto | WebullOrderDetailDto,
): WebullOrderDetailDto {
  if (raw === null || typeof raw !== 'object') return {} as WebullOrderDetailDto
  const wrapper = raw as WebullOrderHistoryWrapperDto
  if (!Array.isArray(wrapper.orders)) {
    return raw as WebullOrderDetailDto
  }
  const inner = wrapper.orders[0]
  if (inner === undefined || inner === null) {
    return {} as WebullOrderDetailDto
  }
  const clientOrderId = wrapper.client_order_id ?? inner.client_order_id
  // New API uses total_quantity; callers read quantity, so alias it.
  const quantity = inner.quantity ?? inner.total_quantity
  return {
    ...inner,
    client_order_id: clientOrderId,
    quantity,
    total_quantity: inner.total_quantity,
  }
}