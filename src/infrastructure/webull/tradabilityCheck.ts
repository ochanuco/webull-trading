import type { Env } from '../../config/env'
import { buildSignedHeaders } from './WebullAuth'
import type { InstrumentLookupResult, WebullInstrument } from './instrumentLookup'
import { INSTRUMENT_STATUS_LABELS } from './instrumentLookup'
import { resolveAccessToken } from './resolveAccessToken'
import { toWebullPlaceOrderRequest } from './mapper'

/**
 * 銘柄の Webull JP 取扱チェック (#461)。
 *
 * **実測で確定した Preview Order (`POST /openapi/account/orders/preview`) の性質
 * (2026-06-11)**:
 *   - 実在しない symbol (ZZZZ) は `OAUTH_OPENAPI_PARAM_ERR`
 *     ("invalid market,symbol,instrument_type") で拒否 → **銘柄マスタの存在検証は
 *     している**
 *   - 一方、本番 place が TICKER_IS_DENY で拒否した USMV は preview 200 + 見積を
 *     返した → **発注 allowlist (deny list) までは検証しない** (または deny list が
 *     日次で変わる)。**preview 200 から「取引可能」は主張できない**
 *
 * 出せる判定:
 *   - 'denied'  : (a) 全 variant が銘柄不正 PARAM_ERR (= マスタに不存在 or
 *                 market/type 不一致)、(b) preview が TICKER_IS_DENY を返した、
 *                 (c) 呼び出し側 (admin endpoint) が過去の deny 実績
 *                 (symbol_config.notes の #460 マーカー) を検出した場合
 *   - 'unknown' : preview は通った/エラーだが確定情報なし。「見積もり可」でも
 *                 発注可否は保証しない (USMV の前例)。登録はブロックしない
 *   - 'unavailable': 設定不足 / broker 不達 (判定プロセス自体が走れず)
 */
export type TradabilityVerdict = 'denied' | 'unknown' | 'unavailable'

/**
 * 銘柄単位の恒久拒否コード判定。Webull は `OAUTH_OPENAPI_` prefix 付き/なしの
 * 両方の表記が観測されているため suffix で判定する (CodeRabbit #466)。
 */
export function isTickerDenyCode(errorCode: string | null): boolean {
  return errorCode !== null && errorCode.endsWith('TICKER_IS_DENY')
}

/**
 * 「銘柄が不正」型の PARAM_ERR か (ZZZZ 実測: message が
 * "Parameter error, invalid market,symbol,instrument_type, value: ..." の形)。
 * 他フィールド起因の PARAM_ERR と区別するため 'symbol' を含むものに限定する。
 */
function isInvalidSymbolParamError(r: TradabilityVariantResult): boolean {
  return (
    r.errorCode !== null &&
    r.errorCode.endsWith('PARAM_ERR') &&
    typeof r.message === 'string' &&
    /invalid[^"]*symbol/i.test(r.message)
  )
}

export interface TradabilityVariantResult {
  label: string
  status: number | null
  errorCode: string | null
  message: string | null
  /** 判定根拠の確認用 (200 偽陽性の調査 #461)。先頭 300 chars。 */
  bodyExcerpt?: string
}

export interface TradabilityResult {
  verdict: TradabilityVerdict
  /**
   * UI 表示分岐用の判定根拠。
   * known_deny: 過去の実発注 deny 実績 / ticker_deny: preview が deny を返却 /
   * not_listed: instrument 照会で不存在 (#475) / instrument_status: instrument
   * status が CO/NT (#475) / invalid_symbol: preview が銘柄不正 / quote_ok:
   * 見積もり成功 (保証なし) / preview_error: 判定材料にならないエラー /
   * unreachable: 不達・設定不足
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
  /** operator 向けの 1 行説明。 */
  detail: string
  variants: TradabilityVariantResult[]
  /**
   * instrument 照会 (#475) の正規化結果。lookup 不実施 (JP 銘柄) / error 時は
   * null。UI が status / overnight / leveraged 等のフラグ表示に使う。
   */
  instrument: WebullInstrument | null
}

/**
 * Preview Order に試す body shape 候補 (#461)。確定したら 1 つに絞る。
 * broker/probe (診断ページ) と form チェックの両方がこれを共有する。
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
    account_tax_type: 'GENERAL',
  }
  return [
    {
      // production place (v1 mapper) と同形: client_order_id + MARKET + limit cap
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
      // JP preview docs (preview-order-v2) の field 集合: client_order_id なし、
      // v2 session enum
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
  /** preview の limit cap。未指定は 100 (shape 確定までの placeholder)。 */
  price?: number
  /** test seam。default は globalThis.fetch。 */
  fetcher?: typeof fetch
  /**
   * instrument 照会の結果 (#475)。fetch の orchestration は呼び出し側 (admin
   * endpoint) が行い、ここは verdict 合成だけ担う。Promise を渡すと preview と
   * 並列に解決する。未注入 (JP 銘柄 = API 非対応) は preview のみで判定する
   * 従来動作。
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
            // 非 JSON 応答は status だけで判定
          }
          // HTTP 200 でも batch 系 API は per-order エラーを body に埋めることが
          // ある (本番 place の deny と staging preview 200 の矛盾調査 #461)。
          // top-level の error_code に加え body 全文も走査する。
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
  // preview fetch を起動した後に lookup を await する (両者は並列に走る)。
  const lookup = input.instrument === undefined ? undefined : await input.instrument
  const instrument = lookup?.outcome === 'found' ? lookup.instrument : null
  const results = await resultsPromise

  // 確定 NG (1): preview が deny を返した場合。
  if (results.some((r) => isTickerDenyCode(r.errorCode))) {
    return {
      verdict: 'denied',
      reason: 'ticker_deny',
      detail: 'Webull JP の OpenAPI では発注できない銘柄 (TICKER_IS_DENY)',
      variants: results,
      instrument,
    }
  }
  // 確定 NG (2): instrument 照会 (#475、documented API) でマスタに不存在。
  // preview の結果と矛盾しても「取引しない」側に倒す。lookup の error は
  // ここに来ない (not_found は 200 + 空配列のみ) ので過剰 fail-closed にならない。
  if (lookup?.outcome === 'not_found') {
    return {
      verdict: 'denied',
      reason: 'not_listed',
      detail: 'Webull の銘柄マスタに存在しない (instrument 照会で不存在)',
      variants: results,
      instrument,
    }
  }
  // 確定 NG (3): instrument status が「取引可」以外 (#475)。
  // OC=Tradable / CO=Liquidate only / NT=Non-Tradable (公式 MCP の enum)。
  // CO は新規 BUY 不可なので登録ブロック対象。未知の status 値は deny しない
  // (enum 拡張で全銘柄が止まる事故を避ける。発注側には #460 の事後ガード)。
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
  // 確定 NG (4): 応答した全 variant が「銘柄不正」PARAM_ERR (= マスタに不存在
  // or market/instrument_type の組合せ不正。ZZZZ 実測パターン)。
  if (responding.length > 0 && responding.every((r) => isInvalidSymbolParamError(r))) {
    return {
      verdict: 'denied',
      reason: 'invalid_symbol',
      detail: 'Webull の銘柄マスタに存在しない (symbol / market の組合せ不正)',
      variants: results,
      instrument,
    }
  }
  // 200 = 見積もり成功。ただし発注 allowlist は検証されない (USMV は status=OC
  // のまま本番 place が deny された前例) ので「取引可能」とは言わない。
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
