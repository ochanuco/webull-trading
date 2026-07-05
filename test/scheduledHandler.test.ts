import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPortfolioRoll } from '../src/trading/portfolio/runPortfolioRoll'
import type { Env } from '../src/config/env'
import type { WebullAccountBalanceDto } from '../src/infrastructure/webull/dto'
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

// Broker equity re-seed tests need to observe `seedDailyStartEquity` calls
// separately from `rollDaily`, so this variant of the fixture captures the
// re-seed amount instead of ignoring it like `makeStore` above.
function makeStoreWithSeedCapture(opts: {
  before: PortfolioState
  after: PortfolioState
}): { store: PortfolioStore; seedCalls: number[] } {
  const seedCalls: number[] = []
  const store: PortfolioStore = {
    async getPortfolio() {
      return opts.before
    },
    async seedDailyStartEquity(amount: number) {
      seedCalls.push(amount)
      return { ...opts.after, dailyStartEquity: amount }
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
      return { before: opts.before, after: opts.after }
    },
  }
  return { store, seedCalls }
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

  // Broker equity auto-reseed: EOD roll re-seeds `dailyStartEquity` from the
  // Webull balance API so the drawdown gate's denominator tracks the real
  // account instead of a stale manual seed.
  describe('broker equity re-seed (dailyStartEquity auto-seed)', () => {
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

    function fakeUsdBalance(cash: string, marketValue: string): WebullAccountBalanceDto {
      return {
        account_currency_assets: [{ currency: 'USD', cash_balance: cash, market_value: marketValue }],
      }
    }

    function warnLogsMatching(reasonSubstring: string): Record<string, unknown>[] {
      return warnSpy.mock.calls
        .map((args: unknown[]) => args[0])
        .filter((s: unknown): s is string => typeof s === 'string' && s.includes(reasonSubstring))
        .map((s: string) => JSON.parse(s) as Record<string, unknown>)
    }

    function errorLogsMatching(reasonSubstring: string): Record<string, unknown>[] {
      return errorSpy.mock.calls
        .map((args: unknown[]) => args[0])
        .filter((s: unknown): s is string => typeof s === 'string' && s.includes(reasonSubstring))
        .map((s: string) => JSON.parse(s) as Record<string, unknown>)
    }

    it('dryRun=true: never touches the broker and keeps the rolled equity', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      let readClientCalls = 0
      await runPortfolioRoll(baseEnv, 'req-dryrun', {
        portfolioStoreFactory: () => fixture.store,
        now: nowOnSessionDay,
        loadGlobalConfig: async () => ({ dryRun: true }),
        createReadClient: () => {
          readClientCalls++
          return { getAccountBalance: async () => fakeUsdBalance('1', '1') }
        },
      })
      expect(readClientCalls).toBe(0)
      expect(fixture.seedCalls).toEqual([])
      const skipped = warnLogsMatching('portfolio_equity_reseed_skipped')
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toMatchObject({ reason: 'dry_run', requestId: 'req-dryrun' })
    })

    it('global config load failure: skips the reseed without throwing', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      await expect(
        runPortfolioRoll(baseEnv, 'req-cfgfail', {
          portfolioStoreFactory: () => fixture.store,
          now: nowOnSessionDay,
          loadGlobalConfig: async () => {
            throw new Error('D1 unreachable')
          },
        }),
      ).resolves.toBeUndefined()
      expect(fixture.seedCalls).toEqual([])
      const skipped = warnLogsMatching('portfolio_equity_reseed_skipped')
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toMatchObject({ reason: 'global_config_load_failed' })
    })

    it('broker fetch failure: keeps the rolled equity and does not throw', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      await expect(
        runPortfolioRoll(baseEnv, 'req-fetchfail', {
          portfolioStoreFactory: () => fixture.store,
          now: nowOnSessionDay,
          loadGlobalConfig: async () => ({ dryRun: false }),
          resolveAccessToken: async () => 'tok',
          createReadClient: () => ({
            getAccountBalance: async () => {
              throw new Error('broker down')
            },
          }),
        }),
      ).resolves.toBeUndefined()
      expect(fixture.seedCalls).toEqual([])
      const failed = errorLogsMatching('portfolio_equity_reseed_failed')
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({ reason: 'broker_fetch_failed' })
    })

    it('parsed equity null (no USD entry): keeps the rolled equity', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      await runPortfolioRoll(baseEnv, 'req-nousd', {
        portfolioStoreFactory: () => fixture.store,
        now: nowOnSessionDay,
        loadGlobalConfig: async () => ({ dryRun: false }),
        resolveAccessToken: async () => 'tok',
        createReadClient: () => ({ getAccountBalance: async () => ({}) }),
      })
      expect(fixture.seedCalls).toEqual([])
      const skipped = warnLogsMatching('portfolio_equity_reseed_skipped')
      expect(skipped).toHaveLength(1)
      expect(skipped[0]).toMatchObject({ reason: 'no_usd_equity_in_balance' })
    })

    it('success: seeds dailyStartEquity with the broker USD equity and logs it', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      await runPortfolioRoll(baseEnv, 'req-success', {
        portfolioStoreFactory: () => fixture.store,
        now: nowOnSessionDay,
        loadGlobalConfig: async () => ({ dryRun: false }),
        resolveAccessToken: async () => 'tok',
        createReadClient: () => ({ getAccountBalance: async () => fakeUsdBalance('500', '1000') }),
      })
      expect(fixture.seedCalls).toEqual([1500])
      const logs = logSpy.mock.calls
        .map((args: unknown[]) => args[0])
        .filter((s: unknown): s is string => typeof s === 'string' && s.includes('portfolio_equity_reseeded'))
      expect(logs).toHaveLength(1)
      const payload = JSON.parse(logs[0] as string) as Record<string, unknown>
      expect(payload).toMatchObject({
        event: 'portfolio_equity_reseeded',
        requestId: 'req-success',
        rolledEquity: after.dailyStartEquity,
        brokerEquity: 1500,
      })
    })
  })

  describe('daily equity snapshot (dashboard time series)', () => {
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

    it('does not write a snapshot when env.DB is not bound', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      let snapshotCalls = 0
      await runPortfolioRoll(baseEnv, 'req-nodb', {
        portfolioStoreFactory: () => fixture.store,
        now: nowOnSessionDay,
        loadGlobalConfig: async () => ({ dryRun: true }),
        recordSnapshot: async () => {
          snapshotCalls++
        },
      })
      expect(snapshotCalls).toBe(0)
    })

    it('writes a snapshot using the pre-roll (before) equity/pnl regardless of reseed outcome', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      const snapshotCalls: unknown[] = []
      const envWithDb = { ...baseEnv, DB: {} } as unknown as Env
      await runPortfolioRoll(envWithDb, 'req-snap', {
        portfolioStoreFactory: () => fixture.store,
        now: nowOnSessionDay,
        loadGlobalConfig: async () => ({ dryRun: true }),
        recordSnapshot: async (_d1, payload) => {
          snapshotCalls.push(payload)
        },
      })
      expect(snapshotCalls).toEqual([
        {
          snapshotAt: after.updatedAt,
          dailyStartEquityUsd: before.dailyStartEquity,
          dailyStartEquityJpy: null,
          dailyRealizedPnlUsd: before.dailyRealizedPnl,
          dailyRealizedPnlJpy: null,
          drawdownPct: before.dailyRealizedPnl / before.dailyStartEquity,
          requestId: 'req-snap',
        },
      ])
    })

    it('snapshot write failure logs an error-level event and does not throw', async () => {
      const fixture = makeStoreWithSeedCapture({ before, after })
      const envWithDb = { ...baseEnv, DB: {} } as unknown as Env
      await expect(
        runPortfolioRoll(envWithDb, 'req-snapfail', {
          portfolioStoreFactory: () => fixture.store,
          now: nowOnSessionDay,
          loadGlobalConfig: async () => ({ dryRun: true }),
          recordSnapshot: async () => {
            throw new Error('D1 insert failed')
          },
        }),
      ).resolves.toBeUndefined()
      const failed = errorSpy.mock.calls
        .map((args: unknown[]) => args[0])
        .filter(
          (s: unknown): s is string =>
            typeof s === 'string' && s.includes('portfolio_equity_snapshot_write_failed'),
        )
      expect(failed).toHaveLength(1)
    })
  })
})
