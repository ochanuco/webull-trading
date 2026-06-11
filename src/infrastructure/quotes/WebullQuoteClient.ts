import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { WebullAuth } from '../webull/WebullAuth'
import { inferWebullMarket } from '../webull/mapper'

// Webull market-data snapshot endpoint only accepts equity/ETF categories.
// JP_STOCK is NOT supported here — JP quotes require a separate API path we
// haven't wired yet. See #84.
export type WebullQuoteCategory = 'US_STOCK' | 'US_ETF'

// Minimal US ETF allowlist for the POC universe. Expand or move to
// symbol_config.category when universe grows.
const US_ETF_SYMBOLS = new Set<string>(['SOXL', 'SOXS'])


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
  /**
   * Quotes host override。**JP 本番の Market Data API は trade host
   * (`api.webull.co.jp`) + x-version v2 で稼働** (docs 明記 + PR #474 実測、
   * #475)。「data-api.webull.co.jp に分離」は誤った前提だった。未設定 / 空 /
   * whitespace なら trade host default に fallback。JP UAT (ALB 1 host 束ね)
   * のみ explicit override を使う。
   */
  WEBULL_QUOTES_API_BASE?: string
  /** 2FA 発行 `x-access-token` (#21)。詳細は `WebullClientEnv.WEBULL_ACCESS_TOKEN`。 */
  WEBULL_ACCESS_TOKEN?: string
  /**
   * Optional override for the snapshot endpoint path. Webull UAT endpoints are
   * not finalised for this POC, so the path is kept configurable per
   * environment. Defaults to {@link DEFAULT_QUOTE_PATH}.
   */
  WEBULL_QUOTE_PATH?: string
}

interface WebullQuoteClientOptions {
  auth: WebullAuth
  baseUrl: string
  quotePath?: string
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

// Confirmed working combination on the JP UAT tenant (our `WEBULL_QUOTES_API_BASE`
// resolves to jp-openapi-alb.uat.webullbroker.com — the JP UAT ALB which serves
// trade/quotes/events from a single host; JP 本番では `data-api.webull.co.jp`
// に分離される):
// - path `/openapi/market-data/stock/snapshot`
// - x-version: v2
// - category: US_ETF / US_STOCK (underscore — matches EasyEnum.__str__ = name)
// - `extend_hour_required=false` + `overnight_required=false` REQUIRED
//   (omitting them → 417 Expectation Failed; see probe trace in #84)
const DEFAULT_QUOTE_PATH = '/openapi/market-data/stock/snapshot'
/**
 * Webull JP **production** の Market Data API host (#475)。docs (market-data-api/
 * data-api) の明記どおり trade host と同一。旧値 `data-api.webull.co.jp` は
 * SDK region=jp の公開値だが TCP 無応答で、そもそも market-data を serve して
 * いなかった (2026-06-11 実測, PR #474)。UAT (1 ホスト束ね) は
 * `WEBULL_QUOTES_API_BASE` env で override する。
 */
const DEFAULT_QUOTES_API_BASE = 'https://api.webull.co.jp'

/** QuoteSnapshot.source / spread guard の判定キー。 */
export const WEBULL_QUOTE_SOURCE = 'webull-snapshot'

/**
 * Minimal Webull market-data snapshot client. Signs requests with the same
 * HMAC canonical signing used by {@link WebullHttpClient}. Read-only
 * last-price + bid/ask + asOf so the cron handler can land a
 * {@link QuoteSnapshot} into each symbol's Durable Object.
 *
 * 2026-05-22 に deprecated 化 (market-data 未稼働と誤認、PR #334 で Yahoo へ) →
 * **2026-06-11 に解除** (#475): 正しい host (trade host + v2) で稼働確認済み。
 * `QUOTE_SOURCE=webull` で primary に戻る。bid/ask が実データになるため
 * spread guard (issue #411) が実数評価になる。
 */
export class WebullQuoteClient {
  readonly source = WEBULL_QUOTE_SOURCE
  private readonly baseUrl: string
  private readonly quotePath: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly now: () => Date

