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

export class BrokerRequestError extends TradingError {
  readonly code = 'broker_request_error'
  readonly status = 502
  readonly broker = 'webull'
  override readonly cause?: unknown

  constructor(
    message: string,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'BrokerRequestError'
    this.cause = options?.cause
  }
}

// Planned but deferred per issue #1 §13:
// RiskRejectedError, BrokerResponseError, ConfigurationError,
// TradeEventIngestError, BridgeConnectionError.
