/**
 * Google News RSS client for the market-headline observe-only collector.
 * Fallback source: production cron egress IPs get a 503 bot-block page from
 * Google intermittently, so `headlineEvalScheduler` tries Yahoo Finance
 * first and only falls back here on a Yahoo fetch failure.
 */
import { dedupeAndCapHeadlines, parseRssItems, type RssHeadline } from './rssHeadlineParser'

const RSS_BASE_URL = 'https://news.google.com/rss/search'
// Bare `nasdaq` pulls MarketBeat's "(NASDAQ:XXX) price target" stream, and social posts leak in
// via caption matches; both crowd out index-level headlines within the 20-item cap.
export const GOOGLE_NEWS_QUERY =
  '("stock market" OR "wall street" OR "S&P 500" OR "Nasdaq Composite" OR "dow jones")' +
  ' -site:marketbeat.com -site:facebook.com -site:instagram.com -site:x.com when:1h'
const DEFAULT_TIMEOUT_MS = 20_000
/** `response.text()` truncation cap for error messages (avoid logging huge HTML bodies). */
const BODY_SNIPPET_MAX_CHARS = 200
const MAX_HEADLINES = 20

export type GoogleNewsHeadline = RssHeadline

export interface GoogleNewsRssClientOptions {
  timeoutMs?: number
  fetchFn?: typeof fetch
}

/** Network-level failure (DNS, connection reset, abort/timeout). */
export class GoogleNewsFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'GoogleNewsFetchError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** HTTP-level failure: non-2xx status, or a 200 whose body isn't RSS/XML. */
export class GoogleNewsResponseError extends Error {
  readonly status: number
  readonly bodySnippet: string

  constructor(message: string, status: number, bodySnippet: string) {
    super(message)
    this.name = 'GoogleNewsResponseError'
    this.status = status
    this.bodySnippet = bodySnippet
  }
}

export class GoogleNewsRssClient {
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(options: GoogleNewsRssClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Workers' global `fetch` must be bound to globalThis or it throws
    // "Illegal invocation" — mirrors GdeltDocClient / YahooBarClient.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  async fetchHeadlines(query: string = GOOGLE_NEWS_QUERY): Promise<GoogleNewsHeadline[]> {
    const url = new URL(RSS_BASE_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('hl', 'en-US')
    url.searchParams.set('gl', 'US')
    url.searchParams.set('ceid', 'US:en')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: controller.signal,
      })
    } catch (error) {
      throw new GoogleNewsFetchError(
        `Google News RSS fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const snippet = await bodySnippet(response)
      throw new GoogleNewsResponseError(
        `Google News RSS request failed with status ${response.status}: ${snippet}`,
        response.status,
        snippet,
      )
    }

    const body = await response.text()
    // Checked on the body, not Content-Type: a consent/captcha page is a 200 with zero items, and
    // parsing it would be stored as `no_headlines` instead of surfacing that the feed is blocked.
    if (!/<rss[\s>]/i.test(body)) {
      const snippet = body.slice(0, BODY_SNIPPET_MAX_CHARS)
      throw new GoogleNewsResponseError(
        `Google News RSS returned a non-RSS body (content-type '${response.headers.get('content-type') ?? ''}'): ${snippet}`,
        response.status,
        snippet,
      )
    }
    return parseGoogleNewsRss(body)
  }
}

async function bodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, BODY_SNIPPET_MAX_CHARS)
}

/** Google appends ` - <Source>` to the title; stripped only on an exact match so real title text isn't mangled. */
function stripSourceSuffix(title: string, source: string | null): string {
  if (!source) return title
  const suffix = ` - ${source}`
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title
}

export function parseGoogleNewsRss(xml: string): GoogleNewsHeadline[] {
  const items = parseRssItems(xml).map((item) => ({
    ...item,
    title: stripSourceSuffix(item.title, item.source),
  }))
  return dedupeAndCapHeadlines(items, MAX_HEADLINES)
}
