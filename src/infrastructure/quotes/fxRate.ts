// USD/JPY スポットレート取得 (#budget-jpy-base-fx)。予算配分を口座(円)単一プールで
// 扱うため、USD 銘柄の「目標円 → USD notional」換算に使う。
//
// Yahoo `/v8/finance/chart/USDJPY=X` の `meta.regularMarketPrice` を読む
// (YahooBarClient と同 endpoint / UA 規約)。実マネー sizing に効くので **fail-safe**:
// fetch 失敗・非有限・サニティレンジ外は `null` を返し (throw しない)、呼び出し側で
// USD 予算銘柄を fail-closed (発注しない) させる。誤レートでの過大発注を防ぐ。

const DEFAULT_BASE_URL = 'https://query1.finance.yahoo.com'
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_USER_AGENT = 'Mozilla/5.0'
const FX_SYMBOL = 'USDJPY=X'
// USD/JPY の妥当レンジ。歴史的に 75〜160 程度。異常値 (0 / 桁違い / 取り違え) を弾く
// 安全マージンとして広めに 50〜500 を採用。範囲外は誤データとみなし null。
const MIN_RATE = 50
const MAX_RATE = 500

export interface UsdJpyRateOptions {
  baseUrl?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
  userAgent?: string
}

interface YahooChartMetaResponse {
  chart?: {
    result?: Array<{ meta?: { regularMarketPrice?: number } }>
  }
}

/**
 * USD/JPY (1 USD = N JPY) の最新レートを返す。取得不能 / 異常値は `null`。
 * 例外は投げない (cron / sizing 経路を巻き添えにしない fail-safe)。
 */
export async function loadUsdJpyRate(options: UsdJpyRateOptions = {}): Promise<number | null> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT

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
      console.warn(JSON.stringify({ event: 'usdjpy_fetch_non_ok', status: response.status }))
      return null
    }
    const json = (await response.json()) as YahooChartMetaResponse
    const rate = json.chart?.result?.[0]?.meta?.regularMarketPrice
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      console.warn(JSON.stringify({ event: 'usdjpy_rate_invalid', rate }))
      return null
    }
    return rate
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'usdjpy_fetch_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}
