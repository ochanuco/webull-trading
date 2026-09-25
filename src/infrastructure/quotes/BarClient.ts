import type { DailyBar } from '../../trading/strategy/indicators'
import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { WebullAuth } from '../webull/WebullAuth'
import { inferWebullMarket } from '../webull/mapper'

// Underscored to match the SDKs' enum `.name` on the wire, not the
// hyphenated form shown in the docs UI.
type BarCategory = 'US_STOCK' | 'US_ETF' | 'JP_STOCK'

// Kept in sync with WebullQuoteClient's US ETF allowlist.
const US_ETF_SYMBOLS = new Set<string>(['SOXL', 'SOXS'])

function resolveBarCategory(symbol: string): BarCategory {
  if (inferWebullMarket(symbol) === 'JP') return 'JP_STOCK'
  return US_ETF_SYMBOLS.has(symbol) ? 'US_ETF' : 'US_STOCK'
}

/** Matches Yahoo `/v8/finance/chart`'s `interval` enum. */
export type IntradayInterval = '5m' | '15m' | '30m' | '60m'

/** `timestamp` is ISO UTC at second precision. */
export interface IntradayBar {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
}

export interface BarClient {
  getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]>
  /** Optional: a client without intraday support can omit it and callers fall back to daily close. */
  getIntradayBars?(symbol: string, interval: IntradayInterval): Promise<IntradayBar[]>
}

interface WebullBarClientEnv {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  /** Falls back to `DEFAULT_QUOTES_API_BASE` when unset/blank; set for environments where quotes and trade hosts differ (e.g. UAT). */
  WEBULL_QUOTES_API_BASE?: string
  /** See `WebullClientEnv.WEBULL_ACCESS_TOKEN`. */
  WEBULL_ACCESS_TOKEN?: string
  WEBULL_BARS_PATH?: string
}

interface WebullBarClientOptions {
  auth: WebullAuth
  baseUrl: string
  barsPath?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}

/**
 * Webull market-data bars client (daily + intraday). Malformed bars (missing
 * OHLC fields) are dropped rather than thrown on.
 */
export class WebullBarClient implements BarClient {
  private readonly baseUrl: string
  private readonly barsPath: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: WebullBarClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    // v1 (`/openapi/market-data/bars`) 404s on the JP UAT tenant; v2 works everywhere observed.
    this.barsPath = options.barsPath ?? '/openapi/market-data/stock/bars'
    this.timeoutMs = options.timeoutMs ?? 5_000
    // Unbound global `fetch` throws "Illegal invocation" in Workers.
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  }

  async getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]> {
    return normalizeBars(await this.requestBars(symbol, 'D', lookback))
  }

  async getIntradayBars(symbol: string, interval: IntradayInterval): Promise<IntradayBar[]> {
    const timespan = { '5m': 'M5', '15m': 'M15', '30m': 'M30', '60m': 'M60' }[interval]
    // Only the latest bar's close is consumed, but 8 bars keeps parity with
    // the Yahoo client's same-day coverage (60m × 8 ≈ 1 trading day).
    return normalizeIntradayBars(await this.requestBars(symbol, timespan, 8))
  }

  private async requestBars(symbol: string, timespan: string, count: number): Promise<unknown> {
    const category = resolveBarCategory(symbol)
    // Daily timespan is "D" (uppercase) — lowercase `d1` returns UNSUPPORTED_TIMESPAN.
    //
    // real_time_required is sent explicitly (matching the server's own
    // default) so a future server-side default change can't silently alter
    // what bars we receive.
    const query = {
      symbol,
      category,
      timespan,
      count: String(count),
      real_time_required: 'true',
    }

    const url = new URL(this.barsPath, `${this.baseUrl}/`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

    let headers: Record<string, string>
    try {
      headers = await this.options.auth.createHeaders({
        method: 'GET',
        // path must be pathname-only: query is merged separately into the
        // canonical sorted pairs, so passing `pathname + search` duplicates it.
        path: url.pathname,
        query,
        host: url.host,
        version: 'v2',
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
      throw brokerErrorForStatus(
        response.status,
        `Webull bar request failed with status ${response.status}`,
        `GET ${this.barsPath}`,
      )
    }

    return (await response.json()) as unknown
  }
}

// Same host as WebullQuoteClient — production market-data lives on the trade host.
const DEFAULT_QUOTES_API_BASE = 'https://api.webull.co.jp'

function createWebullBarClient(
  env: WebullBarClientEnv,
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    /** Overrides `env.WEBULL_ACCESS_TOKEN`; callers pass the DO-managed token when available. */
    accessToken?: string
  },
): WebullBarClient {
  const baseUrl = env.WEBULL_QUOTES_API_BASE?.trim() || DEFAULT_QUOTES_API_BASE
  return new WebullBarClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
      accessToken: options?.accessToken ?? env.WEBULL_ACCESS_TOKEN,
    }),
    baseUrl,
    barsPath: env.WEBULL_BARS_PATH,
    fetchFn: options?.fetchFn,
    timeoutMs: options?.timeoutMs,
  })
}

