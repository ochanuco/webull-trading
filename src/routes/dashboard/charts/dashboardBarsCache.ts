/**
 * dashboard 表示専用の短TTLキャッシュ (#charts-symbol-redesign — 銘柄切替高速化)。
 *
 * Cloudflare Workers の Cache API (`caches.default`) を cache-aside で使う。
 * 実 URL への fetch は発生させず、`symbol` / `kind` から組んだ合成 URL を
 * キャッシュキーとして使う (KV 的用途)。
 *
 * **安全制約 (重要)**: このキャッシュは dashboard loader 層
 * (`src/routes/dashboard/` 配下) にのみ実装する。`src/infrastructure/quotes/`
 * (`YahooBarClient` / `BarClient`) は取引 cron (`runStrategyCron`) と共有して
 * いるため一切変更しない。ここでラップするのは「dashboard route が呼び出す
 * 側」だけであり、cron が使う bar 取得経路のデータ鮮度には影響しない。
 *
 * Workers runtime 以外 (vitest の Node 環境) では `caches` global が無いため
 * その場合は cache を素通しして `loader()` を直接呼ぶ (fail-open: 遅いだけで
 * 壊れない。テストでも同様に振る舞う)。
 */

const CACHE_KEY_ORIGIN = 'https://dashboard-bars-cache.internal'

/** dashboard bars キャッシュの TTL (秒)。表示専用の緩衝であり取引判断には使わない。 */
export const DASHBOARD_BARS_CACHE_TTL_SECONDS = 300

/** `caches.default` が実装すべき最小 interface (テストでは fake を注入できるように)。 */
export interface DashboardCacheLike {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

/**
 * 合成キャッシュキーを組む。例:
 * `https://dashboard-bars-cache.internal/v1?symbol=SOXL&kind=intraday15m`
 */
export function buildDashboardCacheKey(kind: string, params: Record<string, string>): Request {
  const url = new URL(`${CACHE_KEY_ORIGIN}/v1`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('kind', kind)
  return new Request(url.toString())
}

function resolveDefaultCache(): DashboardCacheLike | undefined {
  // `caches` は Workers runtime のグローバル (型は @cloudflare/workers-types)。
  // Node (vitest) には無いので defensive に参照する。
  const g = globalThis as unknown as { caches?: { default: DashboardCacheLike } }
  return g.caches?.default
}

/**
 * cache-aside で `loader()` の JSON-serializable な結果をキャッシュする。
 *
 * - hit: cache から parse して返す (loader は呼ばない)
 * - miss: `loader()` を実行し、`shouldCache(value)` が true なら
 *   `Cache-Control: max-age=<ttlSeconds>` を付けた合成 Response を put してから返す
 * - `loader()` が throw した場合はそのまま呼出元に伝播する (エラーのキャッシュはしない)
 * - cache の read/write 自体の失敗 (Cache API 一時エラー等) は無視して
 *   loader の結果をそのまま返す (キャッシュは高速化目的のみ、正しさに影響させない)
 *
 * `shouldCache` は既定で常に true。呼出元は「fetch 失敗時の空配列 fallback を
 * 5分キャッシュして outage からの回復を遅らせたくない」ケースで
 * `(v) => Array.isArray(v) ? v.length > 0 : true` 等を渡せる。
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
      // cache 読み取り失敗 (一時的な Cache API エラー等) は無視して loader にフォールバック
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
      // put 失敗はキャッシュが効かないだけ (高速化を逃すのみ) なので無視
    }
  }
  return value
}
