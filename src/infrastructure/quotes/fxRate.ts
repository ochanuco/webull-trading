// Used to convert JPY budget allocation into USD notional for USD symbols.
// Fail-safe by design, since it feeds real-money sizing: fetch failure,
// non-finite, or out-of-range results all return null (never throw) so
// callers fail-closed rather than size against a bad rate.

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_USER_AGENT = 'Mozilla/5.0'
const FX_SYMBOL = 'USDJPY=X'
// Historical range is ~75-160; 50-500 gives a wide safety margin against
// bad data (zero, wrong magnitude, wrong pair) while never rejecting a real rate.
const MIN_RATE = 50
const MAX_RATE = 500

export interface UsdJpyRateOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  userAgent?: string
  /** 構造化ログの追跡 ID (cron tick の requestId を伝搬)。 */
  requestId?: string
}

interface YahooChartMetaResponse {
  chart?: {
    result?: Array<{ meta?: { regularMarketPrice?: number } }>
  }
}

/** 1 USD = N JPY. Never throws — see module header for the fail-safe rationale. */
export async function loadUsdJpyRate(options: UsdJpyRateOptions = {}): Promise<number | null> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  const requestId = options.requestId

  const url = new URL(`/v8/finance/chart/${encodeURIComponent(FX_SYMBOL)}`, baseUrl)
  url.searchParams.set('interval', '1d')
  url.searchParams.set('range', '5d')

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(url.href, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: controller.signal,
    })
    if (!response.ok) {
      console.warn(JSON.stringify({ event: 'usdjpy_fetch_non_ok', status: response.status, requestId }))
      return null
    }
    const json = (await response.json()) as YahooChartMetaResponse
    const rate = json.chart?.result?.[0]?.meta?.regularMarketPrice
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      console.warn(JSON.stringify({ event: 'usdjpy_rate_invalid', rate, requestId }))
      return null
    }
    return rate
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'usdjpy_fetch_failed',
        message: error instanceof Error ? error.message : String(error),
        requestId,
      }),
    )
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}
