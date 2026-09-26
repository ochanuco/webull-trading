import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import type { InstrumentLookupResult, WebullInstrument } from './instrumentLookup'
import { INSTRUMENT_STATUS_LABELS } from './instrumentLookup'
import { resolveAccessToken } from './resolveAccessToken'
import { toWebullPlaceOrderRequest } from './mapper'

/**
 * Checks whether Webull JP will accept orders for a symbol, using Preview
 * Order (`POST /openapi/account/orders/preview`) as the primary signal.
 *
 * Preview validates that the symbol exists in the instrument master (an
 * unknown symbol gets `OAUTH_OPENAPI_PARAM_ERR`) but not the orderable/deny
 * list — USMV returned a 200 quote from preview yet was denied at
 * production place with TICKER_IS_DENY. So a 200 here never means
 * "tradable", only "not obviously blocked".
 *
 * Verdicts: 'denied' (invalid symbol, TICKER_IS_DENY, or a caller-supplied
 * known past deny), 'unknown' (preview succeeded or errored without a
 * definitive signal — does not block registration), 'unavailable' (the
 * check itself couldn't run).
 */
type TradabilityVerdict = 'denied' | 'unknown' | 'unavailable'

/** Webull emits both `OAUTH_OPENAPI_`-prefixed and bare `TICKER_IS_DENY` codes; match by suffix to catch both. */
function isTickerDenyCode(errorCode: string | null): boolean {
  return errorCode !== null && errorCode.endsWith('TICKER_IS_DENY')
}

