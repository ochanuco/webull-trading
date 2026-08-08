import { describe, expect, it, vi } from 'vitest'
import {
  buildDashboardCacheKey,
  cachedDashboardJson,
  type DashboardCacheLike,
} from '../../src/routes/dashboard/charts/dashboardBarsCache'

/**
 * `caches.default` (Cloudflare Cache API) の最小 fake。vitest (Node) には
 * `caches` global が無いので、テストでは `cache` を明示注入して検証する
 * (本番は `resolveDefaultCache()` が `caches.default` を拾う — その fail-open
 * 挙動は「cache 未注入」ケースで確認する)。
 */
function fakeCache(): DashboardCacheLike & { store: Map<string, Response> } {
  const store = new Map<string, Response>()
  return {
    store,
    async match(request: Request) {
      const hit = store.get(request.url)
      return hit ? hit.clone() : undefined
    },
    async put(request: Request, response: Response) {
      store.set(request.url, response.clone())
    },
  }
}

describe('buildDashboardCacheKey', () => {
  it('symbol → kind の順で合成 URL を組む (kind は末尾)', () => {
    const req = buildDashboardCacheKey('intraday15m', { symbol: 'SOXL' })
    expect(req.url).toBe('https://dashboard-bars-cache.internal/v1?symbol=SOXL&kind=intraday15m')
  })

  it('params が違えば別 key になる', () => {
    const a = buildDashboardCacheKey('dailyBars60', { symbol: 'TQQQ' })
    const b = buildDashboardCacheKey('dailyBars60', { symbol: 'SOXL' })
    expect(a.url).not.toBe(b.url)
  })
})

describe('cachedDashboardJson', () => {
  it('miss → loader を呼び、値を put してから返す', async () => {
    const cache = fakeCache()
    const loader = vi.fn(async () => [{ close: 100 }])
    const value = await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    expect(value).toEqual([{ close: 100 }])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(cache.store.size).toBe(1)
  })

  it('hit → loader を呼ばずキャッシュ値を返す', async () => {
    const cache = fakeCache()
    const loader = vi.fn(async () => [{ close: 100 }])
    await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    const value = await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    expect(value).toEqual([{ close: 100 }])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('symbol が違えば別キーなので miss → loader が再度呼ばれる', async () => {
    const cache = fakeCache()
    const loader = vi.fn(async () => [{ close: 100 }])
    await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    await cachedDashboardJson('dailyBars60', { symbol: 'SOXL' }, loader, { cache })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('kind が違えば別キーなので miss → loader が再度呼ばれる (同一 symbol でも daily/intraday を混同しない)', async () => {
    const cache = fakeCache()
    const loader = vi.fn(async () => [{ close: 100 }])
    await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    await cachedDashboardJson('intraday15m', { symbol: 'TQQQ' }, loader, { cache })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('shouldCache が false を返す値 (空配列 fallback 等) は put しない → 次回も loader を呼ぶ', async () => {
    const cache = fakeCache()
    const loader = vi.fn(async () => [] as unknown[])
    await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, {
      cache,
      shouldCache: (v) => v.length > 0,
    })
    expect(cache.store.size).toBe(0)
    await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, {
      cache,
      shouldCache: (v) => v.length > 0,
    })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('loader が throw したら put せずそのまま呼出元に伝播する', async () => {
    const cache = fakeCache()
    const loader = vi.fn(async () => {
      throw new RangeError('boom')
    })
    await expect(
      cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache }),
    ).rejects.toBeInstanceOf(RangeError)
    expect(cache.store.size).toBe(0)
  })

  it('cache 未注入 (Workers runtime 外) は素通しで loader を毎回呼ぶ (fail-open)', async () => {
    const loader = vi.fn(async () => [{ close: 100 }])
    const value = await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, {
      cache: undefined,
    })
    expect(value).toEqual([{ close: 100 }])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('cache.match が失敗しても loader にフォールバックして値を返す', async () => {
    const cache: DashboardCacheLike = {
      match: vi.fn(async () => {
        throw new Error('cache read failed')
      }),
      put: vi.fn(async () => {}),
    }
    const loader = vi.fn(async () => [{ close: 100 }])
    const value = await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    expect(value).toEqual([{ close: 100 }])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('cache.put が失敗しても値は返る (書き込み失敗は無視)', async () => {
    const cache: DashboardCacheLike = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new Error('cache write failed')
      }),
    }
    const loader = vi.fn(async () => [{ close: 100 }])
    const value = await cachedDashboardJson('dailyBars60', { symbol: 'TQQQ' }, loader, { cache })
    expect(value).toEqual([{ close: 100 }])
  })
})
