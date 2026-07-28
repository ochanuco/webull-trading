import { describe, expect, it, vi } from 'vitest'
import {
  GdeltDocClient,
  GdeltFetchError,
  GdeltResponseError,
} from '../../../src/infrastructure/news/GdeltDocClient'

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function sampleTimeline(points: Array<{ date: string; value: number }>) {
  return {
    query_details: { query: 'trump tariffs sourcelang:english' },
    timeline: [
      {
        series: 'Volume Intensity',
        data: points,
      },
    ],
  }
}

describe('GdeltDocClient.getTimeline', () => {
  it('requests query/mode/format/timespan and normalizes GDELT bucket dates to ISO UTC', async () => {
    let capturedUrl: URL | undefined
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      return mockJsonResponse(
        sampleTimeline([
          { date: '20260724T143000Z', value: 0.6738 },
          { date: '20260724T144500Z', value: 0.701 },
        ]),
      )
    })

    const client = new GdeltDocClient({ fetchFn })
    const points = await client.getTimeline('trump tariffs sourcelang:english', 'volume', '1d')

    expect(capturedUrl?.hostname).toBe('api.gdeltproject.org')
    expect(capturedUrl?.pathname).toBe('/api/v2/doc/doc')
    expect(capturedUrl?.searchParams.get('query')).toBe('trump tariffs sourcelang:english')
    expect(capturedUrl?.searchParams.get('mode')).toBe('timelinevol')
    expect(capturedUrl?.searchParams.get('format')).toBe('json')
    expect(capturedUrl?.searchParams.get('timespan')).toBe('1d')

    expect(points).toEqual([
      { bucketAt: '2026-07-24T14:30:00.000Z', value: 0.6738 },
      { bucketAt: '2026-07-24T14:45:00.000Z', value: 0.701 },
    ])
  })

  it("uses mode=timelinetone for the 'tone' metric", async () => {
    let capturedUrl: URL | undefined
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      return mockJsonResponse(sampleTimeline([]))
    })
    const client = new GdeltDocClient({ fetchFn })
    await client.getTimeline('stock market selloff sourcelang:english', 'tone', '1d')
    expect(capturedUrl?.searchParams.get('mode')).toBe('timelinetone')
  })

  it('returns [] (not throw) when timeline is empty/missing', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => mockJsonResponse({ timeline: [] }))
    const client = new GdeltDocClient({ fetchFn })
    const points = await client.getTimeline('q', 'volume')
    expect(points).toEqual([])
  })

  it('returns [] when the response has no timeline field at all', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => mockJsonResponse({}))
    const client = new GdeltDocClient({ fetchFn })
    const points = await client.getTimeline('q', 'volume')
    expect(points).toEqual([])
  })

  it('drops points with non-finite values, keeping the rest', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      mockJsonResponse(
        sampleTimeline([
          { date: '20260724T143000Z', value: 0.5 },
          { date: '20260724T144500Z', value: Number.NaN },
          { date: '20260724T150000Z', value: Number.POSITIVE_INFINITY },
          { date: '20260724T151500Z', value: 0.9 },
        ]),
      ),
    )
    const client = new GdeltDocClient({ fetchFn })
    const points = await client.getTimeline('q', 'volume')
    expect(points).toEqual([
      { bucketAt: '2026-07-24T14:30:00.000Z', value: 0.5 },
      { bucketAt: '2026-07-24T15:15:00.000Z', value: 0.9 },
    ])
  })

  it('drops points with an unparseable date', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      mockJsonResponse(
        sampleTimeline([
          { date: 'not-a-date', value: 0.5 },
          { date: '20260724T143000Z', value: 0.9 },
        ]),
      ),
    )
    const client = new GdeltDocClient({ fetchFn })
    const points = await client.getTimeline('q', 'volume')
    expect(points).toEqual([{ bucketAt: '2026-07-24T14:30:00.000Z', value: 0.9 }])
  })

  it('throws GdeltResponseError with a truncated plain-text body on 429', async () => {
    const longBody = 'Rate limit exceeded, please retry after 5 seconds. '.repeat(10)
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(longBody, { status: 429, headers: { 'Content-Type': 'text/plain' } }),
    )
    const client = new GdeltDocClient({ fetchFn })
    const error = await client.getTimeline('q', 'volume').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GdeltResponseError)
    const gdeltError = error as GdeltResponseError
    expect(gdeltError.status).toBe(429)
    expect(gdeltError.bodySnippet.length).toBeLessThanOrEqual(200)
    expect(gdeltError.bodySnippet).toContain('Rate limit exceeded')
  })

  it('throws GdeltResponseError (not a raw JSON parse error) when a 200 returns an HTML body', async () => {
    const html = '<html><body>Something went wrong upstream</body></html>'
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    )
    const client = new GdeltDocClient({ fetchFn })
    const error = await client.getTimeline('q', 'volume').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GdeltResponseError)
    const gdeltError = error as GdeltResponseError
    expect(gdeltError.status).toBe(200)
    expect(gdeltError.bodySnippet).toContain('Something went wrong upstream')
    // Must not have attempted response.json() on the HTML body — that would
    // surface as a generic SyntaxError instead of our typed error.
    expect(error).not.toBeInstanceOf(SyntaxError)
  })

  it('throws GdeltFetchError when the underlying fetch aborts (timeout)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    const client = new GdeltDocClient({ fetchFn, timeoutMs: 5 })
    await expect(client.getTimeline('q', 'volume')).rejects.toBeInstanceOf(GdeltFetchError)
  })
})
