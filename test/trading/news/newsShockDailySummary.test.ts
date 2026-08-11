import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runNewsShockDailySummary } from '../../../src/trading/news/newsShockDailySummary'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { createNotifier } from '../../../src/infrastructure/notification/createNotifier'
import { makeGlobalConfigSnapshot } from '../../helpers/configFixtures'
import type { Env } from '../../../src/config/env'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'
import type { AttentionObservationRow } from '../../../src/infrastructure/db/schema'

/**
 * news shock gate 日次サマリ通知 (news-shock-gate follow-up) のテスト。
 *
 * `runPortfolioRoll` / `newsScheduler` 系と同じ「D1 read を drizzle plumbing
 * ごと fake するのは重い」判断で、`attentionObservationRepo` はモジュール
 * ごと mock する (`runStrategyCron.test.ts` と同パターン)。
 */

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/notification/createNotifier', () => ({
  createNotifier: vi.fn(),
}))

type FetchRecentFilter = { source: string; probeKey: string; metric: string; sinceIso: string }

const fetchRecentMock = vi.fn(async (_filter: FetchRecentFilter): Promise<AttentionObservationRow[]> => [])

vi.mock('../../../src/infrastructure/db/attentionObservationRepo', () => ({
  createAttentionObservationDb: vi.fn(() => ({}) as unknown),
  createAttentionObservationRepo: vi.fn(() => ({
    fetchRecent: (filter: FetchRecentFilter) => fetchRecentMock(filter),
    bulkInsertIgnore: vi.fn(),
    purgeOlderThan: vi.fn(),
  })),
}))

/** `sqlite_master` probe で `attention_observation` だけ ready 扱いの fake D1。 */
function fakeDbWithAttentionReady(): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      first: vi.fn(async () => (sql.includes("name='attention_observation'") ? { ok: 1 } : null)),
    })),
  } as unknown as D1Database
}

function makeRow(bucketAt: string, value: number): AttentionObservationRow {
  return { bucketAt, value } as AttentionObservationRow
}

/**
 * `trump_macro` を静穏 (ratio=1.0x, normal)、`market_selloff` を warning
 * (ratio=3.0x) にする観測データを配る。asOf は呼び出し時点の `now()`
 * (`vi.setSystemTime` で固定) を基準に、baseline 5点 (6日前〜2日前, value=1) +
 * window 内 1点 (asOf ちょうど) を probe ごとに用意する。
 */
function seedTwoProbeObservations(asOf: Date): void {
  const baseline = (spikeValue: number): AttentionObservationRow[] => {
    const points: AttentionObservationRow[] = []
    for (let daysAgo = 6; daysAgo >= 2; daysAgo -= 1) {
      points.push(makeRow(new Date(asOf.getTime() - daysAgo * 24 * 60 * 60_000).toISOString(), 1))
    }
    points.push(makeRow(asOf.toISOString(), spikeValue))
    return points
  }
  fetchRecentMock.mockImplementation(async (filter: FetchRecentFilter) => {
    if (filter.metric !== 'volume') return []
    if (filter.probeKey === 'trump_macro') return baseline(1) // ratio = 1/1 = 1.0x → normal
    if (filter.probeKey === 'market_selloff') return baseline(3) // ratio = 3/1 = 3.0x → warning
    return []
  })
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDbWithAttentionReady(),
    SYMBOL_STATE: {} as DurableObjectNamespace<never>,
    ...overrides,
  } as unknown as Env
}

describe('runNewsShockDailySummary', () => {
  let notifyMock: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-25T12:00:00.000Z'))
    vi.mocked(loadGlobalConfigFrom).mockReset()
    vi.mocked(createNotifier).mockReset()
    notifyMock = vi.fn().mockResolvedValue(undefined)
    vi.mocked(createNotifier).mockReturnValue({ notify: notifyMock } as Notifier)
    fetchRecentMock.mockReset()
    fetchRecentMock.mockResolvedValue([])
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    warnSpy.mockRestore()
  })

  it('does not notify when news_shock_mode=off', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot({ newsShockMode: 'off' }))

    await runNewsShockDailySummary(makeEnv(), 'req-off')

    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('does not notify when env.DB is unavailable', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot({ newsShockMode: 'observe' }))

    await runNewsShockDailySummary(makeEnv({ DB: undefined }), 'req-nodb')

    expect(notifyMock).not.toHaveBeenCalled()
    expect(loadGlobalConfigFrom).not.toHaveBeenCalled()
  })

  it('sends one SUMMARY notification with both probe lines and the combined regime (observe mode)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ newsShockMode: 'observe', newsShockMinSamples: 5 }),
    )
    seedTwoProbeObservations(new Date())

    await runNewsShockDailySummary(makeEnv(), 'req-summary')

    expect(notifyMock).toHaveBeenCalledTimes(1)
    const event = notifyMock.mock.calls[0]![0] as NotificationEvent
    expect(event.type).toBe('SUMMARY')
    if (event.type !== 'SUMMARY') throw new Error('unreachable')
    expect(event.kind).toBe('news_shock_daily_summary')
    expect(event.message).toContain('mode=observe')
    expect(event.message).toContain('合成 regime=warning')
    expect(event.message).toContain('- trump_macro:')
    expect(event.message).toContain('- market_selloff:')
  })

  it('uses severity=warning when the combined regime is warning', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ newsShockMode: 'observe', newsShockMinSamples: 5 }),
    )
    seedTwoProbeObservations(new Date())

    await runNewsShockDailySummary(makeEnv(), 'req-severity')

    const event = notifyMock.mock.calls[0]![0] as NotificationEvent
    expect(event.type).toBe('SUMMARY')
    if (event.type !== 'SUMMARY') throw new Error('unreachable')
    expect(event.severity).toBe('warning')
  })

  it('does not notify when the attention_observation table is not migrated yet', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot({ newsShockMode: 'observe' }))
    const dbWithoutTable = { prepare: vi.fn(() => ({ first: vi.fn(async () => null) })) } as unknown as D1Database

    await runNewsShockDailySummary(makeEnv({ DB: dbWithoutTable }), 'req-no-table')

    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('never throws even if loadGlobalConfigFrom rejects (D1 failure)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockRejectedValue(new Error('D1 timeout'))

    await expect(runNewsShockDailySummary(makeEnv(), 'req-fail')).resolves.toBeUndefined()
    expect(notifyMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })
})
