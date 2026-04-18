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
  it('routes 4-digit codes to JP_STOCK and others to US_STOCK', () => {
    const grouped = groupSymbolsByCategory(['SOXL', '7203', 'AAPL', '9984'])
    expect(grouped.US_STOCK).toEqual(['SOXL', 'AAPL'])
    expect(grouped.JP_STOCK).toEqual(['7203', '9984'])
  })
})

describe('WebullQuoteClient.getSnapshots', () => {
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
