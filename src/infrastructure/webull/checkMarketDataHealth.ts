import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'

/**
 * Webull JP Market Data API の死活監視 (#475、旧 checkMarketDataReachability)。
 *
 * 旧実装は「market data = `data-api.webull.co.jp` (TCP 沈黙)」前提で、その host
 * に listener が立った瞬間を通知する設計だった。しかし JP docs の再読 + 実測
 * (PR #474) で **production host は trade host (`api.webull.co.jp`) + x-version
 * v2 で既に稼働中** と判明 — 存在しない host を見張っていたことになる。
 *
 * 新実装は documented endpoint (`GET /openapi/market-data/stock/snapshot`,
 * v2 署名) を AAPL で叩き、**200 が返らなくなったら** caller (22:00 UTC daily
 * cron) が warn 通知する。quote/bars の Webull 回帰 (#475) の前提カナリア。
 */

const SNAPSHOT_PATH = '/openapi/market-data/stock/snapshot'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const DEFAULT_TIMEOUT_MS = 10_000
/** UAT 含む全環境で quote 権限が確認済みの probe 用銘柄。 */
const PROBE_SYMBOL = 'AAPL'

export interface MarketDataHealthResult {
  /** snapshot が HTTP 200 を返したか。 */
  healthy: boolean
  /** HTTP status (応答があった場合)。 */
  status: number | null
  /** fetch 開始から完了 (or abort) まで。 */
  msTaken: number
  /** unhealthy のときの理由 (timeout / 非200 / credentials 未設定 等)。 */
  error: string | null
}

export interface CheckMarketDataHealthOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export async function checkMarketDataHealth(
  env: Env,
  options: CheckMarketDataHealthOptions = {},
): Promise<MarketDataHealthResult> {
  const fetchFn = options.fetchFn ?? fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const appKey = (env.WEBULL_APP_KEY ?? '').trim()
  const appSecret = (env.WEBULL_APP_SECRET ?? '').trim()
  if (appKey.length === 0 || appSecret.length === 0) {
    return { healthy: false, status: null, msTaken: 0, error: 'Webull credentials 未設定' }
  }
  const baseUrl = (env.WEBULL_TRADE_API_BASE ?? '').trim() || DEFAULT_TRADE_API_BASE
  const query = {
    symbols: PROBE_SYMBOL,
    category: 'US_STOCK',
    extend_hour_required: 'false',
    overnight_required: 'false',
  }
  const url = new URL(SNAPSHOT_PATH, `${baseUrl}/`)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const accessToken = await resolveAccessToken(env).catch(() => undefined)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const headers = await buildSignedHeaders({
      method: 'GET',
      path: url.pathname,
      query,
      host: url.host,
      appKey,
      appSecret,
      version: 'v2',
      ...(accessToken !== undefined ? { accessToken } : {}),
    })
    const response = await fetchFn(url.href, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    })
    return {
      healthy: response.status === 200,
      status: response.status,
      msTaken: Date.now() - t0,
      error: response.status === 200 ? null : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      healthy: false,
      status: null,
      msTaken: Date.now() - t0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
