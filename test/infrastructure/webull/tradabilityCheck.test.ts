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
  it('verdict=tradable when any variant returns 200', async () => {
    const result = await checkTradability(env, {
      symbol: 'aapl',
      market: 'US',
      fetcher: fetcherReturning([
        { status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } },
        { status: 200, body: { estimated_cost: '292.55' } },
        { status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } },
      ]),
    })
    expect(result.verdict).toBe('tradable')
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

  it('verdict=error when broker responds but all variants fail with other codes', async () => {
    const result = await checkTradability(env, {
      symbol: 'AAPL',
      market: 'US',
      fetcher: fetcherReturning([{ status: 417, body: { error_code: 'OPENAPI_PARAM_ERR' } }]),
    })
    expect(result.verdict).toBe('error')
    expect(result.detail).toContain('OPENAPI_PARAM_ERR')
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
