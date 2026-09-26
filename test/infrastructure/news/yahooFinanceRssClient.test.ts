import { describe, expect, it, vi } from 'vitest'
import {
  YahooFinanceRssClient,
  YahooFinanceRssFetchError,
  YahooFinanceRssResponseError,
  parseYahooFinanceRss,
} from '../../../src/infrastructure/news/YahooFinanceRssClient'

function rssFeed(items: string): string {
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`
}

/** Yahoo Finance RSS items have no `<source>` element, unlike Google News. */
function item(opts: { title: string; pubDate?: string }): string {
  const pubDateTag = opts.pubDate ? `<pubDate>${opts.pubDate}</pubDate>` : ''
  return `<item><title>${opts.title}</title>${pubDateTag}</item>`
}

describe('parseYahooFinanceRss', () => {
  it('parses a real-shaped item (RFC822 pubDate, no source element)', () => {
    const xml = rssFeed(
      item({ title: 'S&amp;P 500 closes at record high', pubDate: 'Sat, 26 Sep 2026 13:18:00 +0000' }),
    )
    const headlines = parseYahooFinanceRss(xml)
    expect(headlines).toEqual([
      { title: 'S&P 500 closes at record high', source: null, publishedAt: '2026-09-26T13:18:00.000Z' },
    ])
  })

  it('decodes CDATA and numeric entities via the shared helpers', () => {
    const xml = rssFeed(
      item({
        title: '<![CDATA[Markets react to Fed&#39;s latest move]]>',
        pubDate: 'Sat, 26 Sep 2026 13:18:00 +0000',
      }),
    )
    const [headline] = parseYahooFinanceRss(xml)
    expect(headline?.title).toBe("Markets react to Fed's latest move")
  })

  it('dedupes by normalized title and caps at 20, newest first, via the shared helpers', () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      item({
        title: `Market headline ${i}`,
        pubDate: new Date(Date.UTC(2026, 8, 26, 0, i)).toUTCString(),
      }),
    ).join('')
    const headlines = parseYahooFinanceRss(rssFeed(items))
    expect(headlines).toHaveLength(20)
    expect(headlines[0]?.title).toBe('Market headline 24')
    expect(headlines[19]?.title).toBe('Market headline 5')
  })

  it('returns [] for an empty feed', () => {
    expect(parseYahooFinanceRss(rssFeed(''))).toEqual([])
  })
})

describe('YahooFinanceRssClient.fetchHeadlines', () => {
  it('requests s/region/lang against the Yahoo Finance RSS endpoint with a browser-like User-Agent', async () => {
    let capturedUrl: URL | undefined
    let capturedHeaders: HeadersInit | undefined
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      capturedHeaders = init?.headers
      return new Response(rssFeed(''), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } })
    })
    const client = new YahooFinanceRssClient({ fetchFn })
    await client.fetchHeadlines('^GSPC,^DJI')
    expect(capturedUrl?.hostname).toBe('feeds.finance.yahoo.com')
    expect(capturedUrl?.pathname).toBe('/rss/2.0/headline')
    expect(capturedUrl?.searchParams.get('s')).toBe('^GSPC,^DJI')
    expect(capturedUrl?.searchParams.get('region')).toBe('US')
    expect(capturedUrl?.searchParams.get('lang')).toBe('en-US')
    expect((capturedHeaders as Record<string, string>)['User-Agent']).toBeTruthy()
  })

  it('throws YahooFinanceRssResponseError with a truncated body on non-2xx', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('Service unavailable, try again later. '.repeat(10), {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    const client = new YahooFinanceRssClient({ fetchFn })
    const error = await client.fetchHeadlines().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(YahooFinanceRssResponseError)
    const rssError = error as YahooFinanceRssResponseError
    expect(rssError.status).toBe(503)
    expect(rssError.bodySnippet.length).toBeLessThanOrEqual(200)
  })

  it('throws YahooFinanceRssResponseError when a 200 body is not RSS', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('<html>oops</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    )
    const client = new YahooFinanceRssClient({ fetchFn })
    await expect(client.fetchHeadlines()).rejects.toBeInstanceOf(YahooFinanceRssResponseError)
  })

  it('throws YahooFinanceRssFetchError when the underlying fetch aborts (timeout)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    const client = new YahooFinanceRssClient({ fetchFn, timeoutMs: 5 })
    await expect(client.fetchHeadlines()).rejects.toBeInstanceOf(YahooFinanceRssFetchError)
  })
})
