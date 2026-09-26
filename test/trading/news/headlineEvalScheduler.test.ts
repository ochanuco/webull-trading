import { describe, expect, it, vi } from 'vitest'
import { runHeadlineEvalScheduler } from '../../../src/trading/news/headlineEvalScheduler'
import type { GoogleNewsHeadline, GoogleNewsRssClient } from '../../../src/infrastructure/news/GoogleNewsRssClient'
import type { Env } from '../../../src/config/env'
import { fakeD1 } from '../../helpers/fakeD1'

/** In-window UTC quarter-hour slot. */
const SLOT_NOW = new Date('2026-09-26T12:15:00.000Z')

function fakeClient(
  handler: () => GoogleNewsHeadline[] | Promise<GoogleNewsHeadline[]>,
): { client: GoogleNewsRssClient; fetchHeadlines: ReturnType<typeof vi.fn> } {
  const fetchHeadlines = vi.fn(async () => handler())
  return { client: { fetchHeadlines } as unknown as GoogleNewsRssClient, fetchHeadlines }
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

const SAMPLE_HEADLINES: GoogleNewsHeadline[] = [
  { title: 'Stocks tumble on rate fears', source: 'Reuters', publishedAt: '2026-09-26T12:00:00.000Z' },
  { title: 'Nasdaq closes lower', source: 'CNBC', publishedAt: '2026-09-26T12:05:00.000Z' },
]

describe('runHeadlineEvalScheduler — opt-in / availability gates', () => {
  it('JEV_HEADLINE_EVAL_ENABLED 未設定なら fetch も AI も呼ばず即 return する', async () => {
    const { client, fetchHeadlines } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ JEV_HEADLINE_EVAL_ENABLED: undefined })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('jev_headline_eval_disabled')
    expect(fetchHeadlines).not.toHaveBeenCalled()
    expect(vi.mocked(env.AI!.run)).not.toHaveBeenCalled()
  })

  it('env.DB が無ければ db_unavailable を返し fetch を呼ばない', async () => {
    const { client, fetchHeadlines } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: undefined })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('db_unavailable')
    expect(fetchHeadlines).not.toHaveBeenCalled()
  })

  it('env.AI が無ければ ai_unavailable を返し fetch を呼ばない', async () => {
    const { client, fetchHeadlines } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ AI: undefined })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('ai_unavailable')
    expect(fetchHeadlines).not.toHaveBeenCalled()
  })

  it('UTC 分が 15 の倍数でなければ fetch を呼ばず outside_slot を返す', async () => {
    const { client, fetchHeadlines } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv()
    const summary = await runHeadlineEvalScheduler({
      env,
      client,
      now: () => new Date('2026-09-26T12:20:00.000Z'),
    })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('outside_slot')
    expect(fetchHeadlines).not.toHaveBeenCalled()
  })

  it.each([0, 15, 30, 45])('UTC 分が %i (15分境界) なら実行する', async (minute) => {
    const { client, fetchHeadlines } = fakeClient(() => [])
    const env = makeEnv()
    const now = new Date(`2026-09-26T12:${String(minute).padStart(2, '0')}:00.000Z`)
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => now })
    expect(summary.ran).toBe(true)
    expect(fetchHeadlines).toHaveBeenCalledTimes(1)
  })
})

describe('runHeadlineEvalScheduler — no headlines', () => {
  it('0 件なら AI を呼ばず no_headlines 行を書く', async () => {
    const { db, inserts } = capturingD1()
    const { client } = fakeClient(() => [])
    const env = makeEnv({ DB: db })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('no_headlines')
    expect(summary.headlineCount).toBe(0)
    expect(vi.mocked(env.AI!.run)).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toContain('no_headlines')
  })
})

describe('runHeadlineEvalScheduler — fetch failure', () => {
  it('fetch が throw したら fetch_error 行を書き throw しない', async () => {
    const { db, inserts } = capturingD1()
    const { client } = fakeClient(() => {
      throw new Error('Google News unreachable')
    })
    const env = makeEnv({ DB: db })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('fetch_error')
    expect(inserts[0]).toContain('fetch_error')
    expect(inserts[0]).toContain('Google News unreachable')
    expect(vi.mocked(env.AI!.run)).not.toHaveBeenCalled()
  })
})

describe('runHeadlineEvalScheduler — jev failure', () => {
  it('AI が throw したら jev_error 行を書く', async () => {
    const { db, inserts } = capturingD1()
    const { client } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => { throw new Error('AI Gateway down') }) })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('jev_error')
    expect(inserts[0]).toContain('jev_error')
    expect(inserts[0]).toContain('AI Gateway down')
  })

  it('AI の応答が壊れていても (state !== Completed) jev_error 行を書く', async () => {
    const { db, inserts } = capturingD1()
    const { client } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => ({ state: 'Failed' })) })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('jev_error')
    expect(inserts[0]).toContain('jev_error')
  })
})

describe('runHeadlineEvalScheduler — happy path', () => {
  it('取得した見出しを分類し、抽出済み列 + token 使用量を row に書く', async () => {
    const { db, inserts } = capturingD1()
    const { client, fetchHeadlines } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: db, AI: fakeAi(async () => COMPLETED_SAMPLE) })
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW, requestId: 'req-1' })
    expect(summary.ran).toBe(true)
    expect(summary.status).toBe('ok')
    expect(summary.headlineCount).toBe(2)
    expect(fetchHeadlines).toHaveBeenCalledTimes(1)
    expect(vi.mocked(env.AI!.run)).toHaveBeenCalledWith(
      'typesafe/jev',
      expect.objectContaining({ state: ['Stocks tumble on rate fears', 'Nasdaq closes lower'] }),
    )
    const params = inserts[0]!
    expect(params).toContain('ok')
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
    const { client } = fakeClient(() => SAMPLE_HEADLINES)
    const env = makeEnv({ DB: throwingPrepareD1(), AI: fakeAi(async () => COMPLETED_SAMPLE) })
    await expect(runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })).resolves.not.toThrow()
    const summary = await runHeadlineEvalScheduler({ env, client, now: () => SLOT_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('insert_error')
  })
})
