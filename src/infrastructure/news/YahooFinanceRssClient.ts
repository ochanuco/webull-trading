/**
 * Yahoo Finance RSS client for the market-headline observe-only collector —
 * primary source. Production cron egress IPs get a 503 bot-block page from
 * Google News intermittently (see GoogleNewsRssClient, the fallback here),
 * but the same IPs already fetch Yahoo bars reliably in this cron.
 */
import { dedupeAndCapHeadlines, parseRssItems, type RssHeadline } from './rssHeadlineParser'

const RSS_BASE_URL = 'https://feeds.finance.yahoo.com/rss/2.0/headline'
export const YAHOO_FINANCE_SYMBOLS = '^GSPC,^DJI,^IXIC,^VIX,SPY,QQQ'
const DEFAULT_TIMEOUT_MS = 20_000
/** `response.text()` truncation cap for error messages (avoid logging huge HTML bodies). */
const BODY_SNIPPET_MAX_CHARS = 200
const MAX_HEADLINES = 20
// Same convention as YahooBarClient: Yahoo's endpoints block an anonymous UA.
const DEFAULT_USER_AGENT = 'Mozilla/5.0'

export type YahooFinanceHeadline = RssHeadline

export interface YahooFinanceRssClientOptions {
  timeoutMs?: number
  fetchFn?: typeof fetch
  userAgent?: string
}

/** Network-level failure (DNS, connection reset, abort/timeout). */
export class YahooFinanceRssFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'YahooFinanceRssFetchError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** HTTP-level failure: non-2xx status, or a 200 whose body isn't RSS/XML. */
export class YahooFinanceRssResponseError extends Error {
  readonly status: number
  readonly bodySnippet: string

  constructor(message: string, status: number, bodySnippet: string) {
    super(message)
    this.name = 'YahooFinanceRssResponseError'
    this.status = status
    this.bodySnippet = bodySnippet
  }
}

export class YahooFinanceRssClient {
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly userAgent: string

  constructor(options: YahooFinanceRssClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Workers' global `fetch` must be bound to globalThis or it throws
    // "Illegal invocation" — mirrors GoogleNewsRssClient / YahooBarClient.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  }

  async fetchHeadlines(symbols: string = YAHOO_FINANCE_SYMBOLS): Promise<YahooFinanceHeadline[]> {
    const url = new URL(RSS_BASE_URL)
    url.searchParams.set('s', symbols)
    url.searchParams.set('region', 'US')
    url.searchParams.set('lang', 'en-US')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml',
          'User-Agent': this.userAgent,
        },
        signal: controller.signal,
      })
    } catch (error) {
      throw new YahooFinanceRssFetchError(
        `Yahoo Finance RSS fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const snippet = await bodySnippet(response)
      throw new YahooFinanceRssResponseError(
        `Yahoo Finance RSS request failed with status ${response.status}: ${snippet}`,
        response.status,
        snippet,
      )
    }

    const body = await response.text()
    // Body-based check, not Content-Type, same rationale as GoogleNewsRssClient.
    if (!/<rss[\s>]/i.test(body)) {
      const snippet = body.slice(0, BODY_SNIPPET_MAX_CHARS)
      throw new YahooFinanceRssResponseError(
        `Yahoo Finance RSS returned a non-RSS body (content-type '${response.headers.get('content-type') ?? ''}'): ${snippet}`,
        response.status,
        snippet,
      )
    }
    return parseYahooFinanceRss(body)
  }
}

async function bodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, BODY_SNIPPET_MAX_CHARS)
}

export function parseYahooFinanceRss(xml: string): YahooFinanceHeadline[] {
  return dedupeAndCapHeadlines(parseRssItems(xml), MAX_HEADLINES)
}
