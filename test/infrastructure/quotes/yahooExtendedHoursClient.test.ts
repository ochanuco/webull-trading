import { describe, expect, it, vi } from 'vitest'
import { YahooExtendedHoursClient } from '../../../src/infrastructure/quotes/YahooExtendedHoursClient'

function mockJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** pre 09:00-09:30 ET を UTC epoch秒に固定した fixture (2026-05-20)。 */
const PRE_START = 1747738800 // 2026-05-20T09:00:00-04:00 (ET) -> 13:00Z
const PRE_END = 1747740600 // 2026-05-20T09:30:00-04:00 (ET) -> 13:30Z
const REGULAR_START = PRE_END

describe('YahooExtendedHoursClient', () => {
  it('GETs /v8/finance/chart/{symbol}?interval=1m&range=1d&includePrePost=true', async () => {
    let capturedUrl: URL | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      return mockJson({
        chart: {
          result: [
            {
              meta: {
                previousClose: 100,
                currentTradingPeriod: { pre: { start: PRE_START, end: PRE_END }, regular: { start: REGULAR_START } },
              },
              timestamp: [PRE_START],
              indicators: { quote: [{ close: [101], low: [100.5] }] },
            },
          ],
        },
      })
    }) as unknown as typeof fetch

    const client = new YahooExtendedHoursClient({ fetchFn })
    await client.getPreMarketSeries('AAPL')

    expect(capturedUrl?.pathname).toBe('/v8/finance/chart/AAPL')
    expect(capturedUrl?.searchParams.get('interval')).toBe('1m')
    expect(capturedUrl?.searchParams.get('range')).toBe('1d')
    expect(capturedUrl?.searchParams.get('includePrePost')).toBe('true')
  })

  it('extracts only bars within currentTradingPeriod.pre [start, end)', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: {
          result: [
            {
              meta: {
                previousClose: 100,
                currentTradingPeriod: { pre: { start: PRE_START, end: PRE_END }, regular: { start: REGULAR_START } },
              },
              // 1つ目: pre 開始前 (除外) / 2,3つ目: pre 窓内 / 4つ目: pre.end ちょうど (除外、half-open)
              timestamp: [PRE_START - 60, PRE_START, PRE_START + 60, PRE_END],
              indicators: {
                quote: [{ close: [98, 99, 100, 101], low: [97, 98.5, 99.5, 100.5] }],
              },
            },
          ],
        },
      }),
    ) as unknown as typeof fetch

    const client = new YahooExtendedHoursClient({ fetchFn })
    const series = await client.getPreMarketSeries('AAPL')
    expect(series?.bars.map((b) => b.close)).toEqual([99, 100])
  })

  it('falls back to ts < regular.start when currentTradingPeriod.pre is missing', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: {
          result: [
            {
              meta: {
                previousClose: 100,
                currentTradingPeriod: { regular: { start: REGULAR_START } },
              },
              timestamp: [PRE_START, REGULAR_START],
              indicators: { quote: [{ close: [99, 101], low: [98, 100] }] },
            },
          ],
        },
      }),
    ) as unknown as typeof fetch

    const client = new YahooExtendedHoursClient({ fetchFn })
    const series = await client.getPreMarketSeries('AAPL')
    expect(series?.bars.map((b) => b.close)).toEqual([99])
  })

  it('drops bars whose close is not finite > 0', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: {
          result: [
            {
              meta: {
                previousClose: 100,
                currentTradingPeriod: { pre: { start: PRE_START, end: PRE_END } },
              },
              timestamp: [PRE_START, PRE_START + 60, PRE_START + 120],
              indicators: { quote: [{ close: [0, null, 99], low: [null, null, 98] }] },
            },
          ],
        },
      }),
    ) as unknown as typeof fetch

    const client = new YahooExtendedHoursClient({ fetchFn })
    const series = await client.getPreMarketSeries('AAPL')
    expect(series?.bars).toEqual([{ at: new Date((PRE_START + 120) * 1000).toISOString(), close: 99, low: 98 }])
  })

  it('returns null when chart.result is missing', async () => {
    const fetchFn = vi.fn(async () => mockJson({ chart: { error: { code: 'Not Found' } } })) as unknown as typeof fetch
    const client = new YahooExtendedHoursClient({ fetchFn })
    const series = await client.getPreMarketSeries('AAPL')
    expect(series).toBeNull()
  })

  it('falls back to chartPreviousClose when previousClose is invalid', async () => {
    const fetchFn = vi.fn(async () =>
      mockJson({
        chart: {
          result: [
            {
              meta: {
                previousClose: 0,
                chartPreviousClose: 95,
                currentTradingPeriod: { pre: { start: PRE_START, end: PRE_END } },
              },
              timestamp: [PRE_START],
              indicators: { quote: [{ close: [99], low: [98] }] },
            },
          ],
        },
      }),
    ) as unknown as typeof fetch

    const client = new YahooExtendedHoursClient({ fetchFn })
    const series = await client.getPreMarketSeries('AAPL')
    expect(series?.prevClose).toBe(95)
  })

  it('appends `.T` suffix to JP symbols on the wire', async () => {
    let capturedPath: string | undefined
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedPath = new URL(urlStr).pathname
      return mockJson({ chart: { result: [] } })
    }) as unknown as typeof fetch

    const client = new YahooExtendedHoursClient({ fetchFn })
    await client.getPreMarketSeries('7203')
    expect(capturedPath).toBe('/v8/finance/chart/7203.T')
  })

  it('throws on non-ok HTTP status', async () => {
    const fetchFn = vi.fn(async () => mockJson({}, 503)) as unknown as typeof fetch
    const client = new YahooExtendedHoursClient({ fetchFn })
    await expect(client.getPreMarketSeries('AAPL')).rejects.toThrow()
  })
})
