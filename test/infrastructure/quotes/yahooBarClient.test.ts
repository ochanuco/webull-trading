import { describe, expect, it, vi } from 'vitest'
import { YahooBarClient, toYahooSymbol } from '../../../src/infrastructure/quotes/YahooBarClient'

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sampleChart(opts: { timestamps: number[]; closes: Array<number | null> }) {
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD', regularMarketPrice: 94.68 },
          timestamp: opts.timestamps,
          indicators: {
            quote: [
              {
                open: opts.closes.map((c) => (c == null ? null : c * 0.99)),
                high: opts.closes.map((c) => (c == null ? null : c * 1.01)),
                low: opts.closes.map((c) => (c == null ? null : c * 0.98)),
                close: opts.closes,
              },
            ],
          },
        },
      ],
    },
  }
}

describe('toYahooSymbol', () => {
  it('leaves US equities and ETFs as-is', () => {
    expect(toYahooSymbol('SOXL')).toBe('SOXL')
    expect(toYahooSymbol('AAPL')).toBe('AAPL')
  })

  it('adds .T suffix for 4-digit JP codes and alphanumeric TSE codes', () => {
    expect(toYahooSymbol('7267')).toBe('7267.T')
    expect(toYahooSymbol('285A')).toBe('285A.T')
  })

  it('leaves already-qualified symbols unchanged', () => {
    expect(toYahooSymbol('7267.T')).toBe('7267.T')
    expect(toYahooSymbol('BRK.A')).toBe('BRK.A')
  })
})

describe('YahooBarClient.getDailyBars', () => {
  it('calls /v8/finance/chart/<symbol> with interval=1d and a browser-like UA', async () => {
    let capturedUrl: URL | undefined
    let capturedHeaders: Headers | undefined
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedHeaders = new Headers(init?.headers)
      return mockJsonResponse(sampleChart({ timestamps: [1745539200], closes: [94.68] }))
    })

    const client = new YahooBarClient({ fetchFn })
    const bars = await client.getDailyBars('SOXL', 5)

    expect(capturedUrl?.hostname).toBe('query1.finance.yahoo.com')
    expect(capturedUrl?.pathname).toBe('/v8/finance/chart/SOXL')
    expect(capturedUrl?.searchParams.get('interval')).toBe('1d')
    expect(capturedUrl?.searchParams.get('range')).toBe('5d')
    expect(capturedHeaders?.get('User-Agent')).toMatch(/Mozilla/)
    expect(bars).toHaveLength(1)
    expect(bars[0]?.close).toBe(94.68)
  })

  it('adds .T suffix for JP TSE codes in the URL path', async () => {
    let capturedUrl: URL | undefined
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      return mockJsonResponse(sampleChart({ timestamps: [1745539200], closes: [1341] }))
    })
    const client = new YahooBarClient({ fetchFn })
    await client.getDailyBars('7267', 5)
    expect(capturedUrl?.pathname).toBe('/v8/finance/chart/7267.T')
  })

  it('drops rows where any OHLC field is null', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      mockJsonResponse(
        sampleChart({
          timestamps: [1745539200, 1745625600, 1745712000],
          closes: [94.68, null, 97.12],
        }),
      ),
    )
    const client = new YahooBarClient({ fetchFn })
    const bars = await client.getDailyBars('SOXL', 5)
    expect(bars.map((b) => b.close)).toEqual([94.68, 97.12])
  })

  it('caps output to the requested lookback even when Yahoo returns more', async () => {
    const ts = Array.from({ length: 22 }, (_, i) => 1745539200 + i * 86400)
    const closes = Array.from({ length: 22 }, (_, i) => 90 + i * 0.5)
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      mockJsonResponse(sampleChart({ timestamps: ts, closes })),
    )
    const client = new YahooBarClient({ fetchFn })
    const bars = await client.getDailyBars('SOXL', 10)
    expect(bars).toHaveLength(10)
    // Oldest-first → closest to `lookback` most recent days.
    expect(bars.at(-1)?.close).toBe(closes[21])
  })

  it('throws BrokerRequestError on non-2xx (mapped via brokerErrorForStatus)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('Too Many Requests', { status: 429 }),
    )
    const client = new YahooBarClient({ fetchFn })
    await expect(client.getDailyBars('SOXL', 5)).rejects.toThrow(/status 429/)
  })
})
