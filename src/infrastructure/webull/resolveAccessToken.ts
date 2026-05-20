import type { Env } from '../../config/env'
import { WebullTokenStateClient } from '../../trading/state/WebullTokenStateClient'

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
  const namespace = env.WEBULL_TOKEN_STATE
  if (namespace) {
    try {
      const client = new WebullTokenStateClient(namespace)
      const state = await client.getState()
      if (state && state.status === 'NORMAL' && state.token.length > 0) {
        return state.token
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
    }
  }

  const fallback = env.WEBULL_ACCESS_TOKEN?.trim()
  return fallback && fallback.length > 0 ? fallback : undefined
}
