import { describe, expect, it, vi } from 'vitest'
import {
  WebullQuoteClient,
  groupSymbolsByCategory,
} from '../../../src/infrastructure/quotes/WebullQuoteClient'
import { WebullAuth } from '../../../src/infrastructure/webull/WebullAuth'

const baseAuth = new WebullAuth({ appKey: 'ak', appSecret: 'sk' })

function mockFetch(responseBody: unknown, init: ResponseInit = { status: 200 }): typeof fetch {
  const json = JSON.stringify(responseBody)
  return vi.fn(
    async () => new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' }, ...init }),
  ) as unknown as typeof fetch
}

describe('groupSymbolsByCategory', () => {
  it('routes SOXL/SOXS → US_ETF, other US → US_STOCK, 4-digit/alphanumeric TSE → JP_STOCK', () => {
    const { grouped, unsupported } = groupSymbolsByCategory([
      'SOXL',
      '7203',
      'AAPL',
      '9984',
      'SOXS',
      '285A', // alphanumeric TSE code (Kioxia HD) — must classify as JP
    ])
    expect(grouped.US_ETF).toEqual(['SOXL', 'SOXS'])
    expect(grouped.US_STOCK).toEqual(['AAPL'])
    expect(grouped.JP_STOCK).toEqual(['7203', '9984', '285A'])
    expect(unsupported).toEqual([])
  })
})

describe('WebullQuoteClient.getSnapshots', () => {
  // Regression for #84/#85/#86/#87/#88: the combination of path + x-version is
  // fragile against developer.webull.com's v2 docs vs what the SDK actually
  // ships. Lock both so any future drift is caught here instead of at runtime.
  it('defaults to v2 /openapi/market-data/stock/snapshot with x-version: v2 + extend/overnight params', async () => {
    // Confirmed against the JP UAT tenant via stdlib probe (#84). v1
    // `/market-data/snapshot` returns 404; v2 `/market-data/stock/snapshot`
    // returns 200 with extend_hour_required + overnight_required present.
    let capturedUrl: URL | undefined
    let capturedHeaders: Headers | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const client = new WebullQuoteClient({ auth: baseAuth, fetchFn })
    await client.getSnapshots(['SOXL'], 'US_ETF')
    expect(capturedUrl?.pathname).toBe('/openapi/market-data/stock/snapshot')
    expect(capturedUrl?.searchParams.get('extend_hour_required')).toBe('false')
    expect(capturedUrl?.searchParams.get('overnight_required')).toBe('false')
    expect(capturedHeaders?.get('x-version')).toBe('v2')
  })

  // Negative: show the assertions above are not trivially satisfied — if the
  // default path were accidentally changed (e.g. back to the v2 stock variant
  // docs), overriding quotePath produces a different pathname. This guards
  // against a regression where DEFAULT_QUOTE_PATH drifts silently.
  it('honours quotePath override (proves the default assertion is meaningful)', async () => {
    let capturedUrl: URL | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const overridePath = '/openapi/market-data/snapshot'
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      quotePath: overridePath,
    })
    await client.getSnapshots(['SOXL'], 'US_ETF')
    expect(capturedUrl?.pathname).toBe(overridePath)
    expect(capturedUrl?.pathname).not.toBe('/openapi/market-data/stock/snapshot')
  })

  it('sends category as the underscored identifier (US_STOCK / US_ETF)', async () => {
    // Wire format confirmed by developer.webull.com example
    // (`category=US_STOCK`) and Python SDK EasyEnum.__str__ = self.name.
    // An earlier hypothesis of space-separated wire format was incorrect.
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(urlStr)
      expect(url.searchParams.get('category')).toBe('US_ETF')
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const client = new WebullQuoteClient({ auth: baseAuth, fetchFn })
    await client.getSnapshots(['SOXL'], 'US_ETF')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('returns an empty array when no symbols are requested', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const client = new WebullQuoteClient({ auth: baseAuth, fetchFn })
    const result = await client.getSnapshots([], 'US_STOCK')
    expect(result).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('parses `data[]` envelope with last_price and trade_time', async () => {
    const fetchFn = mockFetch({
      data: [
        { symbol: 'SOXL', last_price: '10.25', trade_time: '2026-04-18T10:00:00.000Z' },
        { symbol: 'AAPL', last_price: 200 },
      ],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const result = await client.getSnapshots(['SOXL', 'AAPL'], 'US_STOCK')
    expect(result).toEqual([
      { symbol: 'SOXL', price: 10.25, asOf: '2026-04-18T10:00:00.000Z' },
      { symbol: 'AAPL', price: 200, asOf: '2026-04-18T10:00:05.000Z' },
    ])
  })

  it('drops entries with non-positive or non-finite price', async () => {
    const fetchFn = mockFetch({
      data: [
        { symbol: 'GOOD', last_price: 5 },
        { symbol: 'ZERO', last_price: 0 },
        { symbol: 'NAN', last_price: 'abc' },
        { symbol: '', last_price: 1 },
      ],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const result = await client.getSnapshots(['GOOD', 'ZERO', 'NAN', ''], 'US_STOCK')
    expect(result.map((r) => r.symbol)).toEqual(['GOOD'])
  })

  it('throws BrokerRequestError on non-2xx response', async () => {
    const fetchFn = mockFetch({ error: 'bad' }, { status: 500 })
    const client = new WebullQuoteClient({ auth: baseAuth, fetchFn })
    await expect(client.getSnapshots(['AAPL'], 'US_STOCK')).rejects.toThrow(/status 500/)
  })
})
