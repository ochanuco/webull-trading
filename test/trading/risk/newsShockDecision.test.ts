import { describe, expect, it, vi } from 'vitest'
import {
  buildNewsShockRegimeHeadline,
  computeNextNewsShockAlertLevel,
  isNewsShockGateReady,
  isNewsShockRegime,
  loadNewsShockDecision,
  NEWS_SHOCK_ALERT_LEVEL_KEY,
  NEWS_SHOCK_REGIME_RANK,
} from '../../../src/trading/risk/newsShockDecision'
import type { NewsShockGateDecision, NewsShockRegime } from '../../../src/trading/risk/newsShockGate'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../../src/infrastructure/db/newsHeadlineEvalRepo'
import type { NewsHeadlineEvalRow } from '../../../src/infrastructure/db/schema'
import { detectAndNotifyRegimeChange, loadRegimeSnapshot } from '../../../src/infrastructure/notification/regimeChange'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'

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
  it('describes a warning entry in observe mode as observation-only', () => {
    const d = decision({ regime: 'warning', sizeScale: 0.5, shock: 0.73, direction: 'mixed' })
    expect(buildNewsShockRegimeHeadline('normal', 'warning', d, 'observe')).toBe(
      '73%：ニュース悪化 — 観測のみ',
    )
  })

  it('describes a warning entry in enforce mode with the size-scale action', () => {
    const d = decision({ regime: 'warning', sizeScale: 0.5, shock: 0.73, direction: 'mixed' })
    expect(buildNewsShockRegimeHeadline('normal', 'warning', d, 'enforce')).toBe(
      '73%：ニュース悪化 — 買い数量 x0.5',
    )
  })

  it('describes a critical entry in observe mode as observation-only', () => {
    const d = decision({ regime: 'critical', sizeScale: 0, shock: 0.8, direction: 'risk_off' })
    expect(buildNewsShockRegimeHeadline('warning', 'critical', d, 'observe')).toBe(
      '80%：ニュース急落 — 観測のみ',
    )
  })

  it('describes a critical entry in enforce mode as a buy stop', () => {
    const d = decision({ regime: 'critical', sizeScale: 0, shock: 0.8, direction: 'risk_off' })
    expect(buildNewsShockRegimeHeadline('warning', 'critical', d, 'enforce')).toBe(
      '80%：ニュース急落 — 新規買い停止',
    )
  })

  it('describes easing back to normal from warning/critical tersely, independent of mode', () => {
    const d = decision({ regime: 'normal', shock: 0.13 })
    expect(buildNewsShockRegimeHeadline('warning', 'normal', d, 'observe')).toBe('ニュース平常に戻りました')
    expect(buildNewsShockRegimeHeadline('critical', 'normal', d, 'enforce')).toBe('ニュース平常に戻りました')
  })

  it('returns undefined for unknown→normal (データ欠測回復は通知自体を抑制する前提)', () => {
    const d = decision({ regime: 'normal', shock: 0.13 })
    expect(buildNewsShockRegimeHeadline('unknown', 'normal', d, 'observe')).toBeUndefined()
  })
})

describe('computeNextNewsShockAlertLevel', () => {
  it('latches to the current regime on first observation', () => {
    expect(computeNextNewsShockAlertLevel('warning', null)).toBe('warning')
    expect(computeNextNewsShockAlertLevel('critical', null)).toBe('critical')
    expect(computeNextNewsShockAlertLevel('normal', null)).toBe('normal')
  })

  it('escalates from warning to critical', () => {
    expect(computeNextNewsShockAlertLevel('critical', 'warning')).toBe('critical')
  })

  it('stays latched at critical when the current tick eases back to warning', () => {
    expect(computeNextNewsShockAlertLevel('warning', 'critical')).toBe('critical')
  })

  it('stays latched at critical across a critical→warning→critical flap', () => {
    const afterEase = computeNextNewsShockAlertLevel('warning', 'critical')
    expect(computeNextNewsShockAlertLevel('critical', afterEase)).toBe('critical')
  })

  it('resets to normal only when the current regime is normal', () => {
    expect(computeNextNewsShockAlertLevel('normal', 'critical')).toBe('normal')
    expect(computeNextNewsShockAlertLevel('normal', 'warning')).toBe('normal')
  })

  it('keeps the previous latch unchanged when the current regime is unknown', () => {
    expect(computeNextNewsShockAlertLevel('unknown', 'critical')).toBe('critical')
    expect(computeNextNewsShockAlertLevel('unknown', 'warning')).toBe('warning')
    expect(computeNextNewsShockAlertLevel('unknown', null)).toBe('unknown')
  })
})

