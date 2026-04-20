import { describe, expect, it, vi } from 'vitest'
import { WebullBarClient } from '../../../src/infrastructure/quotes/BarClient'
import { WebullAuth } from '../../../src/infrastructure/webull/WebullAuth'

const baseAuth = new WebullAuth({ appKey: 'ak', appSecret: 'sk' })

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('WebullBarClient.getDailyBars', () => {
  // Regression for #84-style drift: default endpoint + Java-SDK-matching
  // query field names (`timespan` + `count`, NOT `period` + `limit`).
  // Historical default `/market-data/candles` + `period/limit` silently
  // drops every bar request because it has the wrong path AND wrong params.
  it('defaults to v2 /openapi/market-data/stock/bars with timespan=D + count + x-version: v2', async () => {
    // Confirmed via stdlib probe (#84): v1 `/market-data/bars` → 404,
    // v2 `/market-data/stock/bars` → 417 UNSUPPORTED_TIMESPAN (path valid).
    // Accepted timespan set: {M1, M5, M15, M30, M60, M120, M240, D, W, M, Y}.
    let capturedUrl: URL | undefined
    let capturedHeaders: Headers | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedHeaders = new Headers(init?.headers)
      return mockJsonResponse({ data: [] })
    }) as unknown as typeof fetch

    const client = new WebullBarClient({ auth: baseAuth, fetchFn })
    await client.getDailyBars('SOXL', 30)

    expect(capturedUrl?.pathname).toBe('/openapi/market-data/stock/bars')
    expect(capturedUrl?.searchParams.get('symbol')).toBe('SOXL')
    expect(capturedUrl?.searchParams.get('timespan')).toBe('D')
    expect(capturedUrl?.searchParams.get('count')).toBe('30')
    expect(capturedUrl?.searchParams.get('period')).toBeNull()
    expect(capturedUrl?.searchParams.get('limit')).toBeNull()
    expect(capturedHeaders?.get('x-version')).toBe('v2')
  })

  // Category routing mirrors WebullQuoteClient: SOXL/SOXS are ETFs, 4-digit
  // (7203) and alphanumeric (285A) TSE codes are JP.
  it('routes SOXL→US_ETF, AAPL→US_STOCK, 285A→JP_STOCK on the wire', async () => {
    const captured: string[] = []
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      captured.push(new URL(urlStr).searchParams.get('category') ?? '')
      return mockJsonResponse({ data: [] })
    }) as unknown as typeof fetch

    const client = new WebullBarClient({ auth: baseAuth, fetchFn })
    await client.getDailyBars('SOXL', 1)
    await client.getDailyBars('AAPL', 1)
    await client.getDailyBars('285A', 1)

    expect(captured).toEqual(['US_ETF', 'US_STOCK', 'JP_STOCK'])
  })

  // Negative: honouring `barsPath` override proves the default assertion above
  // would actually catch a drift of DEFAULT barsPath back to `/market-data/candles`.
  it('honours barsPath override (default-assertion sanity)', async () => {
    let capturedPath: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedPath = new URL(urlStr).pathname
      return mockJsonResponse({ data: [] })
    }) as unknown as typeof fetch

    const client = new WebullBarClient({
      auth: baseAuth,
      fetchFn,
      barsPath: '/market-data/candles',
    })
    await client.getDailyBars('SOXL', 1)

    expect(capturedPath).toBe('/market-data/candles')
    expect(capturedPath).not.toBe('/openapi/market-data/stock/bars')
  })
})
