import { describe, expect, it } from 'vitest'
import {
  buildPreviewOrderVariants,
  checkTradability,
} from '../../../src/infrastructure/webull/tradabilityCheck'
import type { Env } from '../../../src/config/env'

const env = {
  WEBULL_APP_KEY: 'k'.repeat(32),
  WEBULL_APP_SECRET: 's'.repeat(32),
  WEBULL_ACCOUNT_ID_JP_CASH: 'acct-1',
} as unknown as Env

function fetcherReturning(bodies: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0
  return (async () => {
    const next = bodies[Math.min(i, bodies.length - 1)]!
    i += 1
    return new Response(JSON.stringify(next.body), { status: next.status })
  }) as typeof fetch
}

describe('checkTradability (#461 Preview Order)', () => {
  it('verdict=unknown(quote_ok) when any variant returns 200 — 取引可能とは主張しない', async () => {
    const result = await checkTradability(env, {
      symbol: 'aapl',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } },
        { status: 200, body: { estimated_cost: '292.55' } },
        { status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } },
      ]),
    })
    expect(result.verdict).toBe('unknown')
    expect(result.reason).toBe('quote_ok')
  })

  it('verdict=denied(invalid_symbol) when all variants reject the symbol (ZZZZ 実測)', async () => {
    const result = await checkTradability(env, {
      symbol: 'ZZZZ',
      market: 'US',
      fetcher: fetcherReturning([
        {
          status: 417,
          body: {
            error_code: 'OAUTH_OPENAPI_PARAM_ERR',
            message: 'Parameter error, invalid market,symbol,instrument_type, value: US,ZZZZ,EQUITY',
          },
        },
      ]),
    })
    expect(result.verdict).toBe('denied')
    expect(result.reason).toBe('invalid_symbol')
  })

  it('symbol を含まない PARAM_ERR は invalid_symbol にしない (他フィールド起因)', async () => {
    const result = await checkTradability(env, {
      symbol: 'AAPL',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 417, body: { error_code: 'OAUTH_OPENAPI_PARAM_ERR', message: 'Parameter error, invalid quantity' } },
      ]),
    })
    expect(result.verdict).toBe('unknown')
    expect(result.reason).toBe('preview_error')
  })

  it('verdict=denied when any variant returns TICKER_IS_DENY (確定 NG)', async () => {
    const result = await checkTradability(env, {
      symbol: 'USMV',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 417, body: { error_code: 'OAUTH_OPENAPI_TICKER_IS_DENY', message: 'The current security is not available.' } },
      ]),
    })
    expect(result.verdict).toBe('denied')
    expect(result.detail).toContain('TICKER_IS_DENY')
  })

  it('message なしの PARAM_ERR 等は unknown(preview_error)', async () => {
    const result = await checkTradability(env, {
      symbol: 'AAPL',
      market: 'US',
      fetcher: fetcherReturning([{ status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } }]),
    })
    expect(result.verdict).toBe('unknown')
    expect(result.reason).toBe('preview_error')
  })

  it('verdict=unavailable when credentials are missing (登録はブロックしない側)', async () => {
    const result = await checkTradability({} as Env, { symbol: 'AAPL', market: 'US' })
    expect(result.verdict).toBe('unavailable')
  })

  it('verdict=unavailable when the broker is unreachable', async () => {
    const result = await checkTradability(env, {
      symbol: 'AAPL',
      market: 'US',
      fetcher: (async () => {
        throw new Error('connect timeout')
      }) as typeof fetch,
    })
    expect(result.verdict).toBe('unavailable')
  })

  it('variants は preview 専用 path 前提の body (発注 path に流さない契約の確認)', () => {
    const variants = buildPreviewOrderVariants('AAPL', 'US', 100, 'acct-1')
    expect(variants).toHaveLength(3)
    for (const v of variants) {
      const body = v.body as { new_orders: Array<Record<string, unknown>> }
      expect(body.new_orders).toHaveLength(1)
      expect(body.new_orders[0]!.symbol).toBe('AAPL')
      expect(body.new_orders[0]!.quantity).toBe('1')
      expect(body.new_orders[0]!.side).toBe('BUY')
    }
  })
})

describe('checkTradability 200 偽陽性ガード (#461 本番 deny との矛盾調査)', () => {
  it('HTTP 200 でも body に TICKER_IS_DENY が埋まっていれば denied', async () => {
    const result = await checkTradability(env, {
      symbol: 'USMV',
      market: 'US',
      fetcher: fetcherReturning([
        {
          status: 200,
          body: { new_orders: [{ symbol: 'USMV', error_code: 'OAUTH_OPENAPI_TICKER_IS_DENY' }] },
        },
      ]),
    })
    expect(result.verdict).toBe('denied')
  })

  it('HTTP 200 でも body に別の error_code が埋まっていれば quote_ok にしない', async () => {
    const result = await checkTradability(env, {
      symbol: 'AAPL',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 200, body: { new_orders: [{ error_code: 'SOME_EMBEDDED_ERR' }] } },
      ]),
    })
    expect(result.verdict).toBe('unknown')
    expect(result.reason).toBe('preview_error')
  })

  it('クリーンな 200 は quote_ok (発注可否は未保証の文言)', async () => {
    const result = await checkTradability(env, {
      symbol: 'AAPL',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } },
        { status: 200, body: { estimated_cost: '292.55', estimated_transaction_fee: '0' } },
      ]),
    })
    expect(result.verdict).toBe('unknown')
    expect(result.reason).toBe('quote_ok')
    expect(result.detail).toContain('事前検証不可')
  })
})

describe('isTickerDenyCode (#466: prefix なし表記も deny 扱い)', () => {
  it('bare TICKER_IS_DENY も denied になる', async () => {
    const result = await checkTradability(env, {
      symbol: 'USMV',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 417, body: { error_code: 'TICKER_IS_DENY' } },
      ]),
    })
    expect(result.verdict).toBe('denied')
  })
})
