import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createApp } from '../../src/app'
import { applyTradingToggle } from '../../src/infrastructure/db/tradingToggleRepo'

vi.mock('../../src/infrastructure/db/tradingToggleRepo', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradingToggleRepo')>(
    '../../src/infrastructure/db/tradingToggleRepo',
  )
  return {
    ...actual,
    applyTradingToggle: vi.fn(),
  }
})

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}

const authHeader = {}

/**
 * Fake `RateLimit` binding that returns canned outcomes from a list and
 * records all calls. Lets a test simulate "5 allowed then 1 throttled" without
 * touching the real Cloudflare binding.
 */
function makeFakeRateLimit(outcomes: boolean[]) {
  const calls: Array<{ key: string }> = []
  let idx = 0
  return {
    binding: {
      async limit(opts: { key: string }) {
        calls.push(opts)
        const next = idx < outcomes.length ? outcomes[idx] : outcomes[outcomes.length - 1] ?? true
        idx += 1
        return { success: next ?? true }
      },
    },
    calls,
  }
}

describe('rateLimit() middleware on /admin/trading/toggle (STATE_CHANGE)', () => {
  beforeEach(() => {
    vi.mocked(applyTradingToggle).mockResolvedValue({
      before: false,
      after: true,
      historyId: 1,
    })
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('returns 429 with Retry-After: 60 on the 6th request within window', async () => {
    const app = createApp()
    const { binding, calls } = makeFakeRateLimit([true, true, true, true, true, false])
    const env = {
      ...baseEnv,
      DB: {} as unknown as D1Database,
      STATE_CHANGE_RATE_LIMIT: binding,
    }
    const body = JSON.stringify({ enabled: true, reason: 'rl-test' })
    const headers = { 'Content-Type': 'application/json', ...authHeader }

    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        '/admin/trading/toggle',
        { method: 'POST', headers, body },
        env,
      )
      expect(res.status).toBe(200)
    }

    const throttled = await app.request(
      '/admin/trading/toggle',
      { method: 'POST', headers, body },
      env,
    )
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('Retry-After')).toBe('60')
    const json = (await throttled.json()) as { error: string; retry_after: number }
    expect(json).toEqual({ error: 'rate_limited', retry_after: 60 })
    expect(calls.length).toBe(6)
    // The throttled request must NOT have invoked the underlying toggle.
    expect(applyTradingToggle).toHaveBeenCalledTimes(5)
  })

  it('falls back to cf-connecting-ip key when actor is not set', async () => {
    // #29 merge 後は Access が必ず actor を set するので createApp 経由ではこのケース不到達。
    // middleware の defensive IP fallback path を直接 unit test する。
    const { rateLimit } = await import('../../src/middleware/rateLimit')
    const { binding, calls } = makeFakeRateLimit([true])
    const minimal = new Hono<{ Bindings: { STATE_CHANGE_RATE_LIMIT?: RateLimit } }>()
      .use('*', rateLimit('STATE_CHANGE'))
      .get('/', (c) => c.text('ok'))
    const res = await minimal.request(
      '/',
      { headers: { 'cf-connecting-ip': '203.0.113.7' } },
      { STATE_CHANGE_RATE_LIMIT: binding },
    )
    expect(res.status).toBe(200)
    expect(calls[0]?.key).toBe('ip:203.0.113.7')
  })

  it('fail-opens (allows request) when binding is missing', async () => {
    const app = createApp()
    const env = {
      ...baseEnv,
      DB: {} as unknown as D1Database,
      // STATE_CHANGE_RATE_LIMIT intentionally omitted.
    }
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: true, reason: 'rl-test' }),
      },
      env,
    )
    // No binding => warn-and-proceed; downstream handler still runs.
    expect(res.status).toBe(200)
    expect(applyTradingToggle).toHaveBeenCalledTimes(1)
  })

  it('fail-opens (allows request) when binding.limit throws', async () => {
    // RateLimit 側の一時障害で admin/dashboard を 500 で巻き添えにしないことを保証 (CodeRabbit #288)。
    const app = createApp()
    const throwingBinding: RateLimit = {
      async limit() {
        throw new Error('rate limit upstream down')
      },
    }
    const env = {
      ...baseEnv,
      DB: {} as unknown as D1Database,
      STATE_CHANGE_RATE_LIMIT: throwingBinding,
    }
    const res = await app.request(
      '/admin/trading/toggle',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ enabled: true, reason: 'rl-throw' }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(applyTradingToggle).toHaveBeenCalledTimes(1)
  })
})