  constructor(private readonly options: WebullQuoteClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.quotePath = options.quotePath ?? DEFAULT_QUOTE_PATH
    this.timeoutMs = options.timeoutMs ?? 5000
    // Workers の global `fetch` はメソッド呼び出し扱いで `this` を globalThis
    // にひも付けないと "Illegal invocation" で落ちる。明示的に bind しておく。
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.now = options.now ?? (() => new Date())
  }

  async getSnapshots(symbols: string[], category: WebullQuoteCategory): Promise<QuoteResult[]> {
    if (symbols.length === 0) return []

    // v2 snapshot requires `extend_hour_required` + `overnight_required` —
    // omitting them returns 417 Expectation Failed. We don't want extended
    // or overnight data for the Pullback strategy (daytime cash equity only).
    const query = {
      symbols: symbols.join(','),
      category,
      extend_hour_required: 'false',
      overnight_required: 'false',
    }
    const url = new URL(this.quotePath, `${this.baseUrl}/`)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }

    let authHeaders: Record<string, string>
    try {
      authHeaders = await this.options.auth.createHeaders({
        method: 'GET',
        // Signing is path-only; query is merged into canonical sorted pairs.
        // Passing `pathname + search` would duplicate query params (see #80).
        path: url.pathname,
        query,
        host: url.host,
        // JP UAT only exposes the v2 snapshot; v1 /market-data/snapshot → 404.
        version: 'v2',
      })
    } catch (error) {
      throw new BrokerRequestError(
        `Webull quote auth failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${this.quotePath}`,
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
        `GET ${this.quotePath}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw brokerErrorForStatus(
        response.status,
        `Webull quote request failed with status ${response.status}`,
        `GET ${this.quotePath}`,
      )
    }

    try {
      const json = (await response.json()) as unknown
      return normalizeSnapshots(json, this.now().toISOString())
    } catch (error) {
      throw new BrokerRequestError(
        `Webull quote response parse failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET ${this.quotePath}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }
  }
}

export function createWebullQuoteClient(
  env: WebullQuoteClientEnv,
  options?: {
    fetchFn?: typeof fetch
    timeoutMs?: number
    now?: () => Date
    /** Phase B: resolveAccessToken 由来の override (DO 優先)。 */
    accessToken?: string
  },
): WebullQuoteClient {
  // env 空 / undefined / whitespace は JP prod default。env が明示されてれば
  // override (UAT / 将来 region 用)。
  const baseUrl = env.WEBULL_QUOTES_API_BASE?.trim() || DEFAULT_QUOTES_API_BASE
  return new WebullQuoteClient({
    auth: new WebullAuth({
      appKey: env.WEBULL_APP_KEY,
      appSecret: env.WEBULL_APP_SECRET,
      accessToken: options?.accessToken ?? env.WEBULL_ACCESS_TOKEN,
    }),
    baseUrl,
    quotePath: env.WEBULL_QUOTE_PATH,
    timeoutMs: options?.timeoutMs,
    fetchFn: options?.fetchFn,
    now: options?.now,
  })
}

export interface SymbolGrouping {
  grouped: Record<WebullQuoteCategory, string[]>
  // Symbols that cannot be routed through the US snapshot endpoint
  // (currently JP — tracked separately so callers can log / skip).
  unsupported: string[]
}

export function groupSymbolsByCategory(symbols: string[]): SymbolGrouping {
  const grouped: Record<WebullQuoteCategory, string[]> = { US_STOCK: [], US_ETF: [] }
  const unsupported: string[] = []
  for (const symbol of symbols) {
    if (inferWebullMarket(symbol) === 'JP') {
      unsupported.push(symbol)
      continue
    }
    const category: WebullQuoteCategory = US_ETF_SYMBOLS.has(symbol) ? 'US_ETF' : 'US_STOCK'
    grouped[category].push(symbol)
  }
  return { grouped, unsupported }
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