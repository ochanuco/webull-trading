import { describe, expect, it, vi } from 'vitest'
import { loadUsdJpyRate } from '../../../src/infrastructure/quotes/fxRate'

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

const chart = (price: unknown) => ({ chart: { result: [{ meta: { regularMarketPrice: price } }] } })

describe('loadUsdJpyRate', () => {
  it('returns the regularMarketPrice when valid', async () => {
    const rate = await loadUsdJpyRate({ fetchFn: fakeFetch(chart(150.25)) })
    expect(rate).toBeCloseTo(150.25, 4)
  })

  it('returns null on out-of-range rate (sanity guard)', async () => {
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch(chart(5)) })).toBeNull() // < 50
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch(chart(9999)) })).toBeNull() // > 500
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch(chart(0)) })).toBeNull()
  })

  it('returns null on non-finite / missing price', async () => {
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch(chart('abc')) })).toBeNull()
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch(chart(undefined)) })).toBeNull()
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch({}) })).toBeNull()
  })

  it('returns null on non-OK response', async () => {
    expect(await loadUsdJpyRate({ fetchFn: fakeFetch(chart(150), false, 429) })).toBeNull()
  })

  it('returns null (does not throw) when fetch rejects', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(loadUsdJpyRate({ fetchFn })).resolves.toBeNull()
  })

  it('includes requestId in every structured failure log (CodeRabbit #407)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // non-ok
      await loadUsdJpyRate({ requestId: 'req-1', fetchFn: fakeFetch(chart(150), false, 429) })
      // invalid rate
      await loadUsdJpyRate({ requestId: 'req-2', fetchFn: fakeFetch(chart(0)) })
      // fetch reject
      const rejectFetch = vi.fn(async () => {
        throw new Error('boom')
      }) as unknown as typeof fetch
      await loadUsdJpyRate({ requestId: 'req-3', fetchFn: rejectFetch })

      const events = warn.mock.calls.map((c) => JSON.parse(c[0] as string))
      expect(events.find((e) => e.event === 'usdjpy_fetch_non_ok')?.requestId).toBe('req-1')
      expect(events.find((e) => e.event === 'usdjpy_rate_invalid')?.requestId).toBe('req-2')
      expect(events.find((e) => e.event === 'usdjpy_fetch_failed')?.requestId).toBe('req-3')
    } finally {
      warn.mockRestore()
    }
  })
})
