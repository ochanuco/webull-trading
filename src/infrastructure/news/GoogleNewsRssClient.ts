/**
 * Google News RSS client for the market-headline observe-only collector.
 * Workers has no DOMParser, so the feed is parsed with regex over the raw
 * XML text rather than an XML/DOM library.
 */
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

export interface GoogleNewsHeadline {
  title: string
  source: string | null
  /** ISO UTC, parsed from the item's `pubDate`; null when missing/unparseable. */
  publishedAt: string | null
}

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

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i
const PUBDATE_RE = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i
const SOURCE_RE = /<source\b[^>]*>([\s\S]*?)<\/source>/i
const CDATA_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/

function decodeXmlText(raw: string): string {
  const cdataMatch = CDATA_RE.exec(raw)
  const text = cdataMatch ? cdataMatch[1]! : raw
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&') // last: avoids double-decoding e.g. `&amp;lt;` into `<`
    .trim()
}

/** Google appends ` - <Source>` to the title; stripped only on an exact match so real title text isn't mangled. */
function stripSourceSuffix(title: string, source: string | null): string {
  if (!source) return title
  const suffix = ` - ${source}`
  return title.endsWith(suffix) ? title.slice(0, -suffix.length) : title
}

function parsePubDate(raw: string | undefined): string | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

function dedupeAndCap(items: GoogleNewsHeadline[]): GoogleNewsHeadline[] {
  const sorted = [...items].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity
    return bt - at
  })
  const seen = new Set<string>()
  const out: GoogleNewsHeadline[] = []
  for (const item of sorted) {
    const key = normalizeTitle(item.title)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= MAX_HEADLINES) break
  }
  return out
}

export function parseGoogleNewsRss(xml: string): GoogleNewsHeadline[] {
  const items: GoogleNewsHeadline[] = []
  ITEM_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ITEM_RE.exec(xml)) !== null) {
    const block = match[1]!
    const titleMatch = TITLE_RE.exec(block)
    if (!titleMatch) continue
    const rawTitle = decodeXmlText(titleMatch[1]!)
    if (!rawTitle) continue

    const sourceMatch = SOURCE_RE.exec(block)
    const source = sourceMatch ? decodeXmlText(sourceMatch[1]!) : null

    const pubDateMatch = PUBDATE_RE.exec(block)
    const publishedAt = parsePubDate(pubDateMatch ? decodeXmlText(pubDateMatch[1]!) : undefined)

    items.push({ title: stripSourceSuffix(rawTitle, source), source, publishedAt })
  }
  return dedupeAndCap(items)
}
