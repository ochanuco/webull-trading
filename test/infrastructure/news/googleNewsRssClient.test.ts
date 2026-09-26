import { describe, expect, it, vi } from 'vitest'
import {
  GoogleNewsFetchError,
  GoogleNewsResponseError,
  GoogleNewsRssClient,
  parseGoogleNewsRss,
} from '../../../src/infrastructure/news/GoogleNewsRssClient'

function rssFeed(items: string): string {
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`
}

function item(opts: { title: string; source?: string; pubDate?: string }): string {
  const sourceTag = opts.source ? `<source url="https://example.com">${opts.source}</source>` : ''
  const pubDateTag = opts.pubDate ? `<pubDate>${opts.pubDate}</pubDate>` : ''
  return `<item><title>${opts.title}</title>${pubDateTag}${sourceTag}</item>`
}

describe('parseGoogleNewsRss', () => {
  it('parses title/source/pubDate wrapped in CDATA', () => {
    const xml = rssFeed(
      item({
        title: '<![CDATA[Stocks rally as tech leads gains - CNBC]]>',
        source: '<![CDATA[CNBC]]>',
        pubDate: 'Fri, 26 Sep 2026 12:00:00 GMT',
      }),
    )
    const headlines = parseGoogleNewsRss(xml)
    expect(headlines).toEqual([
      {
        title: 'Stocks rally as tech leads gains',
        source: 'CNBC',
        publishedAt: '2026-09-26T12:00:00.000Z',
      },
    ])
  })

  it('decodes named and numeric XML entities', () => {
    const xml = rssFeed(
      item({
        title: 'S&amp;P 500 hits record &#39;again&#39; &amp; markets cheer',
        source: 'Reuters',
        pubDate: 'Fri, 26 Sep 2026 12:00:00 GMT',
      }),
    )
    const [headline] = parseGoogleNewsRss(xml)
    expect(headline?.title).toBe("S&P 500 hits record 'again' & markets cheer")
  })

  it('strips the Google-appended " - <Source>" suffix only when it matches the source tag exactly', () => {
    const xml = rssFeed(
      item({ title: 'Fed holds rates steady - Bloomberg', source: 'Bloomberg', pubDate: 'Fri, 26 Sep 2026 12:00:00 GMT' }) +
        item({ title: 'Markets close mixed - not the source', source: 'Bloomberg', pubDate: 'Fri, 26 Sep 2026 11:00:00 GMT' }),
    )
    const headlines = parseGoogleNewsRss(xml)
    expect(headlines[0]?.title).toBe('Fed holds rates steady')
    expect(headlines[1]?.title).toBe('Markets close mixed - not the source')
  })

  it('dedupes by case/whitespace-insensitive normalized title, keeping the newest', () => {
    const xml = rssFeed(
      item({ title: 'Stocks   Rally On Fed News', source: 'A', pubDate: 'Fri, 26 Sep 2026 10:00:00 GMT' }) +
        item({ title: 'stocks rally on fed news', source: 'B', pubDate: 'Fri, 26 Sep 2026 12:00:00 GMT' }),
    )
    const headlines = parseGoogleNewsRss(xml)
    expect(headlines).toHaveLength(1)
    expect(headlines[0]?.source).toBe('B')
    expect(headlines[0]?.publishedAt).toBe('2026-09-26T12:00:00.000Z')
  })

  it('sorts newest first and caps at 20 items', () => {
    const items = Array.from({ length: 25 }, (_, i) =>
      item({
        title: `Headline number ${i}`,
        source: 'Wire',
        pubDate: new Date(Date.UTC(2026, 8, 26, 0, i)).toUTCString(),
      }),
    ).join('')
    const headlines = parseGoogleNewsRss(rssFeed(items))
    expect(headlines).toHaveLength(20)
    expect(headlines[0]?.title).toBe('Headline number 24')
    expect(headlines[19]?.title).toBe('Headline number 5')
  })

  it('returns [] for an empty feed', () => {
    expect(parseGoogleNewsRss(rssFeed(''))).toEqual([])
  })

  it('returns null publishedAt for a missing/unparseable pubDate', () => {
    const xml = rssFeed(item({ title: 'No date headline', source: 'Wire' }))
    const [headline] = parseGoogleNewsRss(xml)
    expect(headline?.publishedAt).toBeNull()
  })
})

describe('GoogleNewsRssClient.fetchHeadlines', () => {
  it('requests q/hl/gl/ceid against the Google News RSS search endpoint', async () => {
    let capturedUrl: URL | undefined
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      capturedUrl = new URL(urlStr)
      return new Response(rssFeed(''), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } })
    })
    const client = new GoogleNewsRssClient({ fetchFn })
    await client.fetchHeadlines('nasdaq when:1h')
    expect(capturedUrl?.hostname).toBe('news.google.com')
    expect(capturedUrl?.pathname).toBe('/rss/search')
    expect(capturedUrl?.searchParams.get('q')).toBe('nasdaq when:1h')
    expect(capturedUrl?.searchParams.get('hl')).toBe('en-US')
    expect(capturedUrl?.searchParams.get('gl')).toBe('US')
    expect(capturedUrl?.searchParams.get('ceid')).toBe('US:en')
  })

  it('throws GoogleNewsResponseError with a truncated body on non-2xx', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('Service unavailable, try again later. '.repeat(10), {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    const client = new GoogleNewsRssClient({ fetchFn })
    const error = await client.fetchHeadlines().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GoogleNewsResponseError)
    const rssError = error as GoogleNewsResponseError
    expect(rssError.status).toBe(503)
    expect(rssError.bodySnippet.length).toBeLessThanOrEqual(200)
  })

  it('throws GoogleNewsResponseError when a 200 body is not RSS (consent/captcha page)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('<html>oops</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    )
    const client = new GoogleNewsRssClient({ fetchFn })
    await expect(client.fetchHeadlines()).rejects.toBeInstanceOf(GoogleNewsResponseError)
  })

  it('accepts an RSS body even when Content-Type is not XML', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(rssFeed(item({ title: 'Stocks slide', source: 'Wire' })), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    const client = new GoogleNewsRssClient({ fetchFn })
    await expect(client.fetchHeadlines()).resolves.toHaveLength(1)
  })

  it('throws GoogleNewsFetchError when the underlying fetch aborts (timeout)', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit)?.signal
        signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    const client = new GoogleNewsRssClient({ fetchFn, timeoutMs: 5 })
    await expect(client.fetchHeadlines()).rejects.toBeInstanceOf(GoogleNewsFetchError)
  })
})
