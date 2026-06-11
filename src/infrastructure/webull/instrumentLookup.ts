import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'

/**
 * Webull JP instrument 照会 (`GET /openapi/instrument/stock/list`) の正式実装
 * (issue #475)。
 *
 * **実測で確定した性質 (2026-06-11, PR #474 probe + 公式 MCP)**:
 *   - host は trade host (`api.webull.co.jp`) + `x-version: v2`。v1 署名だと
 *     gateway routing で 404 になる (「404 = endpoint 不在」と誤読しない)
 *   - 実在しない symbol (ZZZZ) は 200 + 空配列 → 存在検証に使える
 *   - `status` enum は OC=Tradable / CO=Liquidate only / NT=Non-Tradable
 *     (公式 webull-openapi-mcp の定義)。**ただし deny 実証済みの USMV も OC**
 *     なので、JP の取扱 deny (TICKER_IS_DENY) はこの API には反映されない —
 *     OC を「発注可能」とは主張できない
 *   - 対応 category は US_STOCK / US_ETF のみ (JP 銘柄は照会不可)。ETF を
 *     US_STOCK で引いても返る (USMV 実測) ため category 厳密性は不要
 *   - rate limit: 60 req/min per AppId (公式 llms_jp.md)
 */

/** instrument status → operator 向け日本語ラベル。 */
export const INSTRUMENT_STATUS_LABELS: Record<string, string> = {
  OC: '取引可 (Tradable)',
  CO: '清算のみ (Liquidate only)',
  NT: '取引不可 (Non-Tradable)',
}

/** 正規化済み instrument。raw JSON はこの層から外に出さない。 */
export interface WebullInstrument {
  symbol: string
  name: string | null
  /** OC / CO / NT。未知値もそのまま保持する (enum 拡張に fail-safe)。 */
  status: string | null
  instrumentId: string | null
  exchangeCode: string | null
  shortable: boolean | null
  fractionable: boolean | null
  marginable: boolean | null
  overnightTradingSupported: boolean | null
  easyToBorrow: boolean | null
  lotSize: number | null
  /** ETF レバレッジ倍率。+3 (SOXL) / -3 (SOXS) / 0 (非レバ)。非 ETF は null。 */
  etfLeveragedFactor: number | null
  inverseEtf: boolean | null
}

export type InstrumentLookupResult =
  | { outcome: 'found'; instrument: WebullInstrument }
  /** 200 + 空配列 (= 銘柄マスタに不存在。ZZZZ 実測パターン)。 */
  | { outcome: 'not_found' }
  /** 通信失敗 / 非200 / 設定不足。判定材料にしない (fail-safe)。 */
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
  /** US_STOCK / US_ETF。JP 銘柄は API 非対応なので呼び出し側で弾く。 */
  category: 'US_STOCK' | 'US_ETF'
  /** test seam。default は globalThis.fetch。 */
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
      // symbols= は完全一致クエリだが、念のため symbol 一致でフィルタする
      // (複数件返却やマスタ揺れに fail-safe)。
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
