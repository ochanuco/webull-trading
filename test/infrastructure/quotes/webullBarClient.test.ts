import { describe, expect, it, vi } from 'vitest'
import {
  FallbackBarClient,
  WebullBarClient,
  selectBarClient,
} from '../../../src/infrastructure/quotes/BarClient'
import { YahooBarClient } from '../../../src/infrastructure/quotes/YahooBarClient'
import { WebullAuth } from '../../../src/infrastructure/webull/WebullAuth'
import type { Env } from '../../../src/config/env'

const baseAuth = new WebullAuth({ appKey: 'ak', appSecret: 'sk' })
const TEST_BASE_URL = 'https://test.example'

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('WebullBarClient.getDailyBars', () => {
  // Regression: v2 /market-data/stock/bars returns `time` as
  // "2026-04-17T04:00:00.000+0000"; a prior normalizer only looked at
  // `date` / `trade_time`, so every bar was dropped and Pullback saw
  // "insufficient bars for indicators" even on 200 OK.
  it('parses v2 `time` field (ISO w/ offset) as a YYYY-MM-DD date', async () => {
    const fetchFn = vi.fn(async () =>
      mockJsonResponse([
        {
          tickerId: '913244722',
          symbol: 'SOXL',
          time: '2026-04-17T04:00:00.000+0000',
          open: '93.195000',
          high: '94.750000',
          low: '90.660000',
          close: '94.680000',
          volume: '67081435',
        },
        {
          symbol: 'SOXL',
          time: '2026-04-16T04:00:00.000+0000',
          open: '85.010000',
          high: '90.0',
          low: '84.0',
          close: '88.37',
        },
      ]),
    ) as unknown as typeof fetch

    const client = new WebullBarClient({ auth: baseAuth, baseUrl: TEST_BASE_URL, fetchFn })
    const bars = await client.getDailyBars('SOXL', 2)

    expect(bars).toHaveLength(2)
    // Oldest first by date
    expect(bars[0]?.date).toBe('2026-04-16')
    expect(bars[1]?.date).toBe('2026-04-17')
    expect(bars[1]?.close).toBeCloseTo(94.68)
  })


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

    const client = new WebullBarClient({ auth: baseAuth, baseUrl: TEST_BASE_URL, fetchFn })
    await client.getDailyBars('SOXL', 30)

    expect(capturedUrl?.pathname).toBe('/openapi/market-data/stock/bars')
    expect(capturedUrl?.searchParams.get('symbol')).toBe('SOXL')
    expect(capturedUrl?.searchParams.get('timespan')).toBe('D')
    expect(capturedUrl?.searchParams.get('count')).toBe('30')
    expect(capturedUrl?.searchParams.get('period')).toBeNull()
    expect(capturedUrl?.searchParams.get('limit')).toBeNull()
    // 新 OpenAPI docs (#251 / #255) で required 扱い、default 'true' を明示送信
    expect(capturedUrl?.searchParams.get('real_time_required')).toBe('true')
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

    const client = new WebullBarClient({ auth: baseAuth, baseUrl: TEST_BASE_URL, fetchFn })
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
      auth: baseAuth, baseUrl: TEST_BASE_URL,
      fetchFn,
      barsPath: '/market-data/candles',
    })
    await client.getDailyBars('SOXL', 1)

    expect(capturedPath).toBe('/market-data/candles')
    expect(capturedPath).not.toBe('/openapi/market-data/stock/bars')
  })
})

describe('WebullBarClient.getIntradayBars (#475)', () => {
  it('maps 60m → timespan=M60 and normalizes time to ISO UTC, oldest-first', async () => {
    let capturedUrl = ''
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return mockJsonResponse([
        { time: '2026-06-11T14:30:00.000+0000', open: '100', high: '101', low: '99', close: '100.5' },
        { time: '2026-06-11T13:30:00.000+0000', open: '99', high: '100', low: '98', close: '99.5' },
      ])
    }) as unknown as typeof fetch

    const client = new WebullBarClient({ auth: baseAuth, baseUrl: TEST_BASE_URL, fetchFn })
    const bars = await client.getIntradayBars('AAPL', '60m')

    expect(capturedUrl).toContain('timespan=M60')
    expect(bars).toHaveLength(2)
    expect(bars[0]?.timestamp).toBe('2026-06-11T13:30:00.000Z')
    expect(bars[1]?.close).toBeCloseTo(100.5)
  })
})

describe('FallbackBarClient (#475 Webull primary + Yahoo fallback)', () => {
  function stubClient(name: string, calls: string[], fail = false) {
    return {
      getDailyBars: async (symbol: string, lookback: number) => {
        calls.push(`${name}:daily:${symbol}:${lookback}`)
        if (fail) throw new Error(`${name} down`)
        return [{ date: '2026-06-10', open: 1, high: 1, low: 1, close: 1 }]
      },
      getIntradayBars: async (symbol: string) => {
        calls.push(`${name}:intraday:${symbol}`)
        if (fail) throw new Error(`${name} down`)
        return [{ timestamp: '2026-06-11T13:30:00.000Z', open: 1, high: 1, low: 1, close: 1 }]
      },
    }
  }

  it('US 銘柄は Webull primary、^VIX と JP 銘柄は Yahoo 直行', async () => {
    const calls: string[] = []
    const client = new FallbackBarClient(
      stubClient('webull', calls) as unknown as WebullBarClient,
      stubClient('yahoo', calls) as unknown as YahooBarClient,
    )
    await client.getDailyBars('AAPL', 60)
    await client.getDailyBars('^VIX', 1)
    await client.getDailyBars('1357', 60)
    expect(calls).toEqual(['webull:daily:AAPL:60', 'yahoo:daily:^VIX:1', 'yahoo:daily:1357:60'])
  })

  it('Webull 失敗時は同じ呼び出しを Yahoo で再試行する (daily / intraday とも)', async () => {
    const calls: string[] = []
    const client = new FallbackBarClient(
      stubClient('webull', calls, true) as unknown as WebullBarClient,
      stubClient('yahoo', calls) as unknown as YahooBarClient,
    )
    const daily = await client.getDailyBars('AAPL', 60)
    const intraday = await client.getIntradayBars('AAPL', '60m')
    expect(daily).toHaveLength(1)
    expect(intraday).toHaveLength(1)
    expect(calls).toEqual([
      'webull:daily:AAPL:60',
      'yahoo:daily:AAPL:60',
      'webull:intraday:AAPL',
      'yahoo:intraday:AAPL',
    ])
  })
})

describe('selectBarClient (#475 BAR_SOURCE 切替)', () => {
  it('未設定は Yahoo (現行 default、fail-safe)', async () => {
    const client = await selectBarClient({} as unknown as Env)
    expect(client).toBeInstanceOf(YahooBarClient)
  })

  it("BAR_SOURCE=webull で FallbackBarClient (Webull primary)", async () => {
    const client = await selectBarClient({
      BAR_SOURCE: 'webull',
      WEBULL_APP_KEY: 'k'.repeat(32),
      WEBULL_APP_SECRET: 's'.repeat(32),
    } as unknown as Env)
    expect(client).toBeInstanceOf(FallbackBarClient)
  })

  it('未知値は Yahoo に倒す', async () => {
    const client = await selectBarClient({ BAR_SOURCE: 'alpaca' } as unknown as Env)
    expect(client).toBeInstanceOf(YahooBarClient)
  })
})
