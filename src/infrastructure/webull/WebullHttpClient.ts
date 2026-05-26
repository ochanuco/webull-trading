import type { OrderIntent } from '../../trading/domain/OrderIntent'
import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import type {
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
   * Webull **trade** API host (account / assets / orders)。JP 本番では
   * `api.webull.co.jp`、JP UAT では `jp-openapi-alb.uat.webullbroker.com`
   * (ALB が trade/quotes/events を 1 ホストに束ねる)。未設定 / 空 / whitespace
   * なら JP prod default (`DEFAULT_TRADE_API_BASE`) に fallback、env が
   * explicit にセットされてれば override (#21)。
   */
  WEBULL_TRADE_API_BASE?: string
  /**
   * 2FA 経由で発行された `x-access-token` 値 (#21)。設定時のみ `x-access-token`
   * ヘッダを emit、signature には含めない。未設定でも client 自体は作れる
   * (broker 側で 401 が出れば運用時に発覚する)。
   */
  WEBULL_ACCESS_TOKEN?: string
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
  /**
   * #257: trade/account endpoint path の env override。新 OpenAPI docs
   * (#251) で `/openapi/account/*` → `/openapi/assets/*` /
   * `/openapi/trade/order/*` への drift があり、staging で env を切替えて
   * 段階移行できるようにする。default は現行 path、未設定なら従来挙動。
   *
   * 旧 → 新の対応:
   *   /openapi/account/positions       → /openapi/assets/positions
   *   /openapi/account/orders/history  → /openapi/trade/order/history
   *   /openapi/account/orders/place    → /openapi/trade/order/place
   *
   * 旧/新ともに alias で 200 が返ることは probe で確認済 (PR #262)。
   */
  WEBULL_PATH_POSITIONS?: string
  WEBULL_PATH_ORDERS_HISTORY?: string
  WEBULL_PATH_ORDERS_PLACE?: string
  /**
   * #258: trade/account routes に送る x-version ヘッダ値。default 'v1'
   * (= 現行挙動)、'v2' に opt-in 可能。新 docs では v2 推奨だが旧/新 path
   * とも v1 alias が動いてるので staging で切替え試験できる。
   * 未設定 / 空 / whitespace のみ / 'v1'/'v2' 以外 → 'v1' fallback。
   */
  WEBULL_TRADE_VERSION?: string
  /**
   * #256: Place Order body schema version。'v1' (default / 現挙動) か 'v2'
   * (新 OpenAPI docs)。受理値は 'v1' / 'v2' のみ allow-list、それ以外は
   * 'v1' fallback。
   */
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
  /** #257: trade/account endpoint path overrides。default は旧 path。 */
  positionsPath?: string
  ordersHistoryPath?: string
  ordersPlacePath?: string
  /**
   * #258: trade/account routes に送る x-version ヘッダ値。default 'v1' (= 現行
   * 挙動)、env で 'v2' に opt-in 可能。新 OpenAPI docs では v2 必須化の方向だが
   * v1 でも alias 受理されてるので staging で env 切替えて検証する。
   */
  tradeVersion?: string
  /**
   * #256: Place Order body schema version。'v1' (default / 現挙動) か 'v2'
   * (新 OpenAPI docs)。v2 だと combo_type=NORMAL、session=CORE、
   * limit_price (MARKET) 省略、account_id を body 側へ移動する。
   */
  placeOrderSchema?: PlaceOrderSchemaVersion
}

const DEFAULT_POSITIONS_PATH = '/openapi/account/positions'
const DEFAULT_ORDERS_HISTORY_PATH = '/openapi/account/orders/history'
const DEFAULT_ORDERS_PLACE_PATH = '/openapi/account/orders/place'
const DEFAULT_TRADE_VERSION = 'v1'
const DEFAULT_PLACE_ORDER_SCHEMA: PlaceOrderSchemaVersion = 'v1'
/**
 * Webull JP **production** trade host (#21)。値は SDK の region 定義に書かれた
 * 公開情報なのでハードコード。UAT (`jp-openapi-alb.uat.webullbroker.com`) は
 * 非公開なので `WEBULL_TRADE_API_BASE` env で override する運用。
 * source: webull-openapi-python-sdk `webull/core/data/endpoints.json` region=jp。
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
  private readonly tradeVersion: string
  private readonly placeOrderSchema: PlaceOrderSchemaVersion

  constructor(private readonly options: WebullHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
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
    this.positionsPath = options.positionsPath ?? DEFAULT_POSITIONS_PATH
    this.ordersHistoryPath = options.ordersHistoryPath ?? DEFAULT_ORDERS_HISTORY_PATH
    this.ordersPlacePath = options.ordersPlacePath ?? DEFAULT_ORDERS_PLACE_PATH
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

  /**
   * Fetch the current status of a previously-placed order by its client-side
   * idempotency key.
   *
   * `/openapi/account/orders/detail` returns 404 on the JP UAT tenant, so we
   * sweep `/openapi/account/orders/history` and filter client-side. Default is
   * a single-page lookup (50 rows) to preserve cron-poll behaviour. Callers
   * that need deeper history (e.g. operator-driven deep lookup, reconcile
   * retry) can pass `{ maxPages: N }` for a bounded multi-page sweep — the
   * loop stops as soon as the target coid is found, the broker returns a
   * short page (less than `pageSize`), or `maxPages` has been visited (#139).
   *
   * Webull `/openapi/account/orders/history` accepts a 1-indexed `page` query
   * param. Pages are walked sequentially (1, 2, ...) so we do not re-query
   * page 1 if the caller wants `maxPages=2`. Iterating in serial keeps quota
   * usage proportional to need; with no docs on a server-side hard cap, the
   * caller is responsible for setting `maxPages` to a sane bound (default 1).
   *
   * 新 OpenAPI docs (#251) では response が wrapper 形式 (`{client_order_id,
   * combo_type, orders[]}`) に変わってる。\`normalizeOrderHistoryRow\` で
   * wrapper / flat 双方を flat な \`WebullOrderDetailDto\` に正規化するので
   * callers (reconcileFills 等) は signature を変えずに済む (#253)。
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
      // A short page means we have reached the tail of broker-side history —
      // there is nothing more to sweep, so stop early instead of paying the
      // cost of a final empty request that we know will not match.
      if (rows.length < pageSize) return undefined
    }
    return undefined
  }

  /**
   * Fetch the account's open positions. Used by the SELL_QTY_EXCEED fallback
   * in the cron path: when Webull rejects a SELL because the requested qty
   * is greater than `available_quantity` (e.g. DO state drifted above broker
   * truth), the scheduler re-fetches available qty here and retries the
   * SELL with the broker-side ground truth.
   *
   * Endpoint and field names follow the official Webull OpenAPI reference:
   * https://developer.webull.com/apis/docs/reference/account-position/
   */
  async getPositions(): Promise<WebullPositionDto[]> {
    return this.request<WebullPositionDto[]>('GET', this.positionsPath, {
      query: { account_id: this.requireAccountId() },
    })
  }

  /**
   * Resolve the broker-side `available_quantity` for a single symbol. Wraps
   * `getPositions()` and keeps the Webull DTO interpretation (case-insensitive
   * symbol match, `available_quantity` parsing) inside the infrastructure
   * layer so the application-side scheduler only sees a `number | null`.
   *
   * - Position match found AND `available_quantity` parses to a finite number
   *   (including 0) → that number is returned.
   * - Position match found but `available_quantity` is missing / non-numeric
   *   → `null`.
   * - No matching symbol on the account → `null`.
   * - `getPositions()` throws → the error is rethrown (caller decides how to
   *   handle the SELL fallback failure).
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
    // Single CASH account handles both US and JP (multi-currency cash
    // account). v2 endpoint — JP UAT rejects the v1 `/trade/order/place`
    // body shape with ILLEGAL_PARAMETER.
    //
    // #256: schema が v2 のときは account_id を body 側に移動 (新 docs)、
    //   query には付けない。v1 (default) は従来どおり query。
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
        // Webull SDK sets x-version=v1 for the documented trade/account routes.
        // 新 OpenAPI docs (#251 / #258) では v2 必須化の方向。env override
        // (`WEBULL_TRADE_VERSION`) で staging 切替え可能、default は v1。
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
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    retry?: WebullRetryOptions
    /**
     * Runtime-resolved `x-access-token` (#21 Phase B)。`resolveAccessToken(env)`
     * の戻り値を caller が await して渡す形。指定があれば `env.WEBULL_ACCESS_TOKEN`
     * を上書き (= DO 由来の値を優先)。
     */
    accessToken?: string
  },
): WebullHttpClient {
  // #257: env で trade/account path を上書き可能。受理条件:
  //   - 文字列であること
  //   - trim 後が非空
  //   - `/` で始まる絶対パス (= WEBULL_TRADE_API_BASE を bypass する絶対 URL を弾く、
  //     CodeRabbit #264 finding)
  // 上記を満たさない場合は undefined を返して default path にフォールバック。
  const trim = (v: string | undefined): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (t.length === 0) return undefined
    if (!t.startsWith('/')) return undefined
    return t
  }
  // #258: x-version は 'v1' / 'v2' のみ allow-list 受理。それ以外 (空 /
  // whitespace / 不正値) は undefined を返して default ('v1') に fallback。
  // 任意文字列を通すと broker auth signing が壊れるため strict validation。
  const validateVersion = (v: string | undefined): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (t === 'v1' || t === 'v2') return t
    return undefined
  }
  // #256: Place Order body schema version の strict allow-list 受理。
  // 'v1' / 'v2' 以外 (空 / whitespace / 任意文字列) は undefined → default 'v1'。
  // 任意文字列を通すと broken body schema を broker に送って order が壊れる。
  const validateOrderSchema = (v: string | undefined): PlaceOrderSchemaVersion | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (t === 'v1' || t === 'v2') return t
    return undefined
  }
  // env 空 / undefined / whitespace は JP prod default に fallback。env が
  // 明示的にセットされてれば override (UAT / 将来 region 用)。
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

