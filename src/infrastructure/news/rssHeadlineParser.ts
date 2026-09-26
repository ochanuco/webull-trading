/**
 * Shared RSS parsing for the market-headline collector's feeds (Google
 * News, Yahoo Finance). Workers has no DOMParser, so items are extracted
 * with regex over the raw XML text rather than an XML/DOM library.
 * Feed-specific post-processing (Google's ` - <Source>` title suffix) stays
 * in each client — only the parts identical across both feeds live here.
 */
export interface RssHeadline {
  title: string
  source: string | null
  /** ISO UTC, parsed from the item's `pubDate`; null when missing/unparseable. */
  publishedAt: string | null
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

function parsePubDate(raw: string | undefined): string | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Raw `<item>` extraction (title/source/pubDate, CDATA + entity decoded).
 * `source` is null when the feed has no `<source>` element per item (Yahoo
 * Finance's feed never does); no suffix-stripping, dedupe, or cap here.
 */
export function parseRssItems(xml: string): RssHeadline[] {
  const items: RssHeadline[] = []
  ITEM_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ITEM_RE.exec(xml)) !== null) {
    const block = match[1]!
    const titleMatch = TITLE_RE.exec(block)
    if (!titleMatch) continue
    const title = decodeXmlText(titleMatch[1]!)
    if (!title) continue

    const sourceMatch = SOURCE_RE.exec(block)
    const source = sourceMatch ? decodeXmlText(sourceMatch[1]!) : null

    const pubDateMatch = PUBDATE_RE.exec(block)
    const publishedAt = parsePubDate(pubDateMatch ? decodeXmlText(pubDateMatch[1]!) : undefined)

    items.push({ title, source, publishedAt })
  }
  return items
}

/** Newest first, deduped by case/whitespace-insensitive normalized title, capped at `max`. */
export function dedupeAndCapHeadlines(items: RssHeadline[], max: number): RssHeadline[] {
  const sorted = [...items].sort((a, b) => {
    const at = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity
    const bt = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity
    return bt - at
  })
  const seen = new Set<string>()
  const out: RssHeadline[] = []
  for (const item of sorted) {
    const key = normalizeTitle(item.title)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= max) break
  }
  return out
}
