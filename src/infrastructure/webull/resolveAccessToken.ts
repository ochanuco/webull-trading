import type { Env } from '../../config/env'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'
import type { WebullTokenStatus } from './WebullTokenClient'

/**
 * Diagnostic label for which path resolved the token (probe/log only — never
 * the token value itself), so a broker-side reject can be told apart from
 * "no token was ever sent".
 */
export type AccessTokenSource =
  /** Normal production path. */
  | 'do_normal'
  /** DO state exists but isn't NORMAL (PENDING/INVALID/EXPIRED). */
  | 'do_non_normal'
  /** DO is bound but has no state yet (never seeded). */
  | 'do_empty'
  /** DO read threw. */
  | 'do_error'
  /** No DO binding configured. */
  | 'do_unbound'
  /** Used env.WEBULL_ACCESS_TOKEN (bootstrap path before the DO is seeded). */
  | 'env'
  /** No token available from any source; the broker rejects with 401 INVALID_TOKEN. */
  | 'none'

export interface ResolvedAccessToken {
  token: string | undefined
  source: AccessTokenSource
  /** Raw DO status when a DO read was attempted (debug only, not the token). */
  doStatus?: WebullTokenStatus | null
}

/**
 * Resolve the active `x-access-token` value at call time.
 *
 * Resolution order:
 *   1. **DO state** (`WEBULL_TOKEN_STATE`) when bound AND state is `NORMAL`
 *      — the DO is the runtime source of truth, kept refreshed by the cron
 *      handler so it never goes stale silently.
 *   2. **`WEBULL_ACCESS_TOKEN` env** when DO is empty / non-NORMAL — bootstrap
 *      path. operator can still drop a freshly issued token here via
 *      `wrangler secret put` before the DO has been seeded.
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
      // Logged (not swallowed) so a broken DO binding is diagnosable instead
      // of silently degrading to env fallback.
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
