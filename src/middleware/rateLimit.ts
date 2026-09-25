import type { MiddlewareHandler } from 'hono'
import type { AppBindings } from '../app'
import type { Env } from '../config/env'

// Limits themselves live in wrangler.jsonc's RateLimit bindings, not here:
//   - STATE_CHANGE: kill-switch etc. — 5 req/60s
//   - ADMIN_WRITE:  override/seed/clear-cooldown etc. — 20 req/60s
//   - DASHBOARD:    read-only dashboard GET soft cap — 60 req/60s
export type RateLimitCategory = 'STATE_CHANGE' | 'ADMIN_WRITE' | 'DASHBOARD'

const BINDING_KEY: Record<RateLimitCategory, keyof Env> = {
  STATE_CHANGE: 'STATE_CHANGE_RATE_LIMIT',
  ADMIN_WRITE: 'ADMIN_WRITE_RATE_LIMIT',
  DASHBOARD: 'DASHBOARD_RATE_LIMIT',
}

// A missing binding (e.g. local miniflare not picking up `[[unsafe.bindings]]`) warns and
// fails open rather than breaking the whole middleware chain — acceptable in dev/POC since
// production always has the binding configured in wrangler.jsonc.
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
    let outcome: { success: boolean }
    try {
      outcome = await binding.limit({ key })
    } catch (err) {
      // Fails open: a transient RateLimit binding outage shouldn't 500 admin/dashboard traffic.
      console.warn(
        JSON.stringify({
          event: 'rate_limit_check_failed',
          category,
          envKey,
          key,
          error: err instanceof Error ? err.message : String(err),
          requestId: c.get('requestId') ?? null,
        }),
      )
      await next()
      return
    }
    if (!outcome.success) {
      c.header('Retry-After', '60')
      return c.json({ error: 'rate_limited', retry_after: 60 }, 429)
    }
    await next()
  }
}

function resolveRateLimitKey(
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
): string {
  const actor = c.get('actor' as never) as string | undefined
  if (typeof actor === 'string' && actor.length > 0) return `actor:${actor}`
  const ip = c.req.header('cf-connecting-ip')
  if (typeof ip === 'string' && ip.length > 0) return `ip:${ip}`
  return 'unknown'
}
