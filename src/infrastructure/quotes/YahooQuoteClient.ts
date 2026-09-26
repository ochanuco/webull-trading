import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { toYahooSymbol } from './YahooBarClient'
import type { QuoteResult, WebullQuoteCategory } from './WebullQuoteClient'

// Uses the same unauthenticated `/v8/finance/chart` endpoint as
// YahooBarClient — no Webull market-data availability dependency, and no
// Webull-side symbol restrictions (e.g. UAT rejecting SOXL) blocking staging E2E.

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 5_000
// Yahoo returns 429 for requests without a browser-like UA.
const DEFAULT_USER_AGENT = 'Mozilla/5.0'

export const YAHOO_QUOTE_SOURCE = 'yahoo-snapshot'

export interface YahooQuoteClientOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  userAgent?: string
  now?: () => Date
}

interface YahooChartMeta {
  symbol?: string
  regularMarketPrice?: number
  regularMarketTime?: number
  currency?: string
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{ meta?: YahooChartMeta }>
    error?: { code?: string; description?: string } | null
  }
}

export class YahooQuoteClient {
  readonly source = YAHOO_QUOTE_SOURCE

  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly userAgent: string
  private readonly now: () => Date

  constructor(options: YahooQuoteClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.now = options.now ?? (() => new Date())
  }

  // `_category` is accepted-but-ignored to keep this interface-compatible
  // with the Webull client — Yahoo has no equivalent concept.
  async getSnapshots(symbols: string[], _category: WebullQuoteCategory): Promise<QuoteResult[]> {
    if (symbols.length === 0) return []
    // Yahoo's chart endpoint has no batch snapshot; fan out per symbol and drop individual failures.
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          return await this.fetchOne(symbol)
        } catch {
          return null
        }
      }),
    )
    return results.filter((r): r is QuoteResult => r !== null)
  }

  private async fetchOne(symbol: string): Promise<QuoteResult | null> {
    const yahooSymbol = toYahooSymbol(symbol)
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`, this.baseUrl)
    url.searchParams.set('interval', '1m')
    url.searchParams.set('range', '1d')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
        signal: controller.signal,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Yahoo quote fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw brokerErrorForStatus(
        response.status,
        `Yahoo quote request failed with status ${response.status}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
      )
    }

    let json: YahooChartResponse
    try {
      json = (await response.json()) as YahooChartResponse
    } catch (error) {
      throw new BrokerRequestError(
        `Yahoo quote response parse failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    const meta = json.chart?.result?.[0]?.meta
    const price = meta?.regularMarketPrice
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      return null
    }
    // regularMarketTime is the last-trade time (may be a prior close when
    // markets are closed), Unix seconds — converted to ms-precision ISO.
    const asOf =
      typeof meta?.regularMarketTime === 'number' && Number.isFinite(meta.regularMarketTime)
        ? new Date(meta.regularMarketTime * 1000).toISOString()
        : this.now().toISOString()
    return { symbol, price, asOf }
  }
}
