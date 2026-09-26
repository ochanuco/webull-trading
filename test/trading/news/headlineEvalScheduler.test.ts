import { describe, expect, it, vi } from 'vitest'
import { runHeadlineEvalScheduler } from '../../../src/trading/news/headlineEvalScheduler'
import type { GoogleNewsRssClient } from '../../../src/infrastructure/news/GoogleNewsRssClient'
import type { YahooFinanceRssClient } from '../../../src/infrastructure/news/YahooFinanceRssClient'
import type { RssHeadline } from '../../../src/infrastructure/news/rssHeadlineParser'
import type { Env } from '../../../src/config/env'
import { fakeD1 } from '../../helpers/fakeD1'

/** In-window UTC quarter-hour slot. */
const SLOT_NOW = new Date('2026-09-26T12:15:00.000Z')

function fakeYahooClient(
  handler: () => RssHeadline[] | Promise<RssHeadline[]>,
): { client: YahooFinanceRssClient; fetchHeadlines: ReturnType<typeof vi.fn> } {
  const fetchHeadlines = vi.fn(async () => handler())
  return { client: { fetchHeadlines } as unknown as YahooFinanceRssClient, fetchHeadlines }
}

function fakeGoogleClient(
  handler: () => RssHeadline[] | Promise<RssHeadline[]>,
): { client: GoogleNewsRssClient; fetchHeadlines: ReturnType<typeof vi.fn> } {
  const fetchHeadlines = vi.fn(async () => handler())
  return { client: { fetchHeadlines } as unknown as GoogleNewsRssClient, fetchHeadlines }
}

/** Yahoo client that never resolves the way a real failure would: always throws. */
function throwingYahooClient(message: string): { client: YahooFinanceRssClient; fetchHeadlines: ReturnType<typeof vi.fn> } {
  return fakeYahooClient(() => {
    throw new Error(message)
  })
}

function fakeAi(run: (model: string, input: unknown) => Promise<unknown>) {
  return { run: vi.fn(run) }
}

/** Captures the flattened bound params of every `prepare(...).bind(...)` call. */
function capturingD1(): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = []
  const stmt = {
    bind: (...args: unknown[]) => {
      inserts.push(args)
      return stmt
    },
    async all() {
      return { results: [{ id: 1 }] }
    },
    async first() {
      return null
    },
    async run() {
      return { success: true }
    },
    async raw() {
      return []
    },
  }
  const db = { prepare: () => stmt, batch: async () => [] } as unknown as D1Database
  return { db, inserts }
}

function throwingPrepareD1(): D1Database {
  return {
    prepare: () => {
      throw new Error('D1 unavailable')
    },
    batch: async () => [],
  } as unknown as D1Database
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    JEV_HEADLINE_EVAL_ENABLED: 'true',
    DB: fakeD1(),
    AI: fakeAi(async () => ({ state: 'Completed', result: { answers: {}, usage: {} } })),
    ...overrides,
  } as unknown as Env
}

const COMPLETED_SAMPLE = {
  state: 'Completed',
  result: {
    model: 'jev-1.13.0',
    answers: {
      shock: { type: 'noul', noul: 0.94 },
      direction: { type: 'choice', choice: 'risk_off', confidence: 1 },
      severity: { type: 'score', score: 3.08, confidence: 0.23 },
      scope: { type: 'choice', choice: 'broad_us_market', confidence: 1 },
    },
    usage: { input_tokens: 810, output_tokens: 139 },
  },
}

const SAMPLE_HEADLINES: RssHeadline[] = [
  { title: 'Stocks tumble on rate fears', source: 'Reuters', publishedAt: '2026-09-26T12:00:00.000Z' },
  { title: 'Nasdaq closes lower', source: 'CNBC', publishedAt: '2026-09-26T12:05:00.000Z' },
]

describe('runHeadlineEvalScheduler — opt-in / availability gates', () => {
  it('JEV_HEADLINE_EVAL_ENABLED 未設定なら fetch も AI も呼ばず即 return する', async () => {
    const { client: yahooClient, fetchHeadlines } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ JEV_HEADLINE_EVAL_ENABLED: undefined })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('jev_headline_eval_disabled')
    expect(fetchHeadlines).not.toHaveBeenCalled()
    expect(vi.mocked(env.AI!.run)).not.toHaveBeenCalled()
  })

  it('env.DB が無ければ db_unavailable を返し fetch を呼ばない', async () => {
    const { client: yahooClient, fetchHeadlines } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: undefined })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('db_unavailable')
    expect(fetchHeadlines).not.toHaveBeenCalled()
  })

  it('env.AI が無ければ ai_unavailable を返し fetch を呼ばない', async () => {
    const { client: yahooClient, fetchHeadlines } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ AI: undefined })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('ai_unavailable')
    expect(fetchHeadlines).not.toHaveBeenCalled()
  })

  it('UTC 分が 15 の倍数でなければ fetch を呼ばず outside_slot を返す', async () => {
    const { client: yahooClient, fetchHeadlines } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv()
    const summary = await runHeadlineEvalScheduler({
      env,
      yahooClient,
      now: () => new Date('2026-09-26T12:20:00.000Z'),
    })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('outside_slot')
    expect(fetchHeadlines).not.toHaveBeenCalled()
  })

  it.each([0, 15, 30, 45])('UTC 分が %i (15分境界) なら実行する', async (minute) => {
    const { client: yahooClient, fetchHeadlines } = fakeYahooClient(() => [])
    const env = makeEnv()
    const now = new Date(`2026-09-26T12:${String(minute).padStart(2, '0')}:00.000Z`)
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => now })
    expect(summary.ran).toBe(true)
    expect(fetchHeadlines).toHaveBeenCalledTimes(1)
  })
})

describe('runHeadlineEvalScheduler — no headlines', () => {
  it('Yahoo が 0 件を返したら Google にフォールバックせず AI も呼ばず no_headlines 行を書く', async () => {
    const { db, inserts } = capturingD1()
    const { client: yahooClient } = fakeYahooClient(() => [])
    const { fetchHeadlines: googleFetch, client: googleClient } = fakeGoogleClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, googleClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('no_headlines')
    expect(summary.source).toBe('yahoo_finance_rss')
    expect(summary.headlineCount).toBe(0)
    expect(googleFetch).not.toHaveBeenCalled()
    expect(vi.mocked(env.AI!.run)).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toContain('no_headlines')
    expect(inserts[0]).toContain('yahoo_finance_rss')
  })
})

describe('runHeadlineEvalScheduler — Yahoo fetch fails, Google fallback succeeds', () => {
  it('Yahoo が throw しても Google が成功すれば google_news_rss の行を書く', async () => {
    const { db, inserts } = capturingD1()
    const { client: yahooClient } = throwingYahooClient('Yahoo unreachable')
    const { client: googleClient, fetchHeadlines: googleFetch } = fakeGoogleClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => COMPLETED_SAMPLE) })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, googleClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('ok')
    expect(summary.source).toBe('google_news_rss')
    expect(googleFetch).toHaveBeenCalledTimes(1)
    expect(inserts[0]).toContain('google_news_rss')
  })
})

describe('runHeadlineEvalScheduler — both sources fail', () => {
  it('Yahoo・Google 両方 throw したら fetch_error 行を1件だけ書き、両方のメッセージを含め、AI は呼ばない', async () => {
    const { db, inserts } = capturingD1()
    const { client: yahooClient } = throwingYahooClient('Yahoo unreachable')
    const { client: googleClient } = fakeGoogleClient(() => {
      throw new Error('Google blocked')
    })
    const env = makeEnv({ DB: db })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, googleClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('fetch_error')
    expect(summary.source).toBe('yahoo_finance_rss')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toContain('fetch_error')
    expect(inserts[0]).toContain('yahoo_finance_rss')
    const combinedError = inserts[0]!.find(
      (v) => typeof v === 'string' && v.includes('Yahoo unreachable'),
    ) as string | undefined
    expect(combinedError).toBeDefined()
    expect(combinedError).toContain('Google blocked')
    expect(vi.mocked(env.AI!.run)).not.toHaveBeenCalled()
  })
})

describe('runHeadlineEvalScheduler — jev failure', () => {
  it('AI が throw したら jev_error 行を書く (source は yahoo_finance_rss)', async () => {
    const { db, inserts } = capturingD1()
    const { client: yahooClient } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => { throw new Error('AI Gateway down') }) })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('jev_error')
    expect(summary.source).toBe('yahoo_finance_rss')
    expect(inserts[0]).toContain('jev_error')
    expect(inserts[0]).toContain('AI Gateway down')
  })

  it('AI の応答が壊れていても (state !== Completed) jev_error 行を書く', async () => {
    const { db, inserts } = capturingD1()
    const { client: yahooClient } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => ({ state: 'Failed' })) })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('jev_error')
    expect(inserts[0]).toContain('jev_error')
  })
})

describe('runHeadlineEvalScheduler — happy path', () => {
  it('Yahoo から取得した見出しを分類し、抽出済み列 + token 使用量を row に書く', async () => {
    const { db, inserts } = capturingD1()
    const { client: yahooClient, fetchHeadlines } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => COMPLETED_SAMPLE) })
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW, requestId: 'req-1' })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('ok')
    expect(summary.source).toBe('yahoo_finance_rss')
    expect(summary.headlineCount).toBe(2)
    expect(fetchHeadlines).toHaveBeenCalledTimes(1)
    expect(vi.mocked(env.AI!.run)).toHaveBeenCalledWith(
      'typesafe/jev',
      expect.objectContaining({ state: ['Stocks tumble on rate fears', 'Nasdaq closes lower'] }),
    )
    const params = inserts[0]!
    expect(params).toContain('ok')
    expect(params).toContain('yahoo_finance_rss')
    expect(params).toContain('jev-1.13.0')
    expect(params).toContain(0.94)
    expect(params).toContain('risk_off')
    expect(params).toContain(3.08)
    expect(params).toContain('broad_us_market')
    expect(params).toContain(810)
    expect(params).toContain(139)
    expect(params).toContain('req-1')
  })
})

describe('runHeadlineEvalScheduler — never throws', () => {
  it('DB insert が throw しても reject せず insert_error を返す', async () => {
    const { client: yahooClient } = fakeYahooClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: throwingPrepareD1(), AI: fakeAi(async () => COMPLETED_SAMPLE) })
    await expect(runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })).resolves.not.toThrow()
    const summary = await runHeadlineEvalScheduler({ env, yahooClient, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('insert_error')
  })
})
