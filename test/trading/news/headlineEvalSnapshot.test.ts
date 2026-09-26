import { describe, expect, it, vi } from 'vitest'
import {
  buildHeadlineEvalSnapshot,
  loadHeadlineEvalSnapshot,
} from '../../../src/trading/news/headlineEvalSnapshot'
import type { NewsHeadlineEvalRow } from '../../../src/infrastructure/db/schema'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../../src/infrastructure/db/newsHeadlineEvalRepo'

vi.mock('../../../src/infrastructure/db/newsHeadlineEvalRepo', () => ({
  createNewsHeadlineEvalDb: vi.fn(() => ({}) as unknown),
  createNewsHeadlineEvalRepo: vi.fn(),
}))

function row(overrides: Partial<NewsHeadlineEvalRow> = {}): NewsHeadlineEvalRow {
  return {
    id: 1,
    evaluatedAt: '2026-09-26T12:00:00.000Z',
    source: 'google_news_rss',
    query: '("stock market") when:1h',
    headlineCount: 5,
    headlinesJson: '[]',
    status: 'ok',
    error: null,
    model: 'jev-1.13.0',
    shock: 0.94,
    direction: 'risk_off',
    directionConfidence: 1,
    severity: 3.08,
    severityConfidence: 0.23,
    scope: 'broad_us_market',
    scopeConfidence: 1,
    answersJson: '{}',
    inputTokens: 810,
    outputTokens: 139,
    latencyMs: 500,
    requestId: 'req-1',
    ...overrides,
  }
}

describe('buildHeadlineEvalSnapshot', () => {
  it('returns available:false reason:no_row for a null row', () => {
    expect(buildHeadlineEvalSnapshot(null, new Date('2026-09-26T12:15:00.000Z'))).toEqual({
      available: false,
      reason: 'no_row',
    })
  })

  it('projects the row plus computed ageMin for a present row', () => {
    const snapshot = buildHeadlineEvalSnapshot(row(), new Date('2026-09-26T12:15:00.000Z'))
    expect(snapshot).toEqual({
      available: true,
      evaluatedAt: '2026-09-26T12:00:00.000Z',
      ageMin: 15,
      status: 'ok',
      shock: 0.94,
      direction: 'risk_off',
      directionConfidence: 1,
      severity: 3.08,
      severityConfidence: 0.23,
      scope: 'broad_us_market',
      scopeConfidence: 1,
      headlineCount: 5,
    })
  })

  it('records a non-ok status as-is with whatever scores the row has, without a staleness cutoff', () => {
    const snapshot = buildHeadlineEvalSnapshot(
      row({ status: 'fetch_error', shock: null, direction: null, severity: null, scope: null }),
      new Date('2026-09-27T12:00:00.000Z'), // 24h stale
    )
    expect(snapshot).toEqual(
      expect.objectContaining({ available: true, status: 'fetch_error', shock: null, ageMin: 24 * 60 }),
    )
  })
})

describe('loadHeadlineEvalSnapshot', () => {
  it('queries fetchLatest with the google_news_rss source and the given now, returning the built snapshot', async () => {
    const fetchLatest = vi.fn(async () => row())
    vi.mocked(createNewsHeadlineEvalRepo).mockReturnValue({
      insertIgnore: vi.fn(),
      fetchLatest,
    })
    const now = new Date('2026-09-26T12:15:00.000Z')
    const snapshot = await loadHeadlineEvalSnapshot({} as D1Database, now, 'req-1')
    expect(fetchLatest).toHaveBeenCalledWith({
      source: 'google_news_rss',
      atOrBeforeIso: now.toISOString(),
    })
    expect(snapshot).toEqual(expect.objectContaining({ available: true, ageMin: 15 }))
    expect(vi.mocked(createNewsHeadlineEvalDb)).toHaveBeenCalled()
  })

  it('returns available:false reason:no_row when no row exists', async () => {
    vi.mocked(createNewsHeadlineEvalRepo).mockReturnValue({
      insertIgnore: vi.fn(),
      fetchLatest: vi.fn(async () => null),
    })
    const snapshot = await loadHeadlineEvalSnapshot({} as D1Database, new Date())
    expect(snapshot).toEqual({ available: false, reason: 'no_row' })
  })

  it('fails open to reason:load_error and never throws when the repo read rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(createNewsHeadlineEvalRepo).mockReturnValue({
      insertIgnore: vi.fn(),
      fetchLatest: vi.fn(async () => {
        throw new Error('D1 unavailable')
      }),
    })
    const snapshot = await loadHeadlineEvalSnapshot({} as D1Database, new Date())
    expect(snapshot).toEqual({ available: false, reason: 'load_error' })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
