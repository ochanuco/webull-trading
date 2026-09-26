import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDailySummaryMessage, runNewsShockDailySummary, summarizeRows } from '../../../src/trading/news/newsShockDailySummary'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { createNotifier } from '../../../src/infrastructure/notification/createNotifier'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../../src/infrastructure/db/newsHeadlineEvalRepo'
import { makeGlobalConfigSnapshot } from '../../helpers/configFixtures'
import type { Env } from '../../../src/config/env'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'
import type { NewsHeadlineEvalRow } from '../../../src/infrastructure/db/schema'

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/notification/createNotifier', () => ({
  createNotifier: vi.fn(),
}))

const fetchLatestMock = vi.fn(async (): Promise<NewsHeadlineEvalRow | null> => null)
const fetchSinceMock = vi.fn(async (): Promise<NewsHeadlineEvalRow[]> => [])

vi.mock('../../../src/infrastructure/db/newsHeadlineEvalRepo', () => ({
  createNewsHeadlineEvalDb: vi.fn(() => ({}) as unknown),
  createNewsHeadlineEvalRepo: vi.fn(() => ({
    insertIgnore: vi.fn(),
    fetchLatest: () => fetchLatestMock(),
    fetchSince: () => fetchSinceMock(),
  })),
}))

function fakeDbWithHeadlineEvalReady(): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      first: vi.fn(async () => (sql.includes("name='news_headline_eval'") ? { ok: 1 } : null)),
    })),
  } as unknown as D1Database
}

function row(overrides: Partial<NewsHeadlineEvalRow> = {}): NewsHeadlineEvalRow {
  return {
    id: 1,
    evaluatedAt: new Date().toISOString(),
    source: 'yahoo_finance_rss',
    query: '^GSPC,^DJI,^IXIC,^VIX,SPY,QQQ',
    headlineCount: 5,
    headlinesJson: '[]',
    status: 'ok',
    error: null,
    model: 'jev-1.13.0',
    shock: 0.1,
    direction: 'risk_on',
    directionConfidence: 1,
    severity: 0,
    severityConfidence: 1,
    scope: 'broad_us_market',
    scopeConfidence: 1,
    answersJson: '{}',
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    requestId: null,
    ...overrides,
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeDbWithHeadlineEvalReady(),
    SYMBOL_STATE: {} as DurableObjectNamespace<never>,
    ...overrides,
  } as unknown as Env
}

