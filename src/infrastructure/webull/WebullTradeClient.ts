import type { OrderIntent } from '../../trading/domain/OrderIntent'
import {
  createWebullHttpClient,
  type WebullClientEnv,
  type WebullHttpClient,
} from './WebullHttpClient'
import type { WebullPlaceOrderResponseDto } from './dto'

/**
 * When `ENVIRONMENT` is anything other than `'production'`, the constructor
 * structurally disables trading. Webull JP's 1-user-1-app constraint means
 * staging and prod share one API key, so this env-label gate is the core
 * defense against a staging run placing a live order.
 */
export interface WebullTradeClientEnv extends WebullClientEnv {
  ENVIRONMENT?: string
}

/**
 * Thrown when `WebullTradeClient.placeOrder` is invoked in a non-production
 * environment (staging / dev / unset). Distinct from {@link BrokerRequestError}
 * so logs can distinguish "broker rejected the trade" from "our gate stopped
 * the trade before it reached the broker".
 */
export class TradeDisabledError extends Error {
  constructor(reason: string) {
    super(`WebullTradeClient: placeOrder disabled — ${reason}`)
    this.name = 'TradeDisabledError'
  }
}

/**
 * Write-only facade over {@link WebullHttpClient}; `placeOrder` passes through
 * the constructor-time staging gate before reaching the broker.
 */
export class WebullTradeClient {
  /** Reason trades are blocked, or null when production. Non-null always makes placeOrder throw {@link TradeDisabledError}. */
  private readonly disabledReason: string | null

  constructor(
    private readonly http: Pick<WebullHttpClient, 'placeOrder'>,
    env: { ENVIRONMENT?: string },
  ) {
    const label = (env.ENVIRONMENT ?? '').trim()
    if (label === 'production') {
      this.disabledReason = null
    } else if (label.length === 0) {
      // Unset must fail closed: production deploys always set ENVIRONMENT
      // explicitly, so unset means the var didn't land, not that this is prod.
      this.disabledReason = 'ENVIRONMENT is not set (expected "production" for live trades)'
    } else {
      this.disabledReason = `ENVIRONMENT="${label}" (expected "production" for live trades)`
    }
  }

  get isLiveTradingEnabled(): boolean {
    return this.disabledReason === null
  }

  async placeOrder(intent: OrderIntent): Promise<WebullPlaceOrderResponseDto> {
    if (this.disabledReason !== null) {
      // Redundant with the strategy cron's own staging gate (MockExecution
      // swap) — this one covers callers that skip that path, e.g. admin
      // routes or scripts calling placeOrder directly.
      throw new TradeDisabledError(this.disabledReason)
    }
    return this.http.placeOrder(intent)
  }
}

export function createWebullTradeClient(
  env: WebullTradeClientEnv,
  options?: Parameters<typeof createWebullHttpClient>[1],
): WebullTradeClient {
  return new WebullTradeClient(createWebullHttpClient(env, options), env)
}
