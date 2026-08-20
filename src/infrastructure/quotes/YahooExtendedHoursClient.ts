import { BrokerRequestError, brokerErrorForStatus } from '../../shared/errors'
import { toYahooSymbol } from './YahooBarClient'

/**
 * Yahoo extended-hours (pre-market) 1-minute bar client (issue #709 Phase 1)。
 *
 * `YahooQuoteClient` / `YahooBarClient` と同じ `/v8/finance/chart` endpoint
 * (auth 不要) だが `includePrePost=true&interval=1m` で当日のプレマーケット
 * bar 列を取る。取引経路には接続しない参考観測専用 (`extendedHoursScheduler`
 * の doc comment 参照)。
 */

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 5_000
// Yahoo は anonymous request を 429 で弾くので browser-like UA を付ける
// (YahooBarClient / YahooQuoteClient と同じ pattern)。
const DEFAULT_USER_AGENT = 'Mozilla/5.0'
// `currentTradingPeriod.pre` が欠けたときの fallback 下限。`ts < regular.start`
// だけだと `range=1d` レスポンスに前セッションの bar (regular/post) が混ざった
// 場合に全部プレマーケット扱いになり `preMarketLow` が前日安値で汚染される。
// US プレマーケットは 04:00 ET 開始 (開場 5.5h 前) なので 6h より古い bar は
// 前セッション残りとみなして捨てる。
const PREMARKET_FALLBACK_LOOKBACK_SEC = 6 * 60 * 60

export interface YahooExtendedHoursClientOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  userAgent?: string
  now?: () => Date
}

export interface PreMarketBar {
  /** bar 時刻 (ISO UTC)。 */
  at: string
  close: number
  low: number | null
}

export interface PreMarketSeries {
  symbol: string
  /** 前日終値。`meta.previousClose` が無効なら `chartPreviousClose` に fallback、両方無効なら null。 */
  prevClose: number | null
  bars: PreMarketBar[]
  fetchedAt: string
}

interface YahooChartTradingPeriod {
  start?: number
  end?: number
}

interface YahooChartMeta {
  regularMarketPrice?: number
  previousClose?: number
  chartPreviousClose?: number
  currentTradingPeriod?: {
    pre?: YahooChartTradingPeriod
    regular?: YahooChartTradingPeriod
    post?: YahooChartTradingPeriod
  }
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: YahooChartMeta
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>
          low?: Array<number | null>
        }>
      }
    }>
    error?: { code?: string; description?: string } | null
  }
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export class YahooExtendedHoursClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchFn: typeof fetch
  private readonly userAgent: string
  private readonly now: () => Date

  constructor(options: YahooExtendedHoursClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT
    this.now = options.now ?? (() => new Date())
  }

  /**
   * `/v8/finance/chart/{symbol}?interval=1m&range=1d&includePrePost=true` を
   * 叩き、当日のプレマーケット bar 列を返す。`currentTradingPeriod.pre` が
   * あればその窓 `[start, end)` で bar を絞り込み、無ければ
   * `[regular.start - 6h, regular.start)` の bar を pre-market とみなす
   * フォールバックを使う。レスポンス欠損 (`result` 無し等) は null。
   * fetch / HTTP / parse 失敗のみ throw する (`YahooQuoteClient` と同じ)。
   */
  async getPreMarketSeries(symbol: string): Promise<PreMarketSeries | null> {
    const yahooSymbol = toYahooSymbol(symbol)
    const url = new URL(`/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`, this.baseUrl)
    url.searchParams.set('interval', '1m')
    url.searchParams.set('range', '1d')
    url.searchParams.set('includePrePost', 'true')

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
        `Yahoo extended-hours fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
        { cause: error instanceof Error ? error : undefined },
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw brokerErrorForStatus(
        response.status,
        `Yahoo extended-hours request failed with status ${response.status}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
      )
    }

    let json: YahooChartResponse
    try {
      json = (await response.json()) as YahooChartResponse
    } catch (error) {
      throw new BrokerRequestError(
        `Yahoo extended-hours response parse failed: ${error instanceof Error ? error.message : String(error)}`,
        `GET /v8/finance/chart/${yahooSymbol}`,
        { cause: error instanceof Error ? error : undefined },
      )
    }

    const result = json.chart?.result?.[0]
    const meta = result?.meta
    const timestamps = result?.timestamp
    const quote = result?.indicators?.quote?.[0]
    if (!meta || !timestamps || !quote) return null

    const closes = quote.close ?? []
    const lows = quote.low ?? []

    const pre = meta.currentTradingPeriod?.pre
    const hasPreWindow = typeof pre?.start === 'number' && typeof pre?.end === 'number'
    const regularStart = meta.currentTradingPeriod?.regular?.start

    const bars: PreMarketBar[] = []
    for (let i = 0; i < timestamps.length; i += 1) {
      const ts = timestamps[i]
      if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
      const inPreWindow = hasPreWindow
        ? ts >= pre!.start! && ts < pre!.end!
        : typeof regularStart === 'number'
          ? ts < regularStart && ts >= regularStart - PREMARKET_FALLBACK_LOOKBACK_SEC
          : false
      if (!inPreWindow) continue
      const close = closes[i]
      if (!isPositiveFinite(close)) continue
      const low = lows[i]
      bars.push({
        at: new Date(ts * 1000).toISOString(),
        close,
        low: isPositiveFinite(low) ? low : null,
      })
    }
    bars.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

    const prevClose = isPositiveFinite(meta.previousClose)
      ? meta.previousClose
      : isPositiveFinite(meta.chartPreviousClose)
        ? meta.chartPreviousClose
        : null

    return {
      symbol,
      prevClose,
      bars,
      fetchedAt: this.now().toISOString(),
    }
  }
}