describe('runNewsShockDailySummary', () => {
  let notifyMock: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00.000Z'))
    vi.mocked(loadGlobalConfigFrom).mockReset()
    vi.mocked(createNotifier).mockReset()
    notifyMock = vi.fn().mockResolvedValue(undefined)
    vi.mocked(createNotifier).mockReturnValue({ notify: notifyMock } as Notifier)
    fetchLatestMock.mockReset().mockResolvedValue(null)
    fetchSinceMock.mockReset().mockResolvedValue([])
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

  it('does not notify when the news_headline_eval table is not migrated yet', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot({ newsShockMode: 'observe' }))
    const dbWithoutTable = { prepare: vi.fn(() => ({ first: vi.fn(async () => null) })) } as unknown as D1Database

    await runNewsShockDailySummary(makeEnv({ DB: dbWithoutTable }), 'req-no-table')

    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('sends a readable SUMMARY notification describing the current regime and the day coverage', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot({ newsShockMode: 'observe' }))
    fetchLatestMock.mockResolvedValue(row({ shock: 0.6, direction: 'risk_off' }))
    fetchSinceMock.mockResolvedValue([
      row({ status: 'ok', shock: 0.1 }),
      row({ status: 'ok', shock: 0.6, direction: 'risk_off' }),
      row({ status: 'fetch_error', shock: null, direction: null }),
    ])

    await runNewsShockDailySummary(makeEnv(), 'req-summary')

    expect(notifyMock).toHaveBeenCalledTimes(1)
    const event = notifyMock.mock.calls[0]![0] as NotificationEvent
    expect(event.type).toBe('SUMMARY')
    if (event.type !== 'SUMMARY') throw new Error('unreachable')
    expect(event.kind).toBe('news_shock_daily_summary')
    expect(event.message).toContain('⚠️ **ニュース急落ゲート (Jev)：警戒**')
    expect(event.message).toContain('観測モード / 発注には影響しません')
    expect(event.message).toContain('OK 2件 / エラー 1件')
    expect(event.message).toContain('fetch_error 1')
    expect(event.message).toContain('最大 shock: **0.60**')
    expect(event.severity).toBe('warning')
  })

  it('shows 判定不能 when there is no row yet', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot({ newsShockMode: 'observe' }))
    fetchLatestMock.mockResolvedValue(null)
    fetchSinceMock.mockResolvedValue([])

    await runNewsShockDailySummary(makeEnv(), 'req-empty')

    const event = notifyMock.mock.calls[0]![0] as NotificationEvent
    expect(event.type).toBe('SUMMARY')
    if (event.type !== 'SUMMARY') throw new Error('unreachable')
    expect(event.message).toContain('❔ **ニュース急落ゲート (Jev)：判定不能**')
    expect(event.message).toContain('現在値: 判定不能')
    expect(event.message).toContain('OK 0件 / エラー 0件')
    expect(event.severity).toBe('info')
  })

  it('never throws even if loadGlobalConfigFrom rejects (D1 failure)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockRejectedValue(new Error('D1 timeout'))

    await expect(runNewsShockDailySummary(makeEnv(), 'req-fail')).resolves.toBeUndefined()
    expect(notifyMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })
})

describe('summarizeRows', () => {
  it('counts ok rows and errors by status, tracking the highest shock among ok rows', () => {
    const rows: NewsHeadlineEvalRow[] = [
      row({ status: 'ok', shock: 0.2 }),
      row({ status: 'ok', shock: 0.9, direction: 'risk_off', evaluatedAt: '2026-09-27T10:00:00.000Z' }),
      row({ status: 'fetch_error', shock: null }),
      row({ status: 'jev_error', shock: null }),
      row({ status: 'fetch_error', shock: null }),
    ]
    const stats = summarizeRows(rows)
    expect(stats.total).toBe(5)
    expect(stats.okCount).toBe(2)
    expect(stats.errorCounts).toEqual({ fetch_error: 2, jev_error: 1 })
    expect(stats.maxShock).toEqual({ value: 0.9, evaluatedAt: '2026-09-27T10:00:00.000Z', direction: 'risk_off' })
  })

  it('returns maxShock=null when no ok row has a non-null shock', () => {
    const rows: NewsHeadlineEvalRow[] = [row({ status: 'no_headlines', shock: null })]
    const stats = summarizeRows(rows)
    expect(stats.maxShock).toBeNull()
  })

  it('returns zeroed stats for an empty window', () => {
    expect(summarizeRows([])).toEqual({ total: 0, okCount: 0, errorCounts: {}, maxShock: null })
  })
})

describe('buildDailySummaryMessage', () => {
  const now = new Date('2026-09-27T12:00:00.000Z')

  it('describes an enforce-mode critical regime as reflected in orders', () => {
    const message = buildDailySummaryMessage(
      {
        regime: 'critical',
        sizeScale: 0,
        reason: 'news_shock_critical: shock=0.94 direction=risk_off age=5m (block)',
        shock: 0.94,
        direction: 'risk_off',
        rowEvaluatedAt: '2026-09-27T11:55:00.000Z',
        asOf: now.toISOString(),
      },
      { total: 10, okCount: 10, errorCounts: {}, maxShock: { value: 0.94, evaluatedAt: '2026-09-27T11:55:00.000Z', direction: 'risk_off' } },
      'enforce',
      now,
    )
    expect(message).toContain('🔴 **ニュース急落ゲート (Jev)：急落**')
    expect(message).toContain('発注に反映されています')
  })
})
