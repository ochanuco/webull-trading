import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'

/**
 * Webull JP tradable-instruments list (`GET /trade/instrument/tradable/list`).
 *
 * Trade host, x-version: v1, and no `/openapi` prefix — the `/openapi`-prefixed
 * or v2 form 404s at the gateway. App-level signing is enough (no account_id
 * / access token required; a token is attached best-effort like
 * `instrumentLookup`). Paginates via `last_security_id` (the prior page's
 * trailing `security_id`). The rate limit is tight enough that unthrottled
 * requests hit 429 within ~30 calls, so this throttles per-page and backs
 * off on 429.
 *
 * Callers must not clear the existing allowlist on a partial result
 * (`complete=false`) — that would misread as every symbol having disappeared.
 */

/** Normalized tradable instrument; raw JSON never leaves this layer. */
export interface TradableInstrumentEntry {
  symbol: string
  instrumentId: string | null
  name: string | null
  currency: string | null
  exchangeCode: string | null
}

export interface FetchTradableInstrumentsResult {
  outcome: 'ok' | 'error'
  /** Deduplicated by symbol. */
  instruments: TradableInstrumentEntry[]
  /** Whether pagination reached hasNext=false; false means a partial result. */
  complete: boolean
  pages: number
  /** Resume cursor (next last_security_id); undefined when complete=true, set on a maxPages cutoff or error. */
  nextCursor?: string
  error?: string
  status?: number | null
}

const TRADABLE_PATH = '/trade/instrument/tradable/list'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 10_000
/** Targets ~50 req/min to stay under the 429 threshold. */
const DEFAULT_THROTTLE_MS = 1_200
const RATE_LIMIT_BACKOFF_MS = 15_000
/** Hard cap against a runaway/infinite pagination loop. */
const MAX_PAGES = 200
const MAX_RATE_LIMIT_RETRIES = 4

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Webull returns instrument_id / security_id with a trailing .000000 — keep only the integer part. */
function trimDecimalId(v: unknown): string | null {
  const s = asString(v)
  if (s === null) return null
  const dot = s.indexOf('.')
  return dot === -1 ? s : s.slice(0, dot)
}

interface FetchInput {
  fetcher?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  throttleMs?: number
  /**
   * Called right after each page is normalized, with that page's entries.
   * Enables incremental upsert (a partial result is still visible/persisted)
   * and does not abort the sweep if it throws — one page's save failure
   * shouldn't kill the whole run.
   */
  onPage?: (entries: TradableInstrumentEntry[], pageIndex: number) => Promise<void>
  /** Resume cursor (a prior nextCursor); continues from that `last_security_id`. */
  startCursor?: string
  /** Cap on pages fetched in this chunk; hitting it returns complete=false + nextCursor instead of continuing. Defaults to MAX_PAGES. */
  maxPages?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchTradableInstruments(
  env: Env,
  input: FetchInput = {},
): Promise<FetchTradableInstrumentsResult> {
  const appKey = (env.WEBULL_APP_KEY ?? '').trim()
  const appSecret = (env.WEBULL_APP_SECRET ?? '').trim()
  if (appKey.length === 0 || appSecret.length === 0) {
    return {
      outcome: 'error',
      instruments: [],
      complete: false,
      pages: 0,
      error: 'Webull credentials 未設定',
      status: null,
    }
  }

  const baseUrl = (env.WEBULL_TRADE_API_BASE ?? '').trim() || DEFAULT_TRADE_API_BASE
  const accessToken = await resolveAccessToken(env).catch(() => undefined)
  const doFetch = input.fetcher ?? fetch
  const sleep = input.sleep ?? defaultSleep
  const throttleMs = input.throttleMs ?? DEFAULT_THROTTLE_MS

  const bySymbol = new Map<string, TradableInstrumentEntry>()
  let lastSecurityId: string | undefined = input.startCursor
  let pages = 0
  let rateLimitRetries = 0
  const pageLimit = Math.min(input.maxPages ?? MAX_PAGES, MAX_PAGES)

  for (;;) {
    if (pages >= pageLimit) {
      return {
        outcome: 'ok',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        ...(lastSecurityId !== undefined ? { nextCursor: lastSecurityId } : {}),
      }
    }

    const query: Record<string, string> = { page_size: String(PAGE_SIZE) }
    if (lastSecurityId !== undefined) query.last_security_id = lastSecurityId

    const url = new URL(TRADABLE_PATH, `${baseUrl}/`)
    url.searchParams.set('page_size', String(PAGE_SIZE))
    if (lastSecurityId !== undefined) url.searchParams.set('last_security_id', lastSecurityId)

    let response: Response
    try {
      const headers = await buildSignedHeaders({
        method: 'GET',
        path: url.pathname,
        query,
        host: url.host,
        appKey,
        appSecret,
        version: 'v1',
        ...(accessToken !== undefined ? { accessToken } : {}),
      })
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        response = await doFetch(url.href, {
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeoutId)
      }
    } catch (err) {
      return {
        outcome: 'error',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        error: err instanceof Error ? err.message : String(err),
        status: null,
      }
    }

    if (response.status === 429) {
      rateLimitRetries += 1
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        return {
          outcome: 'error',
          instruments: [...bySymbol.values()],
          complete: false,
          pages,
          error: '429 TOO_MANY_REQUESTS (backoff 上限超過)',
          status: 429,
        }
      }
      await sleep(RATE_LIMIT_BACKOFF_MS)
      continue
    }
    rateLimitRetries = 0

    const text = await response.text()
    if (response.status !== 200) {
      return {
        outcome: 'error',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        error: text.slice(0, 200),
        status: response.status,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        outcome: 'error',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        error: 'non-JSON response',
        status: response.status,
      }
    }

    const body = parsed as { hasNext?: unknown; instruments?: unknown }
    const rows = Array.isArray(body.instruments) ? body.instruments : []
    pages += 1

    const pageEntries: TradableInstrumentEntry[] = []
    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const symbol = asString(r.symbol)
      if (symbol === null) continue
      const entry: TradableInstrumentEntry = {
        symbol: symbol.toUpperCase(),
        instrumentId: trimDecimalId(r.instrument_id),
        name: asString(r.name),
        currency: asString(r.currency),
        exchangeCode: asString(r.exchange_code),
      }
      bySymbol.set(entry.symbol, entry)
      pageEntries.push(entry)
    }

    if (input.onPage && pageEntries.length > 0) {
      try {
        await input.onPage(pageEntries, pages - 1)
      } catch {
        // Non-fatal — the next sweep or a later page recovers it.
      }
    }

    const lastRow = rows.length > 0 ? (rows[rows.length - 1] as Record<string, unknown>) : undefined
    lastSecurityId = lastRow ? (asString(lastRow.security_id) ?? undefined) : undefined

    const hasNext = body.hasNext === true
    if (!hasNext || rows.length === 0 || lastSecurityId === undefined) {
      return {
        outcome: 'ok',
        instruments: [...bySymbol.values()],
        complete: true,
        pages,
      }
    }

    await sleep(throttleMs)
  }
}
