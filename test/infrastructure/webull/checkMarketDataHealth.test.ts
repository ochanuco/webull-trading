import { describe, expect, it, vi } from 'vitest'
import { checkMarketDataHealth } from '../../../src/infrastructure/webull/checkMarketDataHealth'
import type { Env } from '../../../src/config/env'

const env = {
  WEBULL_APP_KEY: 'k'.repeat(32),
  WEBULL_APP_SECRET: 's'.repeat(32),
} as unknown as Env

describe('checkMarketDataHealth (#475 snapshot v2 canary)', () => {
  it('healthy=true when snapshot returns 200', async () => {
    const fetchFn = vi.fn(
      async () => new Response('[{"symbol":"AAPL","price":"291.58"}]', { status: 200 }),
    ) as unknown as typeof fetch
    const result = await checkMarketDataHealth(env, { fetchFn })
    expect(result.healthy).toBe(true)
    expect(result.status).toBe(200)
    expect(result.error).toBeNull()
  })

  it('healthy=false for non-200 (404 = gateway routing 退行の検出)', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{"error_msg":"404 Route Not Found"}', { status: 404 }),
    ) as unknown as typeof fetch
    const result = await checkMarketDataHealth(env, { fetchFn })
    expect(result.healthy).toBe(false)
    expect(result.status).toBe(404)
    expect(result.error).toBe('HTTP 404')
  })

  it('healthy=false when fetch throws (timeout / DNS error)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('The operation was aborted')
    }) as unknown as typeof fetch
    const result = await checkMarketDataHealth(env, { fetchFn })
    expect(result.healthy).toBe(false)
    expect(result.status).toBeNull()
    expect(result.error).toMatch(/aborted/)
  })

  it('healthy=false when credentials are missing (misconfig を握り潰さない)', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const result = await checkMarketDataHealth({} as unknown as Env, { fetchFn })
    expect(result.healthy).toBe(false)
    expect(result.error).toContain('credentials')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('documented snapshot endpoint を trade host + v2 署名で叩く (PR #474 実測の規約を locked)', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedHeaders = init?.headers as Record<string, string>
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch

    await checkMarketDataHealth(env, { fetchFn })
    expect(capturedUrl).toContain('https://api.webull.co.jp/openapi/market-data/stock/snapshot')
    expect(capturedUrl).toContain('symbols=AAPL')
    expect(capturedHeaders?.['x-version']).toBe('v2')
  })

  it('honours WEBULL_TRADE_API_BASE override', async () => {
    let capturedUrl: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return new Response('[]', { status: 200 })
    }) as unknown as typeof fetch

    await checkMarketDataHealth(
      { ...env, WEBULL_TRADE_API_BASE: 'https://example.test' } as unknown as Env,
      { fetchFn },
    )
    expect(capturedUrl).toContain('https://example.test/openapi/market-data/stock/snapshot')
  })
})
