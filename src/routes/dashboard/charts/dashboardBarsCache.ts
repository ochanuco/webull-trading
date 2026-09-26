// Cache-aside over the Cloudflare Cache API (`caches.default`), scoped to
// `src/routes/dashboard/` only. `src/infrastructure/quotes/`
// (YahooBarClient/BarClient) is shared with the trading cron — wrapping it
// there instead would let a stale dashboard cache leak into trading
// decisions, so every cached call is made from this route layer.

const CACHE_KEY_ORIGIN = 'https://dashboard-bars-cache.internal'

const DASHBOARD_BARS_CACHE_TTL_SECONDS = 300

/** Minimal shape of `caches.default`, narrowed so tests can inject a fake. */
export interface DashboardCacheLike {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export function buildDashboardCacheKey(kind: string, params: Record<string, string>): Request {
  const url = new URL(`${CACHE_KEY_ORIGIN}/v1`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('kind', kind)
  return new Request(url.toString())
}

function resolveDefaultCache(): DashboardCacheLike | undefined {
  // `caches` doesn't exist outside the Workers runtime (e.g. vitest's Node
  // env) — optional-chained rather than asserted so those callers fail open
  // to an uncached loader instead of throwing.
  const g = globalThis as unknown as { caches?: { default: DashboardCacheLike } }
  return g.caches?.default
}

/**
 * `shouldCache` defaults to always-true; pass e.g. `(v) => v.length > 0` to
 * skip caching a fallback value (an empty array from a failed fetch) so an
 * outage doesn't get pinned for a full TTL.
 */
export async function cachedDashboardJson<T>(
  kind: string,
  params: Record<string, string>,
  loader: () => Promise<T>,
  options: {
    cache?: DashboardCacheLike | undefined
    ttlSeconds?: number
    shouldCache?: (value: T) => boolean
  } = {},
): Promise<T> {
  const cache = options.cache !== undefined ? options.cache : resolveDefaultCache()
  const ttlSeconds = options.ttlSeconds ?? DASHBOARD_BARS_CACHE_TTL_SECONDS
  const shouldCache = options.shouldCache ?? (() => true)
  const key = buildDashboardCacheKey(kind, params)

  if (cache) {
    try {
      const hit = await cache.match(key)
      if (hit) {
        return (await hit.json()) as T
      }
    } catch {
      // A transient Cache API error falls through to the loader rather than
      // failing the request — the cache is a speed-up, not a dependency.
    }
  }

  const value = await loader()

  if (cache && shouldCache(value)) {
    const response = new Response(JSON.stringify(value), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${ttlSeconds}`,
      },
    })
    try {
      await cache.put(key, response)
    } catch {
      // Same as the read path above: a write failure just loses the
      // speed-up for next time, not the response.
    }
  }
  return value
}
