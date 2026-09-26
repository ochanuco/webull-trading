import { describe, expect, it, vi } from 'vitest'
import {
  buildNewsShockRegimeHeadline,
  isNewsShockGateReady,
  loadNewsShockDecision,
} from '../../../src/trading/risk/newsShockDecision'
import type { NewsShockGateDecision } from '../../../src/trading/risk/newsShockGate'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../../src/infrastructure/db/newsHeadlineEvalRepo'
import type { NewsHeadlineEvalRow } from '../../../src/infrastructure/db/schema'

vi.mock('../../../src/infrastructure/db/newsHeadlineEvalRepo', () => ({
  createNewsHeadlineEvalDb: vi.fn(() => ({}) as unknown),
  createNewsHeadlineEvalRepo: vi.fn(),
}))

const ASOF = '2026-09-27T12:00:00.000Z'
const NOW = new Date(ASOF)

function row(overrides: Partial<NewsHeadlineEvalRow> = {}): NewsHeadlineEvalRow {
  return {
    id: 1,
    evaluatedAt: ASOF,
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

function decision(overrides: Partial<NewsShockGateDecision> = {}): NewsShockGateDecision {
  return {
    regime: 'normal',
    sizeScale: 1.0,
    reason: 'news_shock_normal: shock=0.10 direction=risk_on age=0m',
    shock: 0.1,
    direction: 'risk_on',
    rowEvaluatedAt: ASOF,
    asOf: ASOF,
    ...overrides,
  }
}

describe('isNewsShockGateReady', () => {
  it('returns true when news_headline_eval exists in sqlite_master', async () => {
    const db = {
      prepare: vi.fn(() => ({ first: vi.fn(async () => ({ ok: 1 })) })),
    } as unknown as D1Database
    expect(await isNewsShockGateReady(db)).toBe(true)
  })

  it('returns false when the table is missing', async () => {
    const db = { prepare: vi.fn(() => ({ first: vi.fn(async () => null) })) } as unknown as D1Database
    expect(await isNewsShockGateReady(db)).toBe(false)
  })

  it('returns false (not throw) when the query itself throws', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('D1 unavailable')
      }),
    } as unknown as D1Database
    expect(await isNewsShockGateReady(db)).toBe(false)
  })
})

describe('loadNewsShockDecision', () => {
  it('queries fetchLatest at/before now and evaluates the row it gets back', async () => {
    const fetchLatest = vi.fn(async () => row({ shock: 0.94, direction: 'risk_off' }))
    vi.mocked(createNewsHeadlineEvalRepo).mockReturnValue({
      insertIgnore: vi.fn(),
      fetchLatest,
      fetchSince: vi.fn(),
    })
    const result = await loadNewsShockDecision(
      {} as D1Database,
      { newsShockWarnSizeScale: 0.5, attentionStalePolicy: 'fail_open' },
      'req-1',
      NOW,
    )
    expect(fetchLatest).toHaveBeenCalledWith({ atOrBeforeIso: NOW.toISOString() })
    expect(result.regime).toBe('critical')
    expect(vi.mocked(createNewsHeadlineEvalDb)).toHaveBeenCalled()
  })

  it('falls back to unknown (fail-open) without throwing when the D1 read rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(createNewsHeadlineEvalRepo).mockReturnValue({
      insertIgnore: vi.fn(),
      fetchLatest: vi.fn(async () => {
        throw new Error('D1 unavailable')
      }),
      fetchSince: vi.fn(),
    })
    const result = await loadNewsShockDecision(
      {} as D1Database,
      { newsShockWarnSizeScale: 0.5, attentionStalePolicy: 'fail_open' },
      'req-2',
      NOW,
    )
    expect(result.regime).toBe('unknown')
    expect(result.sizeScale).toBe(1.0)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns unknown when no row exists', async () => {
    vi.mocked(createNewsHeadlineEvalRepo).mockReturnValue({
      insertIgnore: vi.fn(),
      fetchLatest: vi.fn(async () => null),
      fetchSince: vi.fn(),
    })
    const result = await loadNewsShockDecision(
      {} as D1Database,
      { newsShockWarnSizeScale: 0.5, attentionStalePolicy: 'fail_open' },
      undefined,
      NOW,
    )
    expect(result.regime).toBe('unknown')
    expect(result.reason).toBe('news_shock_unavailable_no_row')
  })
})

describe('buildNewsShockRegimeHeadline', () => {
  it('describes a warning entry with the shock score and the observe no-op note', () => {
    const d = decision({ regime: 'warning', sizeScale: 0.5, shock: 0.62, direction: 'mixed' })
    expect(buildNewsShockRegimeHeadline('normal', 'warning', d, 'observe')).toBe(
      'ニュース悪化シグナル (shock 0.62 (mixed)) — observe中のため発注は変更しません',
    )
  })

  it('describes a warning entry in enforce mode with the size scale action', () => {
    const d = decision({ regime: 'warning', sizeScale: 0.5, shock: 0.62, direction: 'mixed' })
    expect(buildNewsShockRegimeHeadline('normal', 'warning', d, 'enforce')).toBe(
      'ニュース悪化シグナル (shock 0.62 (mixed)) — 新規買い数量を縮小します (x0.5)',
    )
  })

  it('describes a critical entry with the mode-dependent action', () => {
    const d = decision({ regime: 'critical', sizeScale: 0, shock: 0.94, direction: 'risk_off' })
    expect(buildNewsShockRegimeHeadline('warning', 'critical', d, 'observe')).toContain(
      '本来は新規買い停止 (observe中: 発注は変更しません)',
    )
    expect(buildNewsShockRegimeHeadline('warning', 'critical', d, 'enforce')).toContain('新規買いを停止します')
  })

  it('describes easing back to normal from warning/critical as 解除', () => {
    const d = decision({ regime: 'normal', shock: 0.13 })
    expect(buildNewsShockRegimeHeadline('warning', 'normal', d, 'observe')).toBe(
      'ニュース悪化シグナル解除 — 平常に戻りました (現在shock 0.13)',
    )
  })

  it('returns undefined for unknown→normal (データ欠測回復は通知自体を抑制する前提)', () => {
    const d = decision({ regime: 'normal', shock: 0.13 })
    expect(buildNewsShockRegimeHeadline('unknown', 'normal', d, 'observe')).toBeUndefined()
  })
})
