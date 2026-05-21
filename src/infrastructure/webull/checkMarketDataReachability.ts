/**
 * Webull JP 本番 market-data API (`data-api.webull.co.jp`) の疎通監視 (#21 follow-up)。
 *
 * 2026-05-21 時点で本 host は DNS resolve するが TCP 443 が応答せず、
 * `api.webull.co.jp/openapi/market-data/*` も `404 Route Not Found` を返す
 * (= 未公開)。strategy cron は {@link YahooQuoteClient} を default で使う形に
 * 切替済 (PR #334)。
 *
 * Webull JP が market-data API を公開した瞬間に operator が気付ける仕組みとして、
 * 22:00 UTC daily cron がこの helper を呼ぶ。応答が変わったら notifier 経由で
 * "戻し PR を切るタイミング" を通知する。
 *
 * **判定条件**: `https://data-api.webull.co.jp/` に GET を投げて任意の HTTP
 * status code が返ってくれば reachable (404 でも OK、TCP listener が立った事の
 * 証明)。timeout / connection error は unreachable (現状の期待値) で silent。
 */

const DEFAULT_HOST = 'data-api.webull.co.jp'
const DEFAULT_TIMEOUT_MS = 5_000

export interface MarketDataReachabilityResult {
  /** TCP / TLS / HTTP layer まで到達して何らかの応答を得たか。 */
  reachable: boolean
  /** reachable=true の時の HTTP status (404 含む = listener が立ってる証拠)。 */
  status: number | null
  /** fetch 開始から完了 (or abort) まで。 */
  msTaken: number
  /** unreachable のときの error message (timeout / DNS error 等)。 */
  error: string | null
}

export interface CheckMarketDataReachabilityOptions {
  /** override host。default は `data-api.webull.co.jp`。 */
  host?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export async function checkMarketDataReachability(
  options: CheckMarketDataReachabilityOptions = {},
): Promise<MarketDataReachabilityResult> {
  const host = options.host ?? DEFAULT_HOST
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `https://${host}/`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const response = await fetchFn(url, { method: 'GET', signal: controller.signal })
    return {
      reachable: true,
      status: response.status,
      msTaken: Date.now() - t0,
      error: null,
    }
  } catch (error) {
    return {
      reachable: false,
      status: null,
      msTaken: Date.now() - t0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
