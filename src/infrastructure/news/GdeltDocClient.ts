const DEFAULT_BASE_URL = 'https://api.gdeltproject.org'
// Longer than quote/bar clients' 5s: GDELT can take 20s+ even on a
// rate-limit response, and unlike quotes it isn't on the order-decision
// critical path (the gate only reads D1), so waiting doesn't block trading.
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_TIMESPAN = '1d'
/** `response.text()` truncation cap for error messages (avoid logging huge HTML bodies). */
const BODY_SNIPPET_MAX_CHARS = 200

export type GdeltMetric = 'volume' | 'tone'

const MODE_BY_METRIC: Record<GdeltMetric, string> = {
  volume: 'timelinevol',
  tone: 'timelinetone',
}

export interface GdeltTimelinePoint {
  /** ISO UTC, normalized from GDELT's `YYYYMMDDTHHMMSSZ` bucket date. */
  bucketAt: string
  value: number
}

export interface GdeltDocClientOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

interface GdeltTimelineResponse {
  timeline?: Array<{
    series?: string
    data?: Array<{ date?: string; value?: number }>
  }>
}

/** Network-level failure (DNS, connection reset, abort/timeout). */
export class GdeltFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'GdeltFetchError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** HTTP-level failure: non-2xx status, or a 200 whose body isn't the JSON we expect. */
export class GdeltResponseError extends Error {
  readonly status: number
  readonly bodySnippet: string

  constructor(message: string, status: number, bodySnippet: string) {
    super(message)
    this.name = 'GdeltResponseError'
    this.status = status
    this.bodySnippet = bodySnippet
  }
}

/**
 * GDELT DOC 2.0 API client (`https://api.gdeltproject.org/api/v2/doc/doc`),
 * unauthenticated. A 200 response doesn't guarantee a JSON body (rate-limit
 * / upstream errors can return HTML with status 200), so content-type is
 * checked before `.json()` to avoid an untyped `SyntaxError`.
 */
export class GdeltDocClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(options: GdeltDocClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Workers' global `fetch` must be bound to globalThis or it throws
    // "Illegal invocation" — mirrors YahooBarClient / WebullHttpClient.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  /**
   * Fetches a single metric's timeline for `query`. Returns `[]` (never
   * throws for shape reasons) when GDELT's `timeline` is empty or missing —
   * only transport failures and malformed responses throw.
   */
  async getTimeline(
    query: string,
    metric: GdeltMetric,
    timespan: string = DEFAULT_TIMESPAN,
  ): Promise<GdeltTimelinePoint[]> {
    const url = new URL('/api/v2/doc/doc', this.baseUrl)
    url.searchParams.set('query', query)
    url.searchParams.set('mode', MODE_BY_METRIC[metric])
    url.searchParams.set('format', 'json')
    url.searchParams.set('timespan', timespan)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
    } catch (error) {
      throw new GdeltFetchError(
        `GDELT timeline fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const snippet = await bodySnippet(response)
      throw new GdeltResponseError(
        `GDELT timeline request failed with status ${response.status}: ${snippet}`,
        response.status,
        snippet,
      )
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) {
      const snippet = await bodySnippet(response)
      throw new GdeltResponseError(
        `GDELT timeline returned non-JSON content-type '${contentType}': ${snippet}`,
        response.status,
        snippet,
      )
    }

    const json = (await response.json()) as GdeltTimelineResponse
    return normalizeTimeline(json)
  }
}

async function bodySnippet(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, BODY_SNIPPET_MAX_CHARS)
}

// Only one `mode` is ever requested, so the first series is always the one asked for.
function normalizeTimeline(json: GdeltTimelineResponse): GdeltTimelinePoint[] {
  const data = json.timeline?.[0]?.data
  if (!Array.isArray(data)) return []
  const points: GdeltTimelinePoint[] = []
  for (const raw of data) {
    const bucketAt = parseGdeltDate(raw?.date)
    if (!bucketAt) continue
    const value = raw?.value
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    points.push({ bucketAt, value })
  }
  return points
}

const GDELT_DATE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/

/** `20260724T143000Z` → `2026-07-24T14:30:00.000Z`. Returns null if unparseable. */
function parseGdeltDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const match = GDELT_DATE_RE.exec(raw)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`
  return Number.isFinite(Date.parse(iso)) ? iso : null
}
