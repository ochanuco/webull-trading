import type { ContentfulStatusCode } from 'hono/utils/http-status'

export abstract class TradingError extends Error {
  abstract readonly code: string
  abstract readonly status: ContentfulStatusCode
}

export class ValidationError extends TradingError {
  readonly code = 'validation_error'
  readonly status = 400
  override readonly cause?: unknown

  constructor(
    message: string,
    readonly options?: { cause?: unknown; field?: string },
  ) {
    super(message)
    this.name = 'ValidationError'
    this.cause = options?.cause
  }

  get field(): string | undefined {
    return this.options?.field
  }
}

/**
 * Base class for all broker-layer errors. Subclasses narrow the failure
 * into "retry" vs "give up" vs "alert loudly" categories so call sites and
 * cron log filters don't have to re-parse status codes from the message.
 *
 * Keep existing call sites (`throw new BrokerRequestError(...)`) working —
 * it still represents "broker layer request failed, caller probably shouldn't
 * retry". Subclasses exist on top.
 */
export class BrokerRequestError extends TradingError {
  readonly code: string = 'broker_request_error'
  readonly status: ContentfulStatusCode = 502
  readonly broker = 'webull'
  override readonly cause?: unknown
  /** Upstream Webull HTTP status when known. */
  readonly brokerStatus?: number

  constructor(
    message: string,
    readonly operation: string,
    options?: { cause?: unknown; brokerStatus?: number },
  ) {
    super(message)
    this.name = 'BrokerRequestError'
    this.cause = options?.cause
    this.brokerStatus = options?.brokerStatus
  }
}

/** Webull returned 401/403 — credential / signing issue. Do not retry. */
export class BrokerAuthError extends BrokerRequestError {
  override readonly code = 'broker_auth_error'

  constructor(
    message: string,
    operation: string,
    options?: { cause?: unknown; brokerStatus?: number },
  ) {
    super(message, operation, options)
    this.name = 'BrokerAuthError'
  }
}

/** Webull returned 429 — slow down, back off longer before retry. */
export class BrokerRateLimitError extends BrokerRequestError {
  override readonly code = 'broker_rate_limit_error'

  constructor(
    message: string,
    operation: string,
    options?: { cause?: unknown; brokerStatus?: number },
  ) {
    super(message, operation, options)
    this.name = 'BrokerRateLimitError'
  }
}

/** Webull returned a non-auth/non-rate-limit 4xx — caller's request was bad. Do not retry. */
export class BrokerClientError extends BrokerRequestError {
  override readonly code = 'broker_client_error'

  constructor(
    message: string,
    operation: string,
    options?: { cause?: unknown; brokerStatus?: number },
  ) {
    super(message, operation, options)
    this.name = 'BrokerClientError'
  }
}

/** Webull returned 5xx — transient server-side failure, retry with backoff. */
export class BrokerServerError extends BrokerRequestError {
  override readonly code = 'broker_server_error'

  constructor(
    message: string,
    operation: string,
    options?: { cause?: unknown; brokerStatus?: number },
  ) {
    super(message, operation, options)
    this.name = 'BrokerServerError'
  }
}

/**
 * Pick the narrowest BrokerRequestError subclass for an upstream HTTP status.
 * Callers that don't care about the distinction can still catch the base
 * `BrokerRequestError`.
 */
export function brokerErrorForStatus(
  status: number,
  message: string,
  operation: string,
  options?: { cause?: unknown },
): BrokerRequestError {
  const opts = { ...options, brokerStatus: status }
  if (status === 401 || status === 403) return new BrokerAuthError(message, operation, opts)
  if (status === 429) return new BrokerRateLimitError(message, operation, opts)
  if (status >= 400 && status < 500) return new BrokerClientError(message, operation, opts)
  if (status >= 500 && status < 600) return new BrokerServerError(message, operation, opts)
  return new BrokerRequestError(message, operation, opts)
}

/**
 * Webull error code surfaced when a SELL request's quantity exceeds the
 * account's `available_quantity`. Returned with HTTP 417 alongside the
 * code in the response body. Hard-coded as a string (not enum) because
 * the broker treats it as a versionless protocol constant.
 */
export const WEBULL_SELL_QTY_EXCEED_CODE = 'OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY'

/**
 * True when the error is the Webull-specific "SELL qty > available qty"
 * 417, used by the SELL fallback path in `pullbackScheduler` to decide
 * whether to refetch the broker's available qty and retry.
 *
 * Detection is conservative: status must be 417 AND the error message
 * (which includes the response body snippet, see `WebullHttpClient`) must
 * contain `OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY`. Other 417s
 * (unlikely but possible) fall through to the regular error path.
 */
export function isSellQtyExceedError(error: unknown): error is BrokerClientError {
  if (!(error instanceof BrokerClientError)) return false
  if (error.brokerStatus !== 417) return false
  return error.message.includes(WEBULL_SELL_QTY_EXCEED_CODE)
}

/**
 * Webull JP OpenAPI の銘柄単位の取扱拒否 (#460)。USMV で本番実証: 銘柄が
 * OpenAPI の取引対象外だと place order が 417 + この error_code を返す。
 * **恒久エラー** (リトライ・signing・token の問題ではない) なので、検知したら
 * 該当銘柄を自動 entry 停止する (tickerDenyGuard)。
 */
export const WEBULL_TICKER_DENY_CODE = 'OAUTH_OPENAPI_TICKER_IS_DENY'

/** True when Webull rejected the order because the ticker is not tradable via OpenAPI (#460). */
export function isTickerDenyError(error: unknown): error is BrokerClientError {
  if (!(error instanceof BrokerClientError)) return false
  if (error.brokerStatus !== 417) return false
  return error.message.includes(WEBULL_TICKER_DENY_CODE)
}

// Planned but deferred per issue #1 §13:
// RiskRejectedError, BrokerResponseError, ConfigurationError,
// TradeEventIngestError, BridgeConnectionError.
