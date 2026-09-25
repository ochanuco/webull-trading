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

// Subclasses narrow the failure into retry / give-up / alert-loudly categories so call sites
// and cron log filters don't have to re-parse status codes from the message. The base class
// itself stays constructible so existing `throw new BrokerRequestError(...)` call sites keep working.
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

// A string, not an enum: Webull treats this as a versionless protocol constant, returned with
// HTTP 417 in the response body when a SELL's quantity exceeds `available_quantity`.
export const WEBULL_SELL_QTY_EXCEED_CODE = 'OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY'

/** Used by pullbackScheduler's SELL fallback to decide whether to refetch available qty and retry. */
export function isSellQtyExceedError(error: unknown): error is BrokerClientError {
  if (!(error instanceof BrokerClientError)) return false
  if (error.brokerStatus !== 417) return false
  return error.message.includes(WEBULL_SELL_QTY_EXCEED_CODE)
}

// Permanent, not a retry/signing/token issue: once a symbol's place order returns 417 with this
// code, it stays untradable via OpenAPI, which is why tickerDenyGuard auto-disables entry on it.
export const WEBULL_TICKER_DENY_CODE = 'OAUTH_OPENAPI_TICKER_IS_DENY'

/** True when Webull rejected the order because the ticker is not tradable via OpenAPI. */
export function isTickerDenyError(error: unknown): error is BrokerClientError {
  if (!(error instanceof BrokerClientError)) return false
  if (error.brokerStatus !== 417) return false
  return error.message.includes(WEBULL_TICKER_DENY_CODE)
}
