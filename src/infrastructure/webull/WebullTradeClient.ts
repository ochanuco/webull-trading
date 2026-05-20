import type { OrderIntent } from '../../trading/domain/OrderIntent'
import {
  createWebullHttpClient,
  type WebullClientEnv,
  type WebullHttpClient,
} from './WebullHttpClient'
import type { WebullPlaceOrderResponseDto } from './dto'

/**
 * `WebullTradeClient` への入力 env (#21)。`ENVIRONMENT` が `'production'` 以外
 * (`'staging'` / `'dev'` / undefined / 任意文字列) のとき、constructor 時点で
 * trade を **構造的に disable** する。Webull JP は 1 user = 1 app の制約で
 * staging/prod が同じ API key を共有するため、env 識別ラベルでコード側に gate を
 * 入れて staging からの live order を絶対に出さない設計 (3 重防御の中核)。
 *
 * `ENVIRONMENT` は `wrangler.jsonc::env.<env>.vars` で deploy artifact に焼かれる。
 * secret で override される可能性はあるが、その時点で operator の明示的な行為
 * とみなす (= 偶発事故の防止が主目的)。
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
 * Write-only facade over {@link WebullHttpClient} (#21)。read 系 (`getPositions`
 * 等) は触れない。`placeOrder` は constructor 時に判定された staging gate を経由
 * してから broker に届く。
 */
export class WebullTradeClient {
  /**
   * Reason for blocking trades, or `null` if production. `null` 以外なら
   * `placeOrder` は必ず `TradeDisabledError` を throw する。
   */
  private readonly disabledReason: string | null

  constructor(
    private readonly http: Pick<WebullHttpClient, 'placeOrder'>,
    env: { ENVIRONMENT?: string },
  ) {
    const label = (env.ENVIRONMENT ?? '').trim()
    if (label === 'production') {
      this.disabledReason = null
    } else if (label.length === 0) {
      // 未設定 = wrangler.jsonc::env.<env>.vars が外れた / local dev の暴発を防ぐ。
      // production を deploy するときは必ず 'production' が設定されてるはず。
      this.disabledReason = 'ENVIRONMENT is not set (expected "production" for live trades)'
    } else {
      this.disabledReason = `ENVIRONMENT="${label}" (expected "production" for live trades)`
    }
  }

  /** `placeOrder` を呼ばずに gate の現状を運用ログに残したいときの read 用。 */
  get isLiveTradingEnabled(): boolean {
    return this.disabledReason === null
  }

  async placeOrder(intent: OrderIntent): Promise<WebullPlaceOrderResponseDto> {
    if (this.disabledReason !== null) {
      // strategy cron は ENVIRONMENT=staging のとき MockExecution に流す path
      // で staging を防ぐが、admin route や script から `placeOrder` が呼ばれる
      // とその上位 gate を経由しない。ここで throw する事で「想定外の call site
      // から live order が出る」事故を抑える。
      throw new TradeDisabledError(this.disabledReason)
    }
    return this.http.placeOrder(intent)
  }
}

export function createWebullTradeClient(
  env: WebullTradeClientEnv,
  options?: Parameters<typeof createWebullHttpClient>[1],
): WebullTradeClient {
  // `options.accessToken` (Phase B の resolveAccessToken 由来) を WebullHttpClient
  // に thru で渡す。env.WEBULL_ACCESS_TOKEN は DO 未投入時の fallback。
  return new WebullTradeClient(createWebullHttpClient(env, options), env)
}