interface RawBar {
  // Different endpoint versions/surfaces name the timestamp field
  // differently; all three are accepted (see extractDate/extractTimestamp).
  time?: string
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
    const date = extractDate(raw)
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

function extractDate(raw: RawBar): string {
  if (typeof raw.date === 'string' && raw.date.length >= 10) return raw.date
  if (typeof raw.time === 'string' && raw.time.length >= 10) return raw.time.slice(0, 10)
  if (typeof raw.trade_time === 'string' && raw.trade_time.length >= 10) return raw.trade_time.slice(0, 10)
  return ''
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

function normalizeIntradayBars(json: unknown): IntradayBar[] {
  const rawList = extractList(json)
  const bars: IntradayBar[] = []
  for (const raw of rawList) {
    const timestamp = extractTimestamp(raw)
    const open = toNumber(raw.open)
    const high = toNumber(raw.high)
    const low = toNumber(raw.low)
    const close = toNumber(raw.close)
    if (!timestamp || open === null || high === null || low === null || close === null) continue
    bars.push({ timestamp, open, high, low, close })
  }
  // Oldest-first: pullbackScheduler treats the last element as the latest bar.
  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return bars
}

function extractTimestamp(raw: RawBar): string {
  // Normalizes to the same ISO-UTC-seconds shape YahooBarClient produces.
  const value = raw.time ?? raw.trade_time ?? raw.date
  if (typeof value !== 'string' || value.length < 10) return ''
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

import { YahooBarClient } from './YahooBarClient'
import { resolveAccessToken } from '../webull/resolveAccessToken'
import type { Env } from '../../config/env'

// `^` index symbols aren't in Webull's instrument universe; JP symbols need
// a quotes subscription the current contract doesn't have. Both go straight to Yahoo.
function isWebullBarUnsupported(symbol: string): boolean {
  return symbol.startsWith('^') || inferWebullMarket(symbol) === 'JP'
}

/** Webull primary + Yahoo fallback, mirroring quoteScheduler's fail-safe policy. */
export class FallbackBarClient implements BarClient {
  constructor(
    private readonly primary: WebullBarClient,
    private readonly fallback: YahooBarClient,
  ) {}

  async getDailyBars(symbol: string, lookback: number): Promise<DailyBar[]> {
    if (isWebullBarUnsupported(symbol)) return this.fallback.getDailyBars(symbol, lookback)
    try {
      return await this.primary.getDailyBars(symbol, lookback)
    } catch {
      return this.fallback.getDailyBars(symbol, lookback)
    }
  }

  async getIntradayBars(symbol: string, interval: IntradayInterval): Promise<IntradayBar[]> {
    if (isWebullBarUnsupported(symbol)) return this.fallback.getIntradayBars(symbol, interval)
    try {
      return await this.primary.getIntradayBars(symbol, interval)
    } catch {
      return this.fallback.getIntradayBars(symbol, interval)
    }
  }
}

// Mirrors QUOTE_SOURCE's convention (fail-safe default, opt-in switch) but
// as its own flag so bars and quotes can be canaried independently.
export async function selectBarClient(env: Env): Promise<BarClient> {
  if ((env.BAR_SOURCE ?? '').trim().toLowerCase() === 'webull') {
    // Build the client even if token resolution fails — a missing token
    // surfaces as a per-call broker rejection, which FallbackBarClient
    // already turns into a Yahoo retry.
    const accessToken = await resolveAccessToken(env).catch(() => undefined)
    return new FallbackBarClient(
      createWebullBarClient(env, {
        ...(accessToken !== undefined ? { accessToken } : {}),
      }),
      new YahooBarClient(),
    )
  }
  return new YahooBarClient()
}
