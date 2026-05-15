import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../app'
import type { Env } from '../config/env'

/**
 * Rate-limit category。Cloudflare Workers `RateLimit` binding に対応する env
 * 名と 1:1 対応 (env.STATE_CHANGE_RATE_LIMIT / env.ADMIN_WRITE_RATE_LIMIT /
 * env.DASHBOARD_RATE_LIMIT)。
 *
 *   - STATE_CHANGE: kill-switch 等の致命的な state 変更。5 req / 60s。
 *   - ADMIN_WRITE:  override / seed / clear-cooldown 等の運用書込。20 req / 60s。
 *   - DASHBOARD:    read-only dashboard GET の soft cap。60 req / 60s。
 */
export type RateLimitCategory = 'STATE_CHANGE' | 'ADMIN_WRITE' | 'DASHBOARD'

const BINDING_KEY: Record<RateLimitCategory, keyof Env> = {
  STATE_CHANGE: 'STATE_CHANGE_RATE_LIMIT',
  ADMIN_WRITE: 'ADMIN_WRITE_RATE_LIMIT',
  DASHBOARD: 'DASHBOARD_RATE_LIMIT',
}

/**
 * Returns a Hono middleware that rate-limits the request via the Cloudflare
 * Workers `RateLimit` binding for `category`。
 *
 * Key 戦略: actor (Access middleware が `c.set('actor', ...)` で立てる場合)
 * を優先し、無ければ `cf-connecting-ip`、それも無ければ 'unknown'。
 *
 * Binding が未設定 (local miniflare で `[[unsafe.bindings]]` が認識されない等)
 * の場合は warn して fail-open: dev で middleware 全体が壊れる方が POC では
 * リスクが大きいため。Production では wrangler.jsonc 側に binding が必ず
 * 入っているのでこのケースは通常起きない。
 *
 * 429 時は `Retry-After: 60` ヘッダ + JSON body
 * `{ error: 'rate_limited', retry_after: 60 }` を返す。
 */
export function rateLimit(category: RateLimitCategory): MiddlewareHandler<AppBindings> {
  const envKey = BINDING_KEY[category]
  return async (c, next) => {
    const binding = c.env[envKey] as RateLimit | undefined
    if (!binding || typeof binding.limit !== 'function') {
      console.warn(
        JSON.stringify({
          event: 'rate_limit_binding_missing',
          category,
          envKey,
          requestId: c.get('requestId') ?? null,
        }),
      )
      await next()
      return
    }

    const key = resolveRateLimitKey(c)
    const outcome = await binding.limit({ key })
    if (!outcome.success) {
      c.header('Retry-After', '60')
      return c.json({ error: 'rate_limited', retry_after: 60 }, 429)
    }
    await next()
  }
}

/**
 * actor (Access middleware の placeholder) → cf-connecting-ip → 'unknown' の
 * 優先順で rate-limit key を解決する。Lane A (#29) が actor を立てるまでは
 * IP fallback で十分機能する。
 */
function resolveRateLimitKey(
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
): string {
  const actor = c.get('actor' as never) as string | undefined
  if (typeof actor === 'string' && actor.length > 0) return `actor:${actor}`
  const ip = c.req.header('cf-connecting-ip')
  if (typeof ip === 'string' && ip.length > 0) return `ip:${ip}`
  return 'unknown'
}
