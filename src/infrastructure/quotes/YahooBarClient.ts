import type { DailyBar } from '../../trading/strategy/indicators'
import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { inferWebullMarket } from '../webull/mapper'
import type { BarClient } from './BarClient'

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 5_000
// Yahoo `/v8/finance/chart` blocks requests without a browser-like UA with
// "Edge: Too Many Requests" at the first call. Match the yfinance library's
// convention of sending a minimal Mozilla UA — no API key involved.
const DEFAULT_USER_AGENT = 'Mozilla/5.0'

export interface YahooBarClientOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  userAgent?: string
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        currency?: string
        regularMarketPrice?: number
      }
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>
          high?: Array<number | null>
          low?: Array<number | null>
          close?: Array<number | null>
        }>
      }
    }>
    error?: {
      code?: string
      description?: string
    } | null
  }
}

/**
 * Daily-bar client backed by Yahoo Finance's undocumented but stable
 * `query1.finance.yahoo.com/v8/finance/chart` endpoint.
 *
 * Works for both US (`SOXL`, `AAPL`) and JP (`7267.T`, `285A.T`) symbols
 * without authentication. A browser-like User-Agent is required; the
 * endpoint short-circuits anonymous requests with 429.
 *
 * Symbol convention:
 *   - JP symbols (4 char TSE code per `inferWebullMarket`) are suffixed
 *     with `.T` automatically. Callers pass the bare code.
 *   - Everything else is sent as-is.
 */
export class YahooBarClient implements BarClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly userAgent: string

  constructor(options: YahooBarClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Workers' global `fetch` must be bound to globalThis or it explodes with
    // "Illegal invocation" — mirrors WebullHttpClient.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  }

  async getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]> {
    if (!Number.isInteger(lookback) || lookback <= 0) {
      // rangeForLookback assumes a positive bucket, and `slice(-0)` /
      // `slice(-NaN)` both silently return the full array rather than the
      // requested window. Fail fast with a descriptive error so callers can't
      // accidentally ask for "all bars".
      throw new RangeError(
        `YahooBarClient.getDailyBars: lookback must be a positive integer, got ${lookback}`,
      )
    }
    const yahooSymbol = toYahooSymbol(symbol)
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`, this.baseUrl)
    url.searchParams.set('interval', '1d')
    url.searchParams.set('range', rangeForLookback(lookback))

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchFn(url.href, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
        signal: controller.signal,
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Yahoo bar fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw brokerErrorForStatus(
        response.status,
        `Yahoo bar request failed with status ${response.status}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
      )
    }

    const json = (await response.json()) as YahooChartResponse
    const bars = normalizeYahooChart(json, lookback)
    return bars
  }
}

/**
 * Convert a caller-side symbol into the Yahoo convention. JP TSE codes
 * need a `.T` suffix; everything else is unchanged.
 */
export function toYahooSymbol(symbol: string): string {
  if (symbol.includes('.')) return symbol // already qualified (e.g. 7267.T)
  if (inferWebullMarket(symbol) === 'JP') return `${symbol}.T`
  return symbol
}

/**
 * Yahoo `range` enum uses coarse bucket strings (`5d`, `1mo`, `3mo`, ...)
 * rather than an exact N-bar count. Pick the smallest bucket that covers
 * the requested lookback — downstream callers slice to exactly `lookback`.
 */
function rangeForLookback(lookback: number): string {
  if (lookback <= 5) return '5d'
  if (lookback <= 22) return '1mo'
  if (lookback <= 66) return '3mo'
  if (lookback <= 132) return '6mo'
  if (lookback <= 264) return '1y'
  if (lookback <= 528) return '2y'
  return '5y'
}

/**
 * Map Yahoo's columnar response into our row-based `DailyBar[]`. Yahoo
 * returns Unix-second timestamps and parallel OHLC arrays; skip any row
 * where one of the OHLC values is null (holidays, dividend adjustments).
 * Output is oldest-first, already the order Yahoo emits, to match the
 * downstream indicator expectations.
 */
function normalizeYahooChart(json: YahooChartResponse, lookback: number): DailyBar[] {
  const result = json.chart?.result?.[0]
  const timestamps = result?.timestamp
  const q = result?.indicators?.quote?.[0]
  if (!timestamps || !q) return []

  const opens = q.open ?? []
  const highs = q.high ?? []
  const lows = q.low ?? []
  const closes = q.close ?? []

  const bars: DailyBar[] = []
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = opens[i]
    const high = highs[i]
    const low = lows[i]
    const close = closes[i]
    // Drop any row that fails the repo-wide "price > 0 and finite" guarantee
    // (rejects null, NaN, Infinity, zero, and negatives in one guard).
    if (!isPositiveFinite(open) || !isPositiveFinite(high) || !isPositiveFinite(low) || !isPositiveFinite(close)) {
      continue
    }
    // Sanity check: Yahoo occasionally ships adjusted rows where `low > high`
    // around dividend events. A bar with that invariant broken is unreliable
    // for downstream indicators (ATR, etc.), so skip it.
    if (low > high) continue
    const ts = timestamps[i]
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
    const date = new Date(ts * 1000).toISOString().slice(0, 10)
    bars.push({ date, open, high, low, close })
  }

  // Yahoo returns oldest-first; enforce the invariant and cap to lookback
  // so callers get the shape they asked for.
  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars.slice(-lookback)
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
