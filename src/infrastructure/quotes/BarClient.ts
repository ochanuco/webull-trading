import type { DailyBar } from '../../trading/strategy/indicators'
import { BrokerRequestError } from '../../shared/errors'
import { WebullAuth } from '../webull/WebullAuth'
import { inferWebullMarket } from '../webull/mapper'

// developer.webull.com shows `category=US_STOCK` on the wire (underscore).
// Python SDK's EasyEnum.__str__ returns `self.name` (the underscored
// identifier), and Java SDK passes `Category.US_STOCK.name()` the same way.
// JP_STOCK has no working HK-sandbox path — JP bars need a JP tenant (#89).
export type BarCategory = 'US_STOCK' | 'US_ETF' | 'JP_STOCK'

// Mirrors WebullQuoteClient's US ETF allowlist.
const US_ETF_SYMBOLS = new Set<string>(['SOXL', 'SOXS'])

function resolveBarCategory(symbol: string): BarCategory {
  if (inferWebullMarket(symbol) === 'JP') return 'JP_STOCK'
  return US_ETF_SYMBOLS.has(symbol) ? 'US_ETF' : 'US_STOCK'
}

export interface BarClient {
  getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]>
}

export interface WebullBarClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_API_BASE?: string
  WEBULL_BARS_PATH?: string
}

interface WebullBarClientOptions {
  auth: WebullAuth
  baseUrl?: string
  barsPath?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

/**
 * Minimal daily-bar client. The Webull JP UAT bar endpoint is not yet verified
 * from this POC, so the path is overridable via env (`WEBULL_BARS_PATH`) and
 * the response mapper is forgiving — any bar missing a usable close is
 * filtered out instead of throwing. Once the production path is known, this
 * client can be locked down.
 */
export class WebullBarClient implements BarClient {
  private readonly baseUrl: string
  private readonly barsPath: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: WebullBarClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.sandbox.webull.hk').replace(/\/+$/, '')
    // openapi-java-sdk's HttpQuotesApiClient.getBars uses
    // `/openapi/market-data/bars` with v1. Historical default here was
    // `/market-data/candles` which has no /openapi prefix and the wrong
    // resource name (`candles`). Update to SDK-accurate default.
    this.barsPath = options.barsPath ?? '/openapi/market-data/bars'
    this.timeoutMs = options.timeoutMs ?? 5_000
    // Workers の global `fetch` はメソッド呼び出し扱いで `this` を globalThis
    // にひも付けないと "Illegal invocation" で落ちる。明示的に bind しておく。
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  async getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]> {
    const category = resolveBarCategory(symbol)
    // Java SDK (HttpQuotesApiClient.getBars) uses `timespan` + `count`, not
    // `period` + `limit`. The category goes on the wire as the underscored
    // identifier per developer.webull.com example + Python SDK __str__.
    const query = {
      symbol,
      category,
      timespan: 'd1',
      count: String(lookback),
    }

    const url = new URL(this.barsPath, `${this.baseUrl}/`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

    let headers: Record<string, string>
    try {
      headers = await this.options.auth.createHeaders({
        method: 'GET',
        // Signing is path-only; query is merged into the canonical sorted pairs.
        // Passing `pathname + search` duplicates query params (same bug as #80).
        path: url.pathname,
        query,
        host: url.host,
        version: 'v1',
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull bar auth failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${this.barsPath}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull bar fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${this.barsPath}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new BrokerRequestError(
        `Webull bar request failed with status ${response.status}`,
        `GET ${this.barsPath}`,
      )
    }

    return normalizeBars((await response.json()) as unknown)
  }
}

export function createWebullBarClient(
  env: WebullBarClientEnv,
  options?: { fetchFn?: typeof fetch; timeoutMs?: number },
): WebullBarClient {
  return new WebullBarClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
    }),
    baseUrl: env.WEBULL_API_BASE,
    barsPath: env.WEBULL_BARS_PATH,
    fetchFn: options?.fetchFn,
    timeoutMs: options?.timeoutMs,
  })
}

interface RawBar {
  date?: string
  trade_time?: string
  open?: number | string
  high?: number | string
  low?: number | string
  close?: number | string
}

function normalizeBars(json: unknown): DailyBar[] {
  const rawList = extractList(json)
  const bars: DailyBar[] = []
  for (const raw of rawList) {
    const date = typeof raw.date === 'string' ? raw.date : typeof raw.trade_time === 'string' ? raw.trade_time.slice(0, 10) : ''
    const open = toNumber(raw.open)
    const high = toNumber(raw.high)
    const low = toNumber(raw.low)
    const close = toNumber(raw.close)
    if (!date || open === null || high === null || low === null || close === null) continue
    bars.push({ date, open, high, low, close })
  }
  // Ensure oldest-first for downstream indicators.
  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars
}

function extractList(json: unknown): RawBar[] {
  if (Array.isArray(json)) return json as RawBar[]
  if (json && typeof json === 'object') {
    const data = (json as { data?: unknown }).data
    if (Array.isArray(data)) return data as RawBar[]
  }
  return []
}

function toNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}
