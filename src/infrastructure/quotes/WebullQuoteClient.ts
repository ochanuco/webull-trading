import { BrokerRequestError } from '../../shared/errors'
import { WebullAuth } from '../webull/WebullAuth'
import { inferWebullMarket } from '../webull/mapper'

export type WebullQuoteCategory = 'US_STOCK' | 'JP_STOCK'

export interface QuoteResult {
  symbol: string
  price: number
  asOf: string
  bid?: number
  ask?: number
}

export interface WebullQuoteClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_API_BASE?: string
}

interface WebullQuoteClientOptions {
  auth: WebullAuth
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  now?: () => Date
}

interface RawSnapshotEntry {
  symbol?: string
  last_price?: number | string
  last?: number | string
  price?: number | string
  trade_time?: string
  timestamp?: number | string
  bid?: number | string
  ask?: number | string
  bid_price?: number | string
  ask_price?: number | string
  bp?: number | string
  ap?: number | string
}

const QUOTE_PATH = '/market-data/snapshot'

/**
 * Minimal Webull market-data snapshot client. Signs requests with the same
 * HMAC-SHA1 canonical signing used by {@link WebullHttpClient}. Scope for #37-B
 * is read-only last-price + asOf so the cron handler can land a
 * {@link QuoteSnapshot} into each symbol's Durable Object.
 */
export class WebullQuoteClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: WebullQuoteClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.sandbox.webull.hk').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 5000
    this.fetchFn = options.fetchFn ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  async getSnapshots(symbols: string[], category: WebullQuoteCategory): Promise<QuoteResult[]> {
    if (symbols.length === 0) return []

    const query = { symbols: symbols.join(','), category }
    const url = new URL(QUOTE_PATH, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }

    let authHeaders: Record<string, string>
    try {
      authHeaders = await this.options.auth.createHeaders({
        method: 'GET',
        path: url.pathname + url.search,
        query,
        host: url.host,
        version: 'v1',
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull quote auth failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${QUOTE_PATH}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders },
        signal: controller.signal,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull quote fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${QUOTE_PATH}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new BrokerRequestError(
        `Webull quote request failed with status ${response.status}`,
        `GET ${QUOTE_PATH}`,
      )
    }

    try {
      const json = (await response.json()) as unknown
      return normalizeSnapshots(json, this.now().toISOString())
    } catch (error) {
      throw new BrokerRequestError(
        `Webull quote response parse failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${QUOTE_PATH}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
  }
}

export function createWebullQuoteClient(
  env: WebullQuoteClientEnv,
  options?: { fetchFn?: typeof fetch; timeoutMs?: number; now?: () => Date },
): WebullQuoteClient {
  return new WebullQuoteClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
    }),
    baseUrl: env.WEBULL_API_BASE,
    timeoutMs: options?.timeoutMs,
    fetchFn: options?.fetchFn,
    now: options?.now,
  })
}

export function groupSymbolsByCategory(symbols: string[]): Record<WebullQuoteCategory, string[]> {
  const grouped: Record<WebullQuoteCategory, string[]> = { US_STOCK: [], JP_STOCK: [] }
  for (const symbol of symbols) {
    const category: WebullQuoteCategory = inferWebullMarket(symbol) === 'JP' ? 'JP_STOCK' : 'US_STOCK'
    grouped[category].push(symbol)
  }
  return grouped
}

function normalizeSnapshots(json: unknown, fallbackAsOf: string): QuoteResult[] {
  const rawList = extractList(json)
  const results: QuoteResult[] = []
  for (const raw of rawList) {
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : ''
    const price = coerceNumber(raw.last_price ?? raw.last ?? raw.price)
    if (!symbol || price === null) continue
    const bid = coerceFirstValidNumber(raw.bid, raw.bid_price, raw.bp)
    const ask = coerceFirstValidNumber(raw.ask, raw.ask_price, raw.ap)
    const entry: QuoteResult = { symbol, price, asOf: coerceAsOf(raw, fallbackAsOf) }
    if (bid !== null) entry.bid = bid
    if (ask !== null) entry.ask = ask
    results.push(entry)
  }
  return results
}

function extractList(json: unknown): RawSnapshotEntry[] {
  if (Array.isArray(json)) return json as RawSnapshotEntry[]
  if (json && typeof json === 'object') {
    const data = (json as { data?: unknown }).data
    if (Array.isArray(data)) return data as RawSnapshotEntry[]
  }
  return []
}

function coerceNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num > 0 ? num : null
}

function coerceFirstValidNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const result = coerceNumber(value as number | string | undefined)
    if (result !== null) return result
  }
  return null
}

function coerceAsOf(raw: RawSnapshotEntry, fallback: string): string {
  if (typeof raw.trade_time === 'string' && raw.trade_time.trim().length > 0) return raw.trade_time.trim()
  if (raw.timestamp !== undefined) {
    const ms = typeof raw.timestamp === 'number' ? raw.timestamp : Number(raw.timestamp)
    if (Number.isFinite(ms)) {
      const millis = ms > 1e12 ? ms : ms * 1000
      return new Date(millis).toISOString()
    }
  }
  return fallback
}