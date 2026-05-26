import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPortfolioRoll } from '../src/trading/portfolio/runPortfolioRoll'
import type { Env } from '../src/config/env'
import type { PortfolioState } from '../src/trading/state/portfolioTypes'
import type { PortfolioStore } from '../src/trading/state/PortfolioStore'

// Issue #140: EOD rollover helper の挙動を検証する。`src/index.ts` の
// `scheduled()` 内でこの helper が `event.cron === '0 22 * * *'` のときだけ
// 呼ばれる構造になっている (cron ルーティング自体は src/index.ts の `if`
// 分岐そのものが仕様 — runtime test は wrangler 経由でしか書けないので
// helper の側に焦点を絞る)。

const baseEnv = {
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
} as unknown as Env

function makeStore(opts: {
  before: PortfolioState
  after: PortfolioState
  throwOnRoll?: Error
}): { store: PortfolioStore; calls: number } {
  let calls = 0
  const store: PortfolioStore = {
    async getPortfolio() {
      return opts.before
    },
    async seedDailyStartEquity() {
      return opts.before
    },
    async applyRealizedPnl() {
      return opts.before
    },
    async setTradingDisabledUntil() {
      return opts.before
    },
    async applyFillExposure() {
      return opts.before
    },
    async seedOpenExposure() {
      return opts.before
    },
    async rollDaily() {
      calls++
      if (opts.throwOnRoll) throw opts.throwOnRoll
      return { before: opts.before, after: opts.after }
    },
  }
  return {
    store,
    get calls() {
      return calls
    },
  } as { store: PortfolioStore; calls: number }
}

describe('runPortfolioRoll (issue #140)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('happy-path: invokes rollDaily once and emits portfolio_roll_run log', async () => {
    const before: PortfolioState = {
      dailyStartEquity: 10_000,
      dailyRealizedPnl: -50,
      appliedClientOrderIds: [],
      tradingDisabledUntil: null,
      lastRolledAt: null,
      openExposureUsd: 0,
      openExposureJpy: 0,
      updatedAt: '2026-04-25T22:00:00.000Z',
    }
    const after: PortfolioState = {
      dailyStartEquity: 9_950,
      dailyRealizedPnl: 0,
      appliedClientOrderIds: [],
      tradingDisabledUntil: null,
      lastRolledAt: '2026-04-25T22:00:00.000Z',
      openExposureUsd: 0,
      openExposureJpy: 0,
      updatedAt: '2026-04-25T22:00:00.000Z',
    }
    const fixture = makeStore({ before, after })
    await runPortfolioRoll(baseEnv, 'req-1', { portfolioStoreFactory: () => fixture.store })
    expect(fixture.calls).toBe(1)
    const logs = logSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === 'string' && s.includes('portfolio_roll_run'))
    expect(logs).toHaveLength(1)
    const first = logs[0]
    if (!first) throw new Error('portfolio_roll_run log was not emitted')
    const payload = JSON.parse(first) as Record<string, unknown>
    expect(payload).toMatchObject({
      event: 'portfolio_roll_run',
      requestId: 'req-1',
      rolledDelta: -50,
    })
    expect((payload.after as Record<string, unknown>).lastRolledAt).toBe('2026-04-25T22:00:00.000Z')
  })

  it('emits portfolio_roll_skipped (warn) when PORTFOLIO_STATE binding is missing', async () => {
    await runPortfolioRoll(baseEnv, 'req-2')
    const skipped = warnSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === 'string' && s.includes('portfolio_roll_skipped'))
    expect(skipped).toHaveLength(1)
    const first = skipped[0]
    if (!first) throw new Error('portfolio_roll_skipped log was not emitted')
    expect(JSON.parse(first)).toMatchObject({
      event: 'portfolio_roll_skipped',
      requestId: 'req-2',
    })
  })

  it('silent fallback: emits portfolio_roll_error and does NOT rethrow on DO exception', async () => {
    const before: PortfolioState = {
      dailyStartEquity: 10_000,
      dailyRealizedPnl: 0,
      appliedClientOrderIds: [],
      tradingDisabledUntil: null,
      lastRolledAt: null,
      openExposureUsd: 0,
      openExposureJpy: 0,
      updatedAt: '2026-04-25T22:00:00.000Z',
    }
    const fixture = makeStore({ before, after: before, throwOnRoll: new Error('DO unreachable') })
    // resolve = silent fallback。reject にならないこと自体が cron を fail に
    // させない仕様の根拠。
    await expect(
      runPortfolioRoll(baseEnv, 'req-3', { portfolioStoreFactory: () => fixture.store }),
    ).resolves.toBeUndefined()
    const errors = errorSpy.mock.calls
      .map((args) => args[0])
      .filter((s): s is string => typeof s === 'string' && s.includes('portfolio_roll_error'))
    expect(errors).toHaveLength(1)
    const first = errors[0]
    if (!first) throw new Error('portfolio_roll_error log was not emitted')
    const payload = JSON.parse(first) as Record<string, unknown>
    expect(payload).toMatchObject({ event: 'portfolio_roll_error', message: 'DO unreachable' })
  })
})
