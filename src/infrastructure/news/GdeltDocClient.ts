const DEFAULT_BASE_URL = 'https://api.gdeltproject.org'
/**
 * GDELT は素で遅い。本番で 5s (quote/bar client からの流用) にしていたところ、
 * 全 tick が `The operation was aborted` で失敗し 1 件も蓄積できていなかった。
 * 実測でもレート制限応答を返すだけで 20s 超かかることがある。
 *
 * quote/bar の 5s が短いのは、あれが取引判断のクリティカルパスに居て「古い値で
 * 発注するより落ちる方が安全」だから。GDELT はその経路に居ない — producer は
 * cron/alarm 側で非同期に回り、gate は D1 を読むだけなので、待っても取引は
 * 止まらない。取り逃がす方が損。
 */
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

/**
 * HTTP-level failure: non-2xx status, or a 200 whose body isn't the JSON we
 * expect (GDELT is observed to return HTML / plain-text bodies with a 200
 * status under some failure modes, not just on 429).
 */
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
 * GDELT DOC 2.0 API client (`https://api.gdeltproject.org/api/v2/doc/doc`).
 * No authentication — this is a public, unauthenticated endpoint. Structure
 * mirrors {@link ../quotes/YahooBarClient.ts} (`fetchFn` / `timeoutMs`
 * injected for testability, `AbortController` timeout, `fetch.bind(globalThis)`
 * so the Workers runtime doesn't throw "Illegal invocation").
 *
 * Confirmed-by-probe defensive requirements (see plan doc):
 *   - Rate limit is 1req/5s. Exceeding it returns HTTP 429 with a **plain
 *     text** body (not JSON).
 *   - Even a 200 can carry a non-JSON body (HTML error page observed in the
 *     wild) — `response.ok` alone is not sufficient. `content-type` must be
 *     checked before calling `.json()`, or the call throws a native
 *     `SyntaxError` instead of a typed, loggable error.
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

    // 200 does not guarantee a JSON body (rate-limit / upstream error pages
    // have been observed with a 200 status) — check content-type before
    // calling .json(), which would otherwise throw an untyped SyntaxError.
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

/**
 * Maps GDELT's `{ timeline: [{ series, data: [{ date, value }] }] }` shape
 * into our flat point list. We only ever request a single `mode`, so the
 * first series is the one we asked for. Forgiving normalization (mirrors
 * `BarClient.normalizeBars` / `YahooBarClient`'s drop-invalid-rows policy):
 * unparseable dates and non-finite values are dropped point-by-point rather
 * than failing the whole batch.
 */
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
