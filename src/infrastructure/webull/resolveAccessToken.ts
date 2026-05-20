import type { Env } from '../../config/env'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenStatus } from './WebullTokenClient'

/**
 * どの経路で token を引いたかの診断ラベル (probe / log 用)。token 値そのものは
 * 漏らさず、source だけ surface する事で「DO 由来 NORMAL を送ってるのに broker
 * が reject」「そもそも token が undefined」を切り分ける。
 */
export type AccessTokenSource =
  /** DO NORMAL token を使った (正常な production path)。 */
  | 'do_normal'
  /** DO に state はあるが NORMAL じゃない (PENDING/INVALID/EXPIRED) → env fallback or none。 */
  | 'do_non_normal'
  /** DO は bound だが state が null (seed されてない) → env fallback or none。 */
  | 'do_empty'
  /** DO 読込で throw → env fallback or none。 */
  | 'do_error'
  /** DO 未 bind → env fallback or none。 */
  | 'do_unbound'
  /** env.WEBULL_ACCESS_TOKEN を使った (Phase A bootstrap)。 */
  | 'env'
  /** どこからも取れなかった (header 欠落、broker が 401 INVALID_TOKEN で reject される)。 */
  | 'none'

export interface ResolvedAccessToken {
  token: string | undefined
  /** どの source から取得 (してない場合は理由を含む)。 */
  source: AccessTokenSource
  /** DO 読込が試みられた場合の生 status (debug 用、token 値ではない)。 */
  doStatus?: WebullTokenStatus | null
}

/**
 * Resolve the active `x-access-token` value at call time (#21 Phase B).
 *
 * Resolution order:
 *   1. **DO state** (`WEBULL_TOKEN_STATE`) when bound AND state is `NORMAL`
 *      — the DO is the runtime source of truth, kept refreshed by the cron
 *      handler so it never goes stale silently.
 *   2. **`WEBULL_ACCESS_TOKEN` env** when DO is empty / non-NORMAL — Phase A
 *      bootstrap path. operator can still drop a freshly issued token here
 *      via `wrangler secret put` before the DO has been seeded.
 *   3. `undefined` — no token available; callers proceed unsigned and the
 *      broker returns `INVALID_TOKEN` (visible failure, not silent skip).
 *
 * `INVALID` / `EXPIRED` states in the DO are treated as "no token" so the
 * stale value is not sent on the wire; the operator sees a clear
 * broker-side 401 instead of a confusing signature-pass-but-no-data result.
 */
export async function resolveAccessToken(env: Env): Promise<string | undefined> {
  return (await resolveAccessTokenWithSource(env)).token
}

/**
 * Same lookup logic as {@link resolveAccessToken}, but returns the source path
 * so callers (e.g. `/admin/broker/probe`) can surface "which source did we use,
 * and was the token loaded at all" for debugging without leaking the token
 * value itself.
 */
export async function resolveAccessTokenWithSource(env: Env): Promise<ResolvedAccessToken> {
  const namespace = env.WEBULL_TOKEN_STATE
  let doResolution: { source: AccessTokenSource; doStatus?: WebullTokenStatus | null } = {
    source: 'do_unbound',
  }

  if (namespace) {
    try {
      const client = new WebullTokenStateClient(namespace)
      const state = await client.getState()
      if (state === null) {
        doResolution = { source: 'do_empty', doStatus: null }
      } else if (state.status === 'NORMAL' && state.token.length > 0) {
        return { token: state.token, source: 'do_normal', doStatus: state.status }
      } else {
        doResolution = { source: 'do_non_normal', doStatus: state.status }
      }
    } catch (error) {
      // DO 自体が落ちてるケース (binding mismatch / runtime error)。env fallback に
      // 抜けて静かに degrade させるよりは、明示的に log を残して原因追跡を可能に
      // する。env が無ければ undefined を返して上位の broker call が 401 で気付く。
      console.warn(
        JSON.stringify({
          event: 'webull_token_do_unreachable',
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      doResolution = { source: 'do_error' }
    }
  }

  const fallback = env.WEBULL_ACCESS_TOKEN?.trim()
  if (fallback && fallback.length > 0) {
    return { token: fallback, source: 'env', doStatus: doResolution.doStatus }
  }
  return { token: undefined, source: doResolution.source, doStatus: doResolution.doStatus }
}
