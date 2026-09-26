import { describe, expect, it, vi } from 'vitest'
import {
  YahooQuoteClient,
  YAHOO_QUOTE_SOURCE,
} from '../../../src/infrastructure/quotes/YahooQuoteClient'

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('YahooQuoteClient', () => {
  // Locked: dashboard/log source labels only ever take 'yahoo-snapshot' or
  // 'webull-snapshot' (#21 follow-up); this guards against label drift.
  it('exposes source = "yahoo-snapshot"', () => {
    const client = new YahooQuoteClient()
    expect(client.source).toBe(YAHOO_QUOTE_SOURCE)
    expect(client.source).toBe('yahoo-snapshot')
  })

  it('GETs /v8/finance/chart/{symbol}?interval=1m&range=1d with Mozilla UA', async () => {
    let capturedUrl: URL | undefined
    let capturedHeaders: Headers | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedHeaders = new Headers(init?.headers)
      return mockJson({
        chart: {
          result: [
            { meta: { symbol: 'AAPL', regularMarketPrice: 200.5, regularMarketTime: 1700000000 } },
          ],
        },
      })
    }) as unknown as typeof fetch

    const client = new YahooQuoteClient({ fetchFn })
    const results = await client.getSnapshots(['AAPL'], 'US_STOCK')

    expect(capturedUrl?.pathname).toBe('/v8/finance/chart/AAPL')
    expect(capturedUrl?.searchParams.get('interval')).toBe('1m')
    expect(capturedUrl?.searchParams.get('range')).toBe('1d')
    expect(capturedHeaders?.get('User-Agent')).toBe('Mozilla/5.0')

    expect(results).toEqual([
      { symbol: 'AAPL', price: 200.5, asOf: '2023-11-14T22:13:20.000Z' },
    ])
  })

  // Locked: reuses the same `toYahooSymbol` helper as YahooBarClient.
  it('appends `.T` suffix to JP symbols on the wire', async () => {
    let capturedPath: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedPath = new URL(urlStr).pathname
      return mockJson({
        chart: { result: [{ meta: { regularMarketPrice: 1500, regularMarketTime: 1700000000 } }] },
      })
    }) as unknown as typeof fetch

    const client = new YahooQuoteClient({ fetchFn })
    await client.getSnapshots(['7203'], 'US_STOCK')

    expect(capturedPath).toBe('/v8/finance/chart/7203.T')
  })

  it('returns empty array when symbols input is empty (no fetch)', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const client = new YahooQuoteClient({ fetchFn })
    const results = await client.getSnapshots([], 'US_STOCK')
    expect(results).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // Yahoo has no batch snapshot endpoint, hence one fetch per symbol.
  it('fans out one fetch per symbol', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: 1700000000 } }] },
      }),
    ) as unknown as typeof fetch
    const client = new YahooQuoteClient({ fetchFn })
    await client.getSnapshots(['AAPL', 'MSFT', 'GOOG'], 'US_STOCK')
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  // Locked: the strategy cron makes its fallback/skip decision per symbol based
  // on whether a result is present, so one failure must not abort the batch.
  it('drops symbols whose individual fetch errors (does not abort the whole batch)', async () => {
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (urlStr.includes('FAIL')) {
        return mockJson({ chart: { error: 'service unavailable' } }, 503)
      }
      return mockJson({
        chart: { result: [{ meta: { regularMarketPrice: 100, regularMarketTime: 1700000000 } }] },
      })
    }) as unknown as typeof fetch
    const client = new YahooQuoteClient({ fetchFn })
    const results = await client.getSnapshots(['OK1', 'FAIL', 'OK2'], 'US_STOCK')
    expect(results.map((r) => r.symbol)).toEqual(['OK1', 'OK2'])
  })

  it('drops symbols whose response is missing regularMarketPrice', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: { result: [{ meta: { symbol: 'X', regularMarketTime: 1700000000 } }] },
      }),
    ) as unknown as typeof fetch
    const client = new YahooQuoteClient({ fetchFn })
    const results = await client.getSnapshots(['X'], 'US_STOCK')
    expect(results).toEqual([])
  })

  it('drops symbols whose regularMarketPrice is zero or negative', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: { result: [{ meta: { regularMarketPrice: 0, regularMarketTime: 1700000000 } }] },
      }),
    ) as unknown as typeof fetch
    const client = new YahooQuoteClient({ fetchFn })
    const results = await client.getSnapshots(['ZERO'], 'US_STOCK')
    expect(results).toEqual([])
  })

  // Same fallback behavior as the Webull client; a downstream staleness check
  // only needs a usable date, not a from-upstream timestamp specifically.
  it('falls back to now() when regularMarketTime is missing', async () => {
    const fixedNow = new Date('2026-05-20T15:00:00.000Z')
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: { result: [{ meta: { regularMarketPrice: 100 } }] },
      }),
    ) as unknown as typeof fetch
    const client = new YahooQuoteClient({ fetchFn, now: () => fixedNow })
    const results = await client.getSnapshots(['AAPL'], 'US_STOCK')
    expect(results).toEqual([{ symbol: 'AAPL', price: 100, asOf: '2026-05-20T15:00:00.000Z' }])
  })
})
