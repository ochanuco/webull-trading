import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'
import { toWebullPlaceOrderRequest } from './mapper'

/**
 * 銘柄の Webull JP 取扱チェック (#461)。Preview Order
 * (`POST /openapi/account/orders/preview`) で発注パイプラインの検証だけを通す —
 * **注文は作成されない** (path は preview 固定)。取扱外銘柄は検証段階で
 * `TICKER_IS_DENY` が返るため、発注せずに取引可否を確定できる。
 *
 * body shape は JP 実測で確定途中 (#461: v1 place 形は OPENAPI_PARAM_ERR) の
 * ため、候補 shape を並列で試す (#415 の path 確定と同じ方式)。判定は:
 *   - どれかが 200            → 'tradable'
 *   - どれかが TICKER_IS_DENY → 'denied' (確定)
 *   - 応答はあるが全部エラー   → 'error' (銘柄以外の要因の可能性)
 *   - 設定不足 / 全部不達      → 'unavailable'
 *
 * 'denied' 以外で登録をブロックしない想定 (check 不能時に全登録が止まるのは
 * 過剰 fail-closed — 発注側には #460 の事後ガードが別途ある)。
 */

export type TradabilityVerdict = 'tradable' | 'denied' | 'error' | 'unavailable'

export interface TradabilityVariantResult {
  label: string
  status: number | null
  errorCode: string | null
  message: string | null
}

export interface TradabilityResult {
  verdict: TradabilityVerdict
  /** operator 向けの 1 行説明。 */
  detail: string
  variants: TradabilityVariantResult[]
}

/**
 * Preview Order に試す body shape 候補 (#461)。確定したら 1 つに絞る。
 * broker/probe (診断ページ) と form チェックの両方がこれを共有する。
 */
export function buildPreviewOrderVariants(
  symbol: string,
  market: 'US' | 'JP',
  price: number,
  accountId: string,
): Array<{ label: string; body: unknown }> {
  const baseEntry = {
    symbol,
    instrument_type: 'EQUITY',
    market,
    side: 'BUY',
    quantity: '1',
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    account_tax_type: 'GENERAL',
  }
  return [
    {
      // production place (v1 mapper) と同形: client_order_id + MARKET + limit cap
      label: 'v1-place-shape',
      body: toWebullPlaceOrderRequest(
        {
          symbol,
          side: 'BUY',
          quantity: 1,
          price,
          notional: price,
          clientOrderId: `probe-preview-${crypto.randomUUID()}`,
        },
        'v1',
        accountId,
      ),
    },
    {
      // JP preview docs (preview-order-v2) の field 集合: client_order_id なし、
      // v2 session enum
      label: 'v2-fields-market',
      body: {
        new_orders: [
          {
            ...baseEntry,
            order_type: 'MARKET',
            support_trading_session: 'CORE',
            limit_price: price.toFixed(3),
          },
        ],
      },
    },
    {
      label: 'v2-fields-limit',
      body: {
        new_orders: [
          {
            ...baseEntry,
            order_type: 'LIMIT',
            support_trading_session: 'CORE',
            limit_price: price.toFixed(3),
          },
        ],
      },
    },
  ]
}

const PREVIEW_PATH = '/openapi/account/orders/preview'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const PREVIEW_TIMEOUT_MS = 10_000

interface CheckInput {
  symbol: string
  market: 'US' | 'JP'
  /** preview の limit cap。未指定は 100 (shape 確定までの placeholder)。 */
  price?: number
  /** test seam。default は globalThis.fetch。 */
  fetcher?: typeof fetch
}

export async function checkTradability(env: Env, input: CheckInput): Promise<TradabilityResult> {
  const appKey = (env.WEBULL_APP_KEY ?? '').trim()
  const appSecret = (env.WEBULL_APP_SECRET ?? '').trim()
  const accountId = (env.WEBULL_ACCOUNT_ID_JP_CASH ?? '').trim()
  if (appKey.length === 0 || appSecret.length === 0 || accountId.length === 0) {
    return {
      verdict: 'unavailable',
      detail: 'Webull credentials 未設定のため検証不可',
      variants: [],
    }
  }
  const symbol = input.symbol.trim().toUpperCase()
  const price = Number.isFinite(input.price) && (input.price as number) > 0 ? (input.price as number) : 100
  const baseUrl = (env.WEBULL_TRADE_API_BASE ?? '').trim() || DEFAULT_TRADE_API_BASE
  const accessToken = await resolveAccessToken(env).catch(() => undefined)
  const doFetch = input.fetcher ?? fetch
  const variants = buildPreviewOrderVariants(symbol, input.market, price, accountId)

  const results: TradabilityVariantResult[] = await Promise.all(
    variants.map(async (variant): Promise<TradabilityVariantResult> => {
      const url = new URL(PREVIEW_PATH, `${baseUrl}/`)
      url.searchParams.set('account_id', accountId)
      const payload = JSON.stringify(variant.body)
      try {
        const headers = await buildSignedHeaders({
          method: 'POST',
          path: url.pathname,
          query: { account_id: accountId },
          body: payload,
          host: url.host,
          appKey,
          appSecret,
          version: 'v1',
          ...(accessToken !== undefined ? { accessToken } : {}),
        })
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS)
        try {
          const response = await doFetch(url.href, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
            body: payload,
            signal: controller.signal,
          })
          const text = await response.text()
          let errorCode: string | null = null
          let message: string | null = null
          try {
            const parsed = JSON.parse(text) as { error_code?: unknown; message?: unknown }
            errorCode = typeof parsed.error_code === 'string' ? parsed.error_code : null
            message = typeof parsed.message === 'string' ? parsed.message : null
          } catch {
            // 非 JSON 応答は status だけで判定
          }
          return { label: variant.label, status: response.status, errorCode, message }
        } finally {
          clearTimeout(timeoutId)
        }
      } catch (err) {
        return {
          label: variant.label,
          status: null,
          errorCode: null,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  if (results.some((r) => r.status === 200)) {
    return { verdict: 'tradable', detail: '発注前検証 (Preview Order) 通過 — 取引可能', variants: results }
  }
  if (results.some((r) => r.errorCode === 'OAUTH_OPENAPI_TICKER_IS_DENY')) {
    return {
      verdict: 'denied',
      detail: 'Webull JP の OpenAPI では発注できない銘柄 (TICKER_IS_DENY)',
      variants: results,
    }
  }
  if (results.some((r) => r.status !== null)) {
    const codes = [...new Set(results.map((r) => r.errorCode).filter(Boolean))].join(', ')
    return {
      verdict: 'error',
      detail: `検証エラー (${codes || 'unknown'}) — 銘柄以外の要因の可能性`,
      variants: results,
    }
  }
  return { verdict: 'unavailable', detail: 'broker に到達できず判定不可', variants: results }
}
