import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import { resolveAccessToken } from './resolveAccessToken'

/**
 * Webull JP の取扱可能銘柄リスト取得 (`GET /trade/instrument/tradable/list`、#460)。
 *
 * **実測で確定した呼び出し規約 (2026-06-12 probe)**:
 *   - host は trade host (`api.webull.co.jp`)、**`x-version: v1`**、かつ
 *     **`/openapi` prefix なし** の `/trade/instrument/tradable/list`。
 *     `/openapi` 付きや v2 は `404 Route Not Found` になる (gateway routing)。
 *   - app-level 署名のみで叩ける (account_id / access token 不要)。token は
 *     `instrumentLookup` と同様に best-effort で乗せるが必須ではない。
 *   - レスポンスは `{ hasNext, instruments: [{ symbol, instrument_id,
 *     security_id, name, currency, exchange_code, ... }] }`。
 *   - ページングは `last_security_id` (= 直前ページ末尾の `security_id`)。
 *   - rate limit がきつい: throttle 無しで連続 ~30 req 叩くと
 *     `429 TOO_MANY_REQUESTS`。本実装は per-page throttle + 429 backoff で凌ぐ。
 *
 * 返り値は正規化済み instrument の配列と、ページング完走可否。途中で打ち切った
 * (`complete=false`) 場合、呼び出し側は **既存 allowlist を消さない** こと
 * (部分結果で currently_tradable を false に倒すと誤検知になる)。
 */

/** 正規化済み tradable instrument。raw JSON はこの層から外に出さない。 */
export interface TradableInstrumentEntry {
  symbol: string
  instrumentId: string | null
  name: string | null
  currency: string | null
  exchangeCode: string | null
}

export interface FetchTradableInstrumentsResult {
  outcome: 'ok' | 'error'
  /** 取得できた instrument (重複は symbol で除去済み)。 */
  instruments: TradableInstrumentEntry[]
  /** hasNext=false まで読み切れたか。false の場合は部分結果。 */
  complete: boolean
  /** 取得ページ数 (監視用)。 */
  pages: number
  /** outcome='error' のときの詳細。 */
  error?: string
  status?: number | null
}

const TRADABLE_PATH = '/trade/instrument/tradable/list'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 10_000
/** per-page throttle。~50 req/min に収めて 429 を避ける。 */
const DEFAULT_THROTTLE_MS = 1_200
/** 429 を踏んだ時の待機。 */
const RATE_LIMIT_BACKOFF_MS = 15_000
/** 暴走 / 無限ページング防止の hard cap (現状 ~50 ページ)。 */
const MAX_PAGES = 200
/** 429 を連続で踏んだ場合の打ち切り回数。 */
const MAX_RATE_LIMIT_RETRIES = 4

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Webull の instrument_id / security_id は末尾 `.000000` 付きで返る。整数部だけ残す。 */
function trimDecimalId(v: unknown): string | null {
  const s = asString(v)
  if (s === null) return null
  const dot = s.indexOf('.')
  return dot === -1 ? s : s.slice(0, dot)
}

interface FetchInput {
  /** test seam。default は globalThis.fetch。 */
  fetcher?: typeof fetch
  /** test seam。default は setTimeout ベースの sleep。 */
  sleep?: (ms: number) => Promise<void>
  /** test seam。default DEFAULT_THROTTLE_MS。 */
  throttleMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function fetchTradableInstruments(
  env: Env,
  input: FetchInput = {},
): Promise<FetchTradableInstrumentsResult> {
  const appKey = (env.WEBULL_APP_KEY ?? '').trim()
  const appSecret = (env.WEBULL_APP_SECRET ?? '').trim()
  if (appKey.length === 0 || appSecret.length === 0) {
    return {
      outcome: 'error',
      instruments: [],
      complete: false,
      pages: 0,
      error: 'Webull credentials 未設定',
      status: null,
    }
  }

  const baseUrl = (env.WEBULL_TRADE_API_BASE ?? '').trim() || DEFAULT_TRADE_API_BASE
  const accessToken = await resolveAccessToken(env).catch(() => undefined)
  const doFetch = input.fetcher ?? fetch
  const sleep = input.sleep ?? defaultSleep
  const throttleMs = input.throttleMs ?? DEFAULT_THROTTLE_MS

  // symbol で dedup (Map で last-write-wins)。
  const bySymbol = new Map<string, TradableInstrumentEntry>()
  let lastSecurityId: string | undefined
  let pages = 0
  let rateLimitRetries = 0

  for (;;) {
    if (pages >= MAX_PAGES) {
      // 想定外の巨大ユニバース。部分結果として返す (呼び出し側は消さない)。
      return {
        outcome: 'ok',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
      }
    }

    const query: Record<string, string> = { page_size: String(PAGE_SIZE) }
    if (lastSecurityId !== undefined) query.last_security_id = lastSecurityId

    const url = new URL(TRADABLE_PATH, `${baseUrl}/`)
    url.searchParams.set('page_size', String(PAGE_SIZE))
    if (lastSecurityId !== undefined) url.searchParams.set('last_security_id', lastSecurityId)

    let response: Response
    try {
      const headers = await buildSignedHeaders({
        method: 'GET',
        path: url.pathname,
        query,
        host: url.host,
        appKey,
        appSecret,
        version: 'v1',
        ...(accessToken !== undefined ? { accessToken } : {}),
      })
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        response = await doFetch(url.href, {
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeoutId)
      }
    } catch (err) {
      return {
        outcome: 'error',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        error: err instanceof Error ? err.message : String(err),
        status: null,
      }
    }

    if (response.status === 429) {
      rateLimitRetries += 1
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        return {
          outcome: 'error',
          instruments: [...bySymbol.values()],
          complete: false,
          pages,
          error: '429 TOO_MANY_REQUESTS (backoff 上限超過)',
          status: 429,
        }
      }
      await sleep(RATE_LIMIT_BACKOFF_MS)
      continue
    }
    rateLimitRetries = 0

    const text = await response.text()
    if (response.status !== 200) {
      return {
        outcome: 'error',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        error: text.slice(0, 200),
        status: response.status,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        outcome: 'error',
        instruments: [...bySymbol.values()],
        complete: false,
        pages,
        error: 'non-JSON response',
        status: response.status,
      }
    }

    const body = parsed as { hasNext?: unknown; instruments?: unknown }
    const rows = Array.isArray(body.instruments) ? body.instruments : []
    pages += 1

    for (const raw of rows) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const symbol = asString(r.symbol)
      if (symbol === null) continue
      bySymbol.set(symbol.toUpperCase(), {
        symbol: symbol.toUpperCase(),
        instrumentId: trimDecimalId(r.instrument_id),
        name: asString(r.name),
        currency: asString(r.currency),
        exchangeCode: asString(r.exchange_code),
      })
    }

    const lastRow = rows.length > 0 ? (rows[rows.length - 1] as Record<string, unknown>) : undefined
    lastSecurityId = lastRow ? (asString(lastRow.security_id) ?? undefined) : undefined

    const hasNext = body.hasNext === true
    if (!hasNext || rows.length === 0 || lastSecurityId === undefined) {
      return {
        outcome: 'ok',
        instruments: [...bySymbol.values()],
        complete: true,
        pages,
      }
    }

    await sleep(throttleMs)
  }
}
