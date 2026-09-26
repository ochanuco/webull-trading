import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'

/**
 * Health probe for the Webull JP Market Data API: polls the documented
 * snapshot endpoint via the trade host + v2 signing. The caller (daily cron)
 * alerts on non-200. Do not repoint this at `data-api.webull.co.jp` — that
 * host never answers in production, only the trade host does.
 */

const SNAPSHOT_PATH = '/openapi/market-data/stock/snapshot'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const DEFAULT_TIMEOUT_MS = 10_000
/** Confirmed to have quote entitlement in every environment including UAT. */
const PROBE_SYMBOL = 'AAPL'

export interface MarketDataHealthResult {
  healthy: boolean
  status: number | null
  msTaken: number
  /** Reason when unhealthy: timeout, non-200 status, or missing credentials. */
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