/**
 * 新 OpenAPI docs (#251 / #253) の order-history / order-detail wrapper shape:
 *   { client_order_id, combo_type, orders: [...inner...] }
 * 旧 (現行 callers が想定する) flat shape:
 *   { client_order_id, side, status, filled_quantity, ... }
 *
 * row が `orders[]` を持っていれば wrapper と判定:
 *   - `orders[0]` が存在 → flat shape に projection (`total_quantity` →
 *     `quantity` も合わせてコピー)。多 leg / combo は POC scope 外なので
 *     `orders[0]` のみ採用 (combo_type !== 'NORMAL' なら呼び出し側 reconciler
 *     が detect)。
 *   - `orders[]` が空 → 「対象 order が存在しない」状態として **空オブジェクト**
 *     を返す (CodeRabbit #261)。partial detail (client_order_id だけ持つ) を
 *     返すと findOrderByClientId が誤 match して、status/side 等を持たない
 *     incomplete row を caller に渡してしまうため。
 *
 * 旧 flat shape の row はそのまま返す (互換)。
 */
export function normalizeOrderHistoryRow(
  raw: WebullOrderHistoryWrapperDto | WebullOrderDetailDto,
): WebullOrderDetailDto {
  if (raw === null || typeof raw !== 'object') return {} as WebullOrderDetailDto
  const wrapper = raw as WebullOrderHistoryWrapperDto
  if (!Array.isArray(wrapper.orders)) {
    return raw as WebullOrderDetailDto
  }
  const inner = wrapper.orders[0]
  if (inner === undefined || inner === null) {
    // wrapper.orders が空 / 不在 → 「対象なし」 sentinel として空オブジェクトを返す
    // (caller の find は clientOrderId !== undefined で match しないので skip)。
    return {} as WebullOrderDetailDto
  }
  // top-level の client_order_id を最優先 (wrapper 側が canonical)、inner の同
  // フィールドは fallback。
  const clientOrderId = wrapper.client_order_id ?? inner.client_order_id
  // 新 `total_quantity` を `quantity` にコピー (consumer は `quantity` を読む)。
  const quantity = inner.quantity ?? inner.total_quantity
  return {
    ...inner,
    client_order_id: clientOrderId,
    quantity,
    total_quantity: inner.total_quantity,
  }
}