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
  // Issue #319: roll は calendar-aware で skip するため、helper test 群は
  // NY/JP 両方 session day である瞬間を固定で渡す (Wed 2026-04-22 22:00 UTC =
  // NY 18:00 Wed / JP 翌日 Thu)。
  const nowOnSessionDay = (): Date => new Date('2026-04-22T22:00:00.000Z')
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
    await runPortfolioRoll(baseEnv, 'req-1', {
      portfolioStoreFactory: () => fixture.store,
      now: nowOnSessionDay,
    })
    expect(fixture.calls).toBe(1)
    const logs = logSpy.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((s: unknown): s is string => typeof s === 'string' && s.includes('portfolio_roll_run'))
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
    await runPortfolioRoll(baseEnv, 'req-2', { now: nowOnSessionDay })
    const skipped = warnSpy.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((s: unknown): s is string => typeof s === 'string' && s.includes('portfolio_roll_skipped'))
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
      runPortfolioRoll(baseEnv, 'req-3', {
        portfolioStoreFactory: () => fixture.store,
        now: nowOnSessionDay,
      }),
    ).resolves.toBeUndefined()
    const errors = errorSpy.mock.calls
      .map((args: unknown[]) => args[0])
      .filter((s: unknown): s is string => typeof s === 'string' && s.includes('portfolio_roll_error'))
    expect(errors).toHaveLength(1)
    const first = errors[0]
    if (!first) throw new Error('portfolio_roll_error log was not emitted')
    const payload = JSON.parse(first) as Record<string, unknown>
    expect(payload).toMatchObject({ event: 'portfolio_roll_error', message: 'DO unreachable' })
  })

  // Issue #319: calendar-aware skip。22:00 UTC cron は実 session boundary
  // でない日 (土日 / NYSE holiday / TSE holiday) には roll を skip する。
  describe('calendar-aware skip (issue #319)', () => {
    const baseState: PortfolioState = {
      dailyStartEquity: 10_000,
      dailyRealizedPnl: 0,
      appliedClientOrderIds: [],
      tradingDisabledUntil: null,
      lastRolledAt: null,
      openExposureUsd: 0,
      openExposureJpy: 0,
      updatedAt: '2026-04-25T22:00:00.000Z',
    }

    function expectSkippedWithReason(reasonMatch: RegExp): void {
      const skipped = warnSpy.mock.calls
        .map((args: unknown[]) => args[0])
        .filter((s: unknown): s is string => typeof s === 'string' && s.includes('daily_roll_skipped'))
      expect(skipped).toHaveLength(1)
      const first = skipped[0]
      if (!first) throw new Error('daily_roll_skipped log was not emitted')
      const payload = JSON.parse(first) as { event: string; reason: string }
      expect(payload.event).toBe('daily_roll_skipped')
      expect(payload.reason).toMatch(reasonMatch)
    }

    it('rolls normally on a regular weekday when both NYSE and TSE are open', async () => {
      // Wed 2026-04-22 22:00 UTC: NY=Wed Apr 22 (session), JP next=Thu Apr 23 (session).
      const fixture = makeStore({ before: baseState, after: baseState })
      await runPortfolioRoll(baseEnv, 'req-weekday', {
        portfolioStoreFactory: () => fixture.store,
        now: () => new Date('2026-04-22T22:00:00.000Z'),
      })
      expect(fixture.calls).toBe(1)
    })

    it('skips on NYSE holiday (Memorial Day 2026-05-25 Mon)', async () => {
      // 2026-05-25 22:00 UTC: NY=Mon May 25 (Memorial Day, NYSE closed).
      const fixture = makeStore({ before: baseState, after: baseState })
      await runPortfolioRoll(baseEnv, 'req-nyse-holiday', {
        portfolioStoreFactory: () => fixture.store,
        now: () => new Date('2026-05-25T22:00:00.000Z'),
      })
      expect(fixture.calls).toBe(0)
      expectSkippedWithReason(/NYSE session day/)
    })

    it('skips when JP next day is a TSE substitute holiday (Wed 2026-05-06)', async () => {
      // 2026-05-05 22:00 UTC = NY Tue May 5 (NYSE session day).
      // JP next-day at UTC+24h is JP 2026-05-06 07:00 = Wed (TSE substitute holiday).
      const fixture = makeStore({ before: baseState, after: baseState })
      await runPortfolioRoll(baseEnv, 'req-tse-holiday', {
        portfolioStoreFactory: () => fixture.store,
        now: () => new Date('2026-05-05T22:00:00.000Z'),
      })
      expect(fixture.calls).toBe(0)
      expectSkippedWithReason(/TSE session day/)
    })

    it('skips on weekend (Sat 2026-05-23 22:00 UTC)', async () => {
      // 2026-05-23 22:00 UTC: NY=Sat May 23 (weekend, NYSE closed).
      const fixture = makeStore({ before: baseState, after: baseState })
      await runPortfolioRoll(baseEnv, 'req-weekend', {
        portfolioStoreFactory: () => fixture.store,
        now: () => new Date('2026-05-23T22:00:00.000Z'),
      })
      expect(fixture.calls).toBe(0)
      expectSkippedWithReason(/NYSE session day/)
    })

    it('rolls on a DST-transition day when both markets are open (Mon 2026-03-09)', async () => {
      // 2026-03-08 (Sun) is the US DST spring-forward; 22:00 UTC on Mon 2026-03-09
      // is NY Mon 18:00 EDT — fully in the post-DST regime, NYSE session day.
      // JP next = Tue 2026-03-10 (session day).
      const fixture = makeStore({ before: baseState, after: baseState })
      await runPortfolioRoll(baseEnv, 'req-dst', {
        portfolioStoreFactory: () => fixture.store,
        now: () => new Date('2026-03-09T22:00:00.000Z'),
      })
      expect(fixture.calls).toBe(1)
    })

    it('skips (fail-closed) when the date is outside the hard-coded supported range', async () => {
      // 2027 is not in NYSE_SUPPORTED_YEARS until the annual refresh — must skip.
      const fixture = makeStore({ before: baseState, after: baseState })
      await runPortfolioRoll(baseEnv, 'req-out-of-range', {
        portfolioStoreFactory: () => fixture.store,
        now: () => new Date('2027-04-21T22:00:00.000Z'),
      })
      expect(fixture.calls).toBe(0)
      expectSkippedWithReason(/out of supported range/)
    })
  })
})
