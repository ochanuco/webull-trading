import { describe, expect, it, vi } from 'vitest'
import { WebullQuoteClient } from '../../../src/infrastructure/quotes/WebullQuoteClient'
import { WebullAuth } from '../../../src/infrastructure/webull/WebullAuth'

const baseAuth = new WebullAuth({ appKey: 'ak', appSecret: 'sk' })

function mockFetch(responseBody: unknown, init: ResponseInit = { status: 200 }): typeof fetch {
  const json = JSON.stringify(responseBody)
  return vi.fn(
    async () => new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' }, ...init }),
  ) as unknown as typeof fetch
}

/**
 * Bid/ask are blockers for spread guard (#38-D / #53). These tests pin the
 * tolerant parsing of bid/ask fields regardless of the upstream UAT key
 * naming, while keeping them strictly optional so existing quote feed paths
 * keep working when the broker does not return them.
 */
describe('WebullQuoteClient.getSnapshots bid/ask', () => {
  it('includes bid and ask when both are positive', async () => {
    const fetchFn = mockFetch({
      data: [{ symbol: 'SOXL', last_price: 10.25, bid: '10.24', ask: 10.26 }],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const result = await client.getSnapshots(['SOXL'], 'US_STOCK')
    expect(result).toEqual([
      { symbol: 'SOXL', price: 10.25, asOf: '2026-04-18T10:00:05.000Z', bid: 10.24, ask: 10.26 },
    ])
  })

  it('includes only bid when ask is missing', async () => {
    const fetchFn = mockFetch({
      data: [{ symbol: 'SOXL', last_price: 10.25, bid_price: 10.2 }],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const [entry] = await client.getSnapshots(['SOXL'], 'US_STOCK')
    expect(entry).toBeDefined()
    expect(entry?.bid).toBe(10.2)
    expect(entry?.ask).toBeUndefined()
  })

  it('accepts bp/ap fallback keys', async () => {
    const fetchFn = mockFetch({
      data: [{ symbol: 'SOXL', last_price: 10.25, bp: '10.1', ap: '10.3' }],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const [entry] = await client.getSnapshots(['SOXL'], 'US_STOCK')
    expect(entry?.bid).toBe(10.1)
    expect(entry?.ask).toBe(10.3)
  })

  it('omits bid/ask when both are undefined (back-compat)', async () => {
    const fetchFn = mockFetch({
      data: [{ symbol: 'SOXL', last_price: 10.25 }],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const result = await client.getSnapshots(['SOXL'], 'US_STOCK')
    expect(result).toEqual([
      { symbol: 'SOXL', price: 10.25, asOf: '2026-04-18T10:00:05.000Z' },
    ])
    expect('bid' in result[0]!).toBe(false)
    expect('ask' in result[0]!).toBe(false)
  })

  it('drops bid/ask when non-positive or non-finite', async () => {
    const fetchFn = mockFetch({
      data: [
        { symbol: 'A', last_price: 10, bid: 0, ask: -1 },
        { symbol: 'B', last_price: 10, bid: 'abc', ask: 'def' },
      ],
    })
    const client = new WebullQuoteClient({
      auth: baseAuth,
      fetchFn,
      now: () => new Date('2026-04-18T10:00:05.000Z'),
    })
    const result = await client.getSnapshots(['A', 'B'], 'US_STOCK')
    expect(result.map((r) => r.symbol)).toEqual(['A', 'B'])
    for (const entry of result) {
      expect(entry.bid).toBeUndefined()
      expect(entry.ask).toBeUndefined()
    }
  })
})
