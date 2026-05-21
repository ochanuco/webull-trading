import { describe, expect, it, vi } from 'vitest'
import { checkMarketDataReachability } from '../../../src/infrastructure/webull/checkMarketDataReachability'

describe('checkMarketDataReachability', () => {
  // happy path future: Webull JP が data-api を公開したら 404 (root path に
  // route が無い時の standard 応答) でも reachable=true で返るべき。404 OK は
  // listener が立ってる証拠。
  it('returns reachable=true when server responds (any HTTP status counts)', async () => {
    const fetchFn = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    const result = await checkMarketDataReachability({ fetchFn })
    expect(result.reachable).toBe(true)
    expect(result.status).toBe(404)
    expect(result.error).toBeNull()
  })

  it('returns reachable=true for 200 (= fully serving)', async () => {
    const fetchFn = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    const result = await checkMarketDataReachability({ fetchFn })
    expect(result.reachable).toBe(true)
    expect(result.status).toBe(200)
  })

  // 現状の期待挙動: data-api は TCP 沈黙 → fetch が abort される。
  it('returns reachable=false when fetch throws (timeout / DNS error)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('The operation was aborted')
    }) as unknown as typeof fetch
    const result = await checkMarketDataReachability({ fetchFn })
    expect(result.reachable).toBe(false)
    expect(result.status).toBeNull()
    expect(result.error).toMatch(/aborted/)
  })

  // GET / と timeout 5s が default。caller (cron) は default 引数のまま呼ぶので
  // 規約を locked。
  it('defaults: GET https://data-api.webull.co.jp/ with 5s timeout', async () => {
    let capturedUrl: string | undefined
    let capturedMethod: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedMethod = init?.method
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch

    await checkMarketDataReachability({ fetchFn })
    expect(capturedUrl).toBe('https://data-api.webull.co.jp/')
    expect(capturedMethod).toBe('GET')
  })

  it('honours host override (for testing against alternative hosts)', async () => {
    let capturedUrl: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    await checkMarketDataReachability({ fetchFn, host: 'api.webull.co.jp' })
    expect(capturedUrl).toBe('https://api.webull.co.jp/')
  })
})
