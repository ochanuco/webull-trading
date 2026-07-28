import { describe, expect, it, vi } from 'vitest'
import { runNewsScheduler } from '../../../src/trading/news/newsScheduler'
import type { GdeltDocClient, GdeltMetric, GdeltTimelinePoint } from '../../../src/infrastructure/news/GdeltDocClient'
import type { Env } from '../../../src/config/env'

function fakeClient(
  handler: (query: string, metric: GdeltMetric) => GdeltTimelinePoint[] | Promise<GdeltTimelinePoint[]>,
): { client: GdeltDocClient; getTimeline: ReturnType<typeof vi.fn> } {
  const getTimeline = vi.fn(async (query: string, metric: GdeltMetric) => handler(query, metric))
  return { client: { getTimeline } as unknown as GdeltDocClient, getTimeline }
}

/** D1 の insert チェーンを最小限モックする fake env.DB (drizzle 経由で 1 chunk だけ通す)。 */
function fakeDb(): D1Database {
  const preparedStatement = {
    bind: vi.fn(() => preparedStatement),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ success: true, results: [] })),
    first: vi.fn(async () => null),
    raw: vi.fn(async () => []),
  }
  return {
    prepare: vi.fn(() => preparedStatement),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    dump: vi.fn(async () => new ArrayBuffer(0)),
  } as unknown as D1Database
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NEWS_ATTENTION_ENABLED: 'true',
    DB: fakeDb(),
    ...overrides,
  } as unknown as Env
}

describe('runNewsScheduler — opt-in gate', () => {
  it('NEWS_ATTENTION_ENABLED 未設定なら fetch を1回も呼ばず即 return する', async () => {
    const { client, getTimeline } = fakeClient(() => [])
    const env = makeEnv({ NEWS_ATTENTION_ENABLED: undefined })
    const summary = await runNewsScheduler({ env, client })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('news_attention_disabled')
    expect(getTimeline).not.toHaveBeenCalled()
  })

  it("NEWS_ATTENTION_ENABLED が 'false' / 任意の非 'true' 値でも無効", async () => {
    const { client, getTimeline } = fakeClient(() => [])
    const env = makeEnv({ NEWS_ATTENTION_ENABLED: 'false' })
    const summary = await runNewsScheduler({ env, client })
    expect(summary.ran).toBe(false)
    expect(getTimeline).not.toHaveBeenCalled()
  })

  it('env.DB が無ければ fetch を呼ばず db_unavailable を返す', async () => {
    const { client, getTimeline } = fakeClient(() => [])
    const env = makeEnv({ DB: undefined })
    const summary = await runNewsScheduler({ env, client })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('db_unavailable')
    expect(getTimeline).not.toHaveBeenCalled()
  })
})

describe('runNewsScheduler — probe round-robin', () => {
  it('1 tick = 1 リクエストのみ (getTimeline は毎回 1 回だけ呼ばれる)', async () => {
    const { client, getTimeline } = fakeClient(() => [])
    const env = makeEnv()
    await runNewsScheduler({ env, client, now: () => new Date('2026-07-24T14:30:00.000Z') })
    expect(getTimeline).toHaveBeenCalledTimes(1)
  })

  it('連続する 5 分スロットは異なる probe/metric の組に進む (round-robin)', async () => {
    const env = makeEnv()
    const seen: Array<{ probeKey?: string; metric?: GdeltMetric }> = []
    // 4 組 (2 probe × 2 metric) を 5 分刻みで叩き、全て異なる組み合わせであること。
    for (let i = 0; i < 4; i += 1) {
      const { client } = fakeClient(() => [])
      const now = new Date(new Date('2026-07-24T14:30:00.000Z').getTime() + i * 5 * 60 * 1000)
      const summary = await runNewsScheduler({ env, client, now: () => now })
      seen.push({ probeKey: summary.probeKey, metric: summary.metric })
    }
    const unique = new Set(seen.map((s) => `${s.probeKey}:${s.metric}`))
    expect(unique.size).toBe(4)
  })

  it('同一スロット (同一時刻) は同じ probe/metric を選ぶ (ステートレスな決定性)', async () => {
    const env = makeEnv()
    const now = new Date('2026-07-24T14:30:00.000Z')
    const { client: client1 } = fakeClient(() => [])
    const { client: client2 } = fakeClient(() => [])
    const s1 = await runNewsScheduler({ env, client: client1, now: () => now })
    const s2 = await runNewsScheduler({ env, client: client2, now: () => now })
    expect(s1.probeKey).toBe(s2.probeKey)
    expect(s1.metric).toBe(s2.metric)
  })

  it('5 分刻みで一周 (4 組) すると最初の組に戻る', async () => {
    const env = makeEnv()
    const base = new Date('2026-07-24T14:30:00.000Z').getTime()
    const results: Array<{ probeKey?: string; metric?: GdeltMetric }> = []
    for (let i = 0; i < 5; i += 1) {
      const { client } = fakeClient(() => [])
      const now = new Date(base + i * 5 * 60 * 1000)
      const summary = await runNewsScheduler({ env, client, now: () => now })
      results.push({ probeKey: summary.probeKey, metric: summary.metric })
    }
    expect(results[4]).toEqual(results[0])
  })
})

describe('runNewsScheduler — fail-safe (never throws)', () => {
  it('fetch が throw しても scheduler は throw せず reason=error を返す', async () => {
    const { client } = fakeClient(() => {
      throw new Error('GDELT rate limited')
    })
    const env = makeEnv()
    await expect(runNewsScheduler({ env, client })).resolves.not.toThrow()
    const summary = await runNewsScheduler({ env, client })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('error')
  })

  it('fetch が reject する Promise を返しても throw せず握りつぶす', async () => {
    const { client } = fakeClient(async () => Promise.reject(new Error('timeout')))
    const env = makeEnv()
    const summary = await runNewsScheduler({ env, client })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('error')
  })
})

describe('runNewsScheduler — happy path', () => {
  it('取得した点を bulkInsertIgnore 相当の repo write に渡し、fetched 件数を summary に反映する', async () => {
    const points: GdeltTimelinePoint[] = [
      { bucketAt: '2026-07-24T14:30:00.000Z', value: 0.5 },
      { bucketAt: '2026-07-24T14:45:00.000Z', value: 0.6 },
    ]
    const { client, getTimeline } = fakeClient(() => points)
    const env = makeEnv()
    const summary = await runNewsScheduler({ env, client, requestId: 'req-1' })
    expect(summary.ran).toBe(true)
    expect(summary.fetched).toBe(2)
    expect(getTimeline).toHaveBeenCalledTimes(1)
    expect(summary.probeKey).toBeDefined()
    expect(summary.metric).toBeDefined()
  })
})