/** Narrows PARAM_ERR to the "invalid symbol" case so other-field errors aren't misread as a nonexistent ticker. */
function isInvalidSymbolParamError(r: TradabilityVariantResult): boolean {
  return (
    r.errorCode !== null &&
    r.errorCode.endsWith('PARAM_ERR') &&
    typeof r.message === 'string' &&
    /invalid[^"]*symbol/i.test(r.message)
  )
}

interface TradabilityVariantResult {
  label: string
  status: number | null
  errorCode: string | null
  message: string | null
  /** First 300 chars of the response body, for auditing false-positive 200s. */
  bodyExcerpt?: string
}

export interface TradabilityResult {
  verdict: TradabilityVerdict
  /**
   * known_deny: caller-supplied prior deny record. ticker_deny: this preview
   * call got TICKER_IS_DENY. not_listed: instrument lookup found nothing.
   * instrument_status: instrument status is CO/NT. invalid_symbol: preview
   * rejected the symbol itself. quote_ok: preview succeeded (not a
   * tradability guarantee — see the USMV note above). preview_error: preview
   * responded but inconclusively. unreachable: broker unreachable or misconfigured.
   */
  reason:
    | 'known_deny'
    | 'ticker_deny'
    | 'not_listed'
    | 'instrument_status'
    | 'invalid_symbol'
    | 'quote_ok'
    | 'preview_error'
    | 'unreachable'
  /** One-line operator-facing explanation. */
  detail: string
  variants: TradabilityVariantResult[]
  /**
   * Normalized instrument lookup result; null when lookup wasn't run (JP
   * symbols) or errored. Used by the UI for status/overnight/leverage flags.
   */
  instrument: WebullInstrument | null
}

/**
 * Candidate Preview Order body shapes, shared by the broker/probe
 * diagnostic page and the form check. Collapse to one once Webull's
 * expected shape is confirmed.
 */
export function buildPreviewOrderVariants(
  symbol: string,
  market: 'US' | 'JP',
  price: number,
  accountId: string,
): Array<{ label: string; body: unknown }> {
  const baseEntry = {
    symbol,
    instrument_type: 'EQUITY',
    market,
    side: 'BUY',
    quantity: '1',
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    account_tax_type: 'SPECIFIC',
  }
  return [
    {
      // Same shape as production place (v1 mapper): client_order_id + MARKET + limit cap.
      label: 'v1-place-shape',
      body: toWebullPlaceOrderRequest(
        {
          symbol,
          side: 'BUY',
          quantity: 1,
          price,
          notional: price,
          clientOrderId: `probe-preview-${crypto.randomUUID()}`,
        },
        'v1',
        accountId,
      ),
    },
    {
      // Field set from the JP preview-order-v2 docs: no client_order_id, v2 session enum.
      label: 'v2-fields-market',
      body: {
        new_orders: [
          {
            ...baseEntry,
            order_type: 'MARKET',
            support_trading_session: 'CORE',
            limit_price: price.toFixed(3),
          },
        ],
      },
    },
    {
      label: 'v2-fields-limit',
      body: {
        new_orders: [
          {
            ...baseEntry,
            order_type: 'LIMIT',
            support_trading_session: 'CORE',
            limit_price: price.toFixed(3),
          },
        ],
      },
    },
  ]
}

const PREVIEW_PATH = '/openapi/account/orders/preview'
const DEFAULT_TRADE_API_BASE = 'https://api.webull.co.jp'
const PREVIEW_TIMEOUT_MS = 10_000

interface CheckInput {
  symbol: string
  market: 'US' | 'JP'
  /** Limit cap sent to preview; defaults to 100 as a placeholder until the shape is confirmed. */
  price?: number
  fetcher?: typeof fetch
  /**
   * Instrument lookup result, fetched by the caller — this function only
   * combines it into the verdict. Pass a Promise to run it in parallel with
   * preview; omit for JP symbols (unsupported by that API), which falls
   * back to preview-only.
   */
  instrument?: InstrumentLookupResult | Promise<InstrumentLookupResult>
}

export async function checkTradability(env: Env, input: CheckInput): Promise<TradabilityResult> {
  const appKey = (env.WEBULL_APP_KEY ?? '').trim()
  const appSecret = (env.WEBULL_APP_SECRET ?? '').trim()
  const accountId = (env.WEBULL_ACCOUNT_ID_JP_CASH ?? '').trim()
  if (appKey.length === 0 || appSecret.length === 0 || accountId.length === 0) {
    return {
      verdict: 'unavailable',
      reason: 'unreachable',
      detail: 'Webull credentials 未設定のため検証不可',
      variants: [],
      instrument: null,
    }
  }
  const symbol = input.symbol.trim().toUpperCase()
  const price = Number.isFinite(input.price) && (input.price as number) > 0 ? (input.price as number) : 100
  const baseUrl = (env.WEBULL_TRADE_API_BASE ?? '').trim() || DEFAULT_TRADE_API_BASE
  const accessToken = await resolveAccessToken(env).catch(() => undefined)
  const doFetch = input.fetcher ?? fetch
  const variants = buildPreviewOrderVariants(symbol, input.market, price, accountId)

  const resultsPromise: Promise<TradabilityVariantResult[]> = Promise.all(
    variants.map(async (variant): Promise<TradabilityVariantResult> => {
      const url = new URL(PREVIEW_PATH, `${baseUrl}/`)
      url.searchParams.set('account_id', accountId)
      const payload = JSON.stringify(variant.body)
      try {
        const headers = await buildSignedHeaders({
          method: 'POST',
          path: url.pathname,
          query: { account_id: accountId },
          body: payload,
          host: url.host,
          appKey,
          appSecret,
          version: 'v1',
          ...(accessToken !== undefined ? { accessToken } : {}),
        })
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS)
        try {
          const response = await doFetch(url.href, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
            body: payload,
            signal: controller.signal,
          })
          const text = await response.text()
          let errorCode: string | null = null
          let message: string | null = null
          try {
            const parsed = JSON.parse(text) as { error_code?: unknown; message?: unknown }
            errorCode = typeof parsed.error_code === 'string' ? parsed.error_code : null
            message = typeof parsed.message === 'string' ? parsed.message : null
          } catch {
            // Non-JSON response — fall through and judge by status alone.
          }
          // Batch-style APIs can embed a per-order error in the body even on
          // HTTP 200, so scan the full text in addition to the top-level error_code.
          if (errorCode === null && /TICKER_IS_DENY/.test(text)) {
            errorCode = 'OAUTH_OPENAPI_TICKER_IS_DENY'
          }
          if (errorCode === null && response.status === 200 && /"error_code"/.test(text)) {
            const m = text.match(/"error_code"\s*:\s*"([A-Z0-9_]+)"/)
            if (m) errorCode = m[1]!
          }
          return {
            label: variant.label,
            status: response.status,
            errorCode,
            message,
            bodyExcerpt: text.slice(0, 300),
          }
        } finally {
          clearTimeout(timeoutId)
        }
      } catch (err) {
        return {
          label: variant.label,
          status: null,
          errorCode: null,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )
  // Runs in parallel with the preview fetch above (already in flight).
  const lookup = input.instrument === undefined ? undefined : await input.instrument
  const instrument = lookup?.outcome === 'found' ? lookup.instrument : null
  const results = await resultsPromise

  if (results.some((r) => isTickerDenyCode(r.errorCode))) {
    return {
      verdict: 'denied',
      reason: 'ticker_deny',
      detail: 'Webull JP の OpenAPI では発注できない銘柄 (TICKER_IS_DENY)',
      variants: results,
      instrument,
    }
  }
  // Trust "not found" over a contradicting preview — fail closed. Lookup
  // errors never reach here (only a real empty-array 200 sets not_found),
  // so this doesn't over-trigger on transient lookup failures.
  if (lookup?.outcome === 'not_found') {
    return {
      verdict: 'denied',
      reason: 'not_listed',
      detail: 'Webull の銘柄マスタに存在しない (instrument 照会で不存在)',
      variants: results,
      instrument,
    }
  }
  // CO (liquidate-only) blocks new BUY registration same as NT. Unknown
  // status values are NOT denied here — an enum extension must not halt
  // every symbol; the place-order path has its own after-the-fact guard.
  if (instrument?.status === 'CO' || instrument?.status === 'NT') {
    return {
      verdict: 'denied',
      reason: 'instrument_status',
      detail: `instrument status が ${instrument.status} (${INSTRUMENT_STATUS_LABELS[instrument.status]}) — 新規エントリー不可`,
      variants: results,
      instrument,
    }
  }
  const responding = results.filter((r) => r.status !== null)
  // All responding variants agree the symbol itself is invalid.
  if (responding.length > 0 && responding.every((r) => isInvalidSymbolParamError(r))) {
    return {
      verdict: 'denied',
      reason: 'invalid_symbol',
      detail: 'Webull の銘柄マスタに存在しない (symbol / market の組合せ不正)',
      variants: results,
      instrument,
    }
  }
  // 200 means the quote succeeded — not a tradability guarantee (see the USMV note above).
  if (results.some((r) => r.status === 200 && r.errorCode === null)) {
    const statusNote =
      instrument?.status === 'OC'
        ? 'instrument status OC (取引可) + 見積もり可'
        : '銘柄は存在し見積もり可'
    return {
      verdict: 'unknown',
      reason: 'quote_ok',
      detail: `${statusNote}。ただし JP の取扱 deny は発注時のみ検出 — 最終確認は Webull アプリで`,
      variants: results,
      instrument,
    }
  }
  if (responding.length > 0) {
    const codes = [...new Set(responding.map((r) => r.errorCode).filter(Boolean))].join(', ')
    return {
      verdict: 'unknown',
      reason: 'preview_error',
      detail: `判定材料が得られませんでした (${codes || 'unknown'})`,
      variants: results,
      instrument,
    }
  }
  return {
    verdict: 'unavailable',
    reason: 'unreachable',
    detail: 'broker に到達できず判定不可',
    variants: results,
    instrument,
  }
}