describe('news_shock_alert_level notification episodes (computeNextNewsShockAlertLevel wired through detectAndNotifyRegimeChange)', () => {
  // Single-row config_state_snapshot double covering both the raw-SQL path
  // (atomicallyUpdateRegimeSnapshot) and the drizzle path (loadRegimeSnapshot
  // used to read the previous latch before folding in the current tick) —
  // no concurrency, unlike regimeChange.test.ts's CAS-race fakeDb.
  function fakeSnapshotDb(): D1Database {
    let stored: string | null = null
    const prepare = (sqlOriginal: string) => {
      const sql = sqlOriginal.toLowerCase()
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              return { results: stored !== null ? [{ value: stored }] : [] }
            },
            async raw() {
              return stored !== null ? [[stored]] : []
            },
            async run() {
              if (sql.startsWith('insert or ignore')) {
                if (stored !== null) return { meta: { changes: 0 } }
                stored = String(args[1])
                return { meta: { changes: 1 } }
              }
              if (sql.includes('update') && args.length >= 5) {
                const nextValue = String(args[0])
                const expectedOld = String(args[4])
                if (stored === expectedOld) {
                  stored = nextValue
                  return { meta: { changes: 1 } }
                }
                return { meta: { changes: 0 } }
              }
              return { meta: { changes: 0 } }
            },
            async first() {
              return stored !== null ? { value: stored } : null
            },
          }
        },
      }
    }
    return { prepare, async batch() { return [] } } as unknown as D1Database
  }

  // Mirrors the runStrategyCron wiring: read the previous latch, fold in the
  // current tick's regime, then let detectAndNotifyRegimeChange dedup/notify
  // on the latched value. The caller skips this entirely on 'unknown'.
  async function tick(db: D1Database, notifier: Notifier, currentRegime: NewsShockRegime) {
    const previous = await loadRegimeSnapshot(db, NEWS_SHOCK_ALERT_LEVEL_KEY, isNewsShockRegime)
    const next = computeNextNewsShockAlertLevel(currentRegime, previous)
    return detectAndNotifyRegimeChange<NewsShockRegime>({
      db,
      notifier,
      key: NEWS_SHOCK_ALERT_LEVEL_KEY,
      current: { regime: next, reason: 'test' },
      rank: NEWS_SHOCK_REGIME_RANK,
      criticalRegime: 'critical',
      isValidRegime: isNewsShockRegime,
    })
  }

  it('notifies once per episode boundary and collapses a critical/warning flap in between', async () => {
    const db = fakeSnapshotDb()
    const calls: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(event) {
        calls.push(event)
      },
    }

    await tick(db, notifier, 'normal') // first observation: stored, never notifies
    expect(calls).toHaveLength(0)

    expect((await tick(db, notifier, 'warning')).emitted).toBe(true) // normal -> warning
    expect(calls).toHaveLength(1)

    expect((await tick(db, notifier, 'critical')).emitted).toBe(true) // warning -> critical
    expect(calls).toHaveLength(2)

    expect((await tick(db, notifier, 'warning')).emitted).toBe(false) // still latched at critical
    expect(calls).toHaveLength(2)

    expect((await tick(db, notifier, 'critical')).emitted).toBe(false) // flap back up: still no-op
    expect(calls).toHaveLength(2)

    expect((await tick(db, notifier, 'normal')).emitted).toBe(true) // critical -> normal
    expect(calls).toHaveLength(3)

    expect((await tick(db, notifier, 'warning')).emitted).toBe(true) // fresh episode after reset
    expect(calls).toHaveLength(4)
  })
})
