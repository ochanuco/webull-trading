import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'

/**
 * Webull JP instrument lookup (`GET /openapi/instrument/stock/list`).
 *
 * - Trade host (`api.webull.co.jp`) + x-version: v2 — v1 signing 404s at the
 *   gateway (don't read that 404 as "endpoint doesn't exist").
 * - A nonexistent symbol returns 200 + an empty array, usable as an
 *   existence check.
 * - `status` (OC=Tradable / CO=Liquidate-only / NT=Non-Tradable, per the
 *   official webull-openapi-mcp) does not reflect JP's TICKER_IS_DENY
 *   restriction — a denied symbol still comes back OC, so OC cannot be read
 *   as "orderable".
 * - Only US_STOCK / US_ETF are supported; JP symbols aren't queryable here.
 * - Rate limit: 60 req/min per AppId.
 */

/** Operator-facing Japanese label per instrument status. */
export const INSTRUMENT_STATUS_LABELS: Record<string, string> = {
  OC: '取引可 (Tradable)',
  CO: '清算のみ (Liquidate only)',
  NT: '取引不可 (Non-Tradable)',
}

/** Normalized instrument; raw JSON never leaves this layer. */
export interface WebullInstrument {
  symbol: string
  name: string | null
  /** OC / CO / NT; unknown values pass through as-is for forward-compat. */
  status: string | null
  instrumentId: string | null
  exchangeCode: string | null
  shortable: boolean | null
  fractionable: boolean | null
  marginable: boolean | null
  overnightTradingSupported: boolean | null
  easyToBorrow: boolean | null
  lotSize: number | null
  /** Leverage multiplier: +3 (SOXL) / -3 (SOXS) / 0 (unleveraged). null for non-ETFs. */
  etfLeveragedFactor: number | null
  inverseEtf: boolean | null
}

export type InstrumentLookupResult =
  | { outcome: 'found'; instrument: WebullInstrument }
  /** 200 + empty array — symbol not in the master list. */
  | { outcome: 'not_found' }
  /** Network failure, non-200, or missing config — never a tradability signal. */
  | { outcome: 'error'; status: number | null; error: string }

const INSTRUMENT_PATH = '/openapi/instrument/stock/list'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const LOOKUP_TIMEOUT_MS = 10_000

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

interface LookupInput {
  symbol: string
  /** JP symbols aren't supported by this API; callers must filter them out first. */
  category: 'US_STOCK' | 'US_ETF'
  fetcher?: typeof fetch
}

export async function lookupInstrument(env: Env, input: LookupInput): Promise<InstrumentLookupResult> {
  const appKey = (env.WEBULL_APP_KEY ?? '').trim()
  const appSecret = (env.WEBULL_APP_SECRET ?? '').trim()
  if (appKey.length === 0 || appSecret.length === 0) {
    return { outcome: 'error', status: null, error: 'Webull credentials 未設定' }
  }
  const symbol = input.symbol.trim().toUpperCase()
  const baseUrl = (env.WEBULL_TRADE_API_BASE ?? '').trim() || DEFAULT_TRADE_API_BASE
  const accessToken = await resolveAccessToken(env).catch(() => undefined)
  const doFetch = input.fetcher ?? fetch
  const query = { symbols: symbol, category: input.category }
  const url = new URL(INSTRUMENT_PATH, `${baseUrl}/`)
  url.searchParams.set('symbols', symbol)
  url.searchParams.set('category', input.category)

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
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    try {
      const response = await doFetch(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      })
      const text = await response.text()
      if (response.status !== 200) {
        return { outcome: 'error', status: response.status, error: text.slice(0, 200) }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { outcome: 'error', status: response.status, error: 'non-JSON response' }
      }
      if (!Array.isArray(parsed)) {
        return { outcome: 'error', status: response.status, error: 'unexpected response shape' }
      }
      // Defensive: symbols= should already be an exact match, but filter
      // anyway in case the master returns extra rows.
      const row = parsed.find(
        (r): r is Record<string, unknown> =>
          typeof r === 'object' && r !== null && (r as Record<string, unknown>).symbol === symbol,
      )
      if (row === undefined) {
        return { outcome: 'not_found' }
      }
      return {
        outcome: 'found',
        instrument: {
          symbol,
          name: asString(row.name),
          status: asString(row.status),
          instrumentId: asString(row.instrument_id),
          exchangeCode: asString(row.exchange_code),
          shortable: asBool(row.shortable),
          fractionable: asBool(row.fractionable),
          marginable: asBool(row.marginable),
          overnightTradingSupported: asBool(row.overnight_trading_supported),
          easyToBorrow: asBool(row.easy_to_borrow),
          lotSize: asFiniteNumber(row.lot_size),
          etfLeveragedFactor: asFiniteNumber(row.etf_leveraged_factor),
          inverseEtf: asBool(row.inverse_etf),
        },
      }
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (err) {
    return {
      outcome: 'error',
      status: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
