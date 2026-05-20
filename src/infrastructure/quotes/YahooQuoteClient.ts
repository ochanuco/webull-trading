import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { toYahooSymbol } from './YahooBarClient'
import type { QuoteResult, WebullQuoteCategory } from './WebullQuoteClient'

/**
 * Yahoo Finance backed quote (snapshot) client (#21 follow-up)。
 *
 * Webull JP 本番の market-data API (`data-api.webull.co.jp`) がまだ未公開
 * (DNS は存在するが TCP port 443 が応答せず、`api.webull.co.jp` 上の
 * `/openapi/market-data/*` も `404 Route Not Found`) のため、Webull market-data
 * が運用開始するまでの恒久 fallback として導入。`YahooBarClient` と同じ
 * `/v8/finance/chart` endpoint を使うので auth 不要・JP/US 両対応。
 *
 * Webull の市場制限 (UAT が SOXL を弾く等) も無いので staging E2E が回せる
 * メリットも大きい。
 */

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 5_000
// Yahoo は anonymous request を 429 で弾くので browser-like UA を付ける
// (YahooBarClient と同じ pattern)。
const DEFAULT_USER_AGENT = 'Mozilla/5.0'

/** `QuoteSnapshot.source` に書き込まれる値。dashboard / log で source 識別に使う。 */
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
  /** dashboard / log での source 識別ラベル。`runQuoteFeed` で QuoteSnapshot.source に転写される。 */
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

  /**
   * シンボルごとに `/v8/finance/chart/{symbol}?interval=1m&range=1d` を叩いて
   * `meta.regularMarketPrice` を current price として返す。Yahoo は category を
   * 知らないので _category は無視 (Webull 系の interface と互換性を保つため受ける
   * だけ)。
   *
   * 失敗した symbol は結果配列から除外 (Webull 側の `normalizeSnapshots` と同じ
   * 挙動)。caller は要求した symbol 数より少ない結果が返ってきたら個別 fallback
   * を考える。
   */
  async getSnapshots(symbols: string[], _category: WebullQuoteCategory): Promise<QuoteResult[]> {
    if (symbols.length === 0) return []
    // Yahoo の chart endpoint は per-symbol fan-out が必要 (batch snapshot は無い)。
    // Promise.all で並列化、個別失敗は許容 (skip)。
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
    // regularMarketTime は秒精度の epoch (Yahoo 慣例)。chart endpoint は最終取引
    // 時刻を返すので、市場外でも前日 close が乗る。`asOf` フィールドの ms 精度
    // ISO に揃える。
    const asOf =
      typeof meta?.regularMarketTime === 'number' && Number.isFinite(meta.regularMarketTime)
        ? new Date(meta.regularMarketTime * 1000).toISOString()
        : this.now().toISOString()
    return { symbol, price, asOf }
  }
}
