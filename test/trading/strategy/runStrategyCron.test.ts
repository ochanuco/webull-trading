import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import {
  emitStaleRollWarningIfNeeded,
  resolvePortfolioForRiskScale,
  runStrategyCron,
} from '../../../src/trading/strategy/runStrategyCron'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../../helpers/configFixtures'

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))

const env = {
  DB: {} as D1Database,
  SYMBOL_STATE: {} as DurableObjectNamespace<never>,
} as unknown as Parameters<typeof runStrategyCron>[0]

describe('runStrategyCron', () => {
  // 0012 migration の new tables (config_state_snapshot / notification_emit_log)
  // を mock D1 が知らないので、`this.client.prepare is not a function` 系の
  // warn が大量に出る。挙動には影響しない (silent fallback) ので suppress。
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse())
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.resetAllMocks()
  })

  it('skips with trading_disabled when tradingEnabled=false', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: false }),
    )
    const result = await runStrategyCron(env)
    expect(result.skipReason).toBe('trading_disabled')
    expect(result.summary.evaluated).toBe(0)
    expect(result.analysis.schema).toBe('strategy_cron_analysis.v1')
    expect(result.analysis.config.tradingEnabled).toBe(false)
  })

  it('skips with no_tradable_symbols when universe is empty', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: [],
        symbolCurrency: {},
      }),
    )
    const result = await runStrategyCron(env)
    expect(result.skipReason).toBe('no_tradable_symbols')
  })

  it('skips with no_bridge_state when SYMBOL_STATE binding is missing', async () => {
    const envWithout = { DB: {} } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithout)
    expect(result.skipReason).toBe('no_bridge_state')
  })

  it('skips with portfolio_halted when tradingDisabledUntil is in the future', async () => {
    const envWithPortfolio = {
      ...env,
      PORTFOLIO_STATE: {
        idFromName: () => ({}),
        get: () => ({
          getPortfolio: vi.fn().mockResolvedValue({
            dailyStartEquity: 0,
            dailyRealizedPnl: 0,
            tradingDisabledUntil: new Date(Date.now() + 3_600_000).toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        }),
      },
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithPortfolio)
    expect(result.skipReason).toBe('portfolio_halted')
  })

  it('skips with drawdown_kill when realized drawdown exceeds threshold', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ drawdownKillThreshold: -0.02 }),
    )
    const envWithPortfolio = {
      ...env,
      PORTFOLIO_STATE: {
        idFromName: () => ({}),
        get: () => ({
          getPortfolio: vi.fn().mockResolvedValue({
            dailyStartEquity: 10_000,
            dailyRealizedPnl: -250, // -2.5% (below -2% threshold)
            tradingDisabledUntil: null,
            updatedAt: new Date().toISOString(),
          }),
        }),
      },
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithPortfolio)
    expect(result.skipReason).toBe('drawdown_kill')
  })

  it('fail-closes to portfolio_halted when PORTFOLIO_STATE binding is missing', async () => {
    const envWithoutPortfolio = {
      DB: {} as D1Database,
      SYMBOL_STATE: {} as DurableObjectNamespace<never>,
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithoutPortfolio)
    expect(result.skipReason).toBe('portfolio_halted')
    expect(result.analysis.universe.symbols).toEqual(['SOXL', 'SOXS'])
  })

  it('fail-closes to portfolio_halted on invalid tradingDisabledUntil timestamp', async () => {
    const envBadTimestamp = {
      ...env,
      PORTFOLIO_STATE: {
        idFromName: () => ({}),
        get: () => ({
          getPortfolio: vi.fn().mockResolvedValue({
            dailyStartEquity: 0,
            dailyRealizedPnl: 0,
            tradingDisabledUntil: 'not-an-iso-timestamp',
            updatedAt: new Date().toISOString(),
          }),
        }),
      },
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envBadTimestamp)
    expect(result.skipReason).toBe('portfolio_halted')
  })

  it('fail-closes to portfolio_halted when getPortfolio throws', async () => {
    const envWithBrokenPortfolio = {
      ...env,
      PORTFOLIO_STATE: {
        idFromName: () => ({}),
        get: () => ({
          getPortfolio: vi.fn().mockRejectedValue(new Error('DO unreachable')),
        }),
      },
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithBrokenPortfolio)
    expect(result.skipReason).toBe('portfolio_halted')
  })

  // CodeRabbit #196 review: 0013 未 migrate な D1 で earnings gate を有効化すると
  // `fetchByRange()` が `no such table` を吐き全 BUY が fail-closed reject される。
  // 起動時 sqlite_master チェックで table 不在を検知し、gate 自体を **注入しない**
  // ことを確認する (= 過去挙動 / approve all へ fallback)。`tradingDisabledUntil`
  // を未来時刻にして scheduler は起動させず、probe + warn だけ評価する。
  it('disables earnings gate when earnings_calendar table is missing (#196 review)', async () => {
    // sqlite_master を SELECT してくる prepare 呼び出し用 fake D1。
    // - SELECT 1 ... sqlite_master ... earnings_calendar → first() が null
    //   (table 未存在) → earningsGateReady=false で gate skip
    const firstSpy = vi.fn(async () => null)
    const fakeDb = {
      prepare: vi.fn(() => ({
        first: firstSpy,
      })),
    } as unknown as D1Database
    const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const envWithMissingTable = {
        DB: fakeDb,
        SYMBOL_STATE: {} as DurableObjectNamespace<never>,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 10_000,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]

      await runStrategyCron(envWithMissingTable, { requestId: 'req-no-table' }).catch(
        // scheduler 内部 (bar fetch / DO etc.) は本テストのスコープ外なので
        // 例外は握りつぶす。重要なのは sqlite_master probe + warn ログ。
        () => undefined,
      )

      const calls = (fakeDb.prepare as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>
      const probedSqliteMaster = calls.some(
        (c) => c[0].includes('sqlite_master') && c[0].includes('earnings_calendar'),
      )
      expect(probedSqliteMaster).toBe(true)
      // table 不在の warn ログが出る (operator が追跡できるよう)。
      const warnLines = warnSpy2.mock.calls.map((c) => String(c[0]))
      expect(
        warnLines.some((l) => l.includes('earnings_gate_disabled_table_missing')),
      ).toBe(true)
    } finally {
      warnSpy2.mockRestore()
    }
  })

  // issue #196 2/3: macro_event_calendar (0014) も同パターンで table 未存在
  // 環境では gate 無効化される。probe SELECT が走り、warn ログ
  // `macro_event_gate_disabled_table_missing` が出ることを確認する。
  it('disables macro event gate when macro_event_calendar table is missing (#196 2/3)', async () => {
    const firstSpy = vi.fn(async () => null)
    const fakeDb = {
      prepare: vi.fn(() => ({
        first: firstSpy,
      })),
    } as unknown as D1Database
    const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const envWithMissingTable = {
        DB: fakeDb,
        SYMBOL_STATE: {} as DurableObjectNamespace<never>,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 10_000,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]

      await runStrategyCron(envWithMissingTable, { requestId: 'req-no-macro-table' }).catch(
        () => undefined,
      )

      const calls = (fakeDb.prepare as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>
      const probedSqliteMaster = calls.some(
        (c) => c[0].includes('sqlite_master') && c[0].includes('macro_event_calendar'),
      )
      expect(probedSqliteMaster).toBe(true)
      const warnLines = warnSpy2.mock.calls.map((c) => String(c[0]))
      expect(
        warnLines.some((l) => l.includes('macro_event_gate_disabled_table_missing')),
      ).toBe(true)
    } finally {
      warnSpy2.mockRestore()
    }
  })

  // #141: critical な skip reason は Notifier 経由で push 通知される。
  // env.SLACK_WEBHOOK_URL を設定して fetch を spy し、webhook 行きの POST が
  // 1 回入ることだけ確認する (formatter は WebhookNotifier.test に分離済み)。
  it('pushes notify() when skipReason=portfolio_halted (#141)', async () => {
    const fetchSpy = vi
      .fn(async () => new Response('ok', { status: 200 }))
      .mockName('fetchSpy')
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const envWithBrokenPortfolio = {
        DB: {} as D1Database,
        SYMBOL_STATE: {} as DurableObjectNamespace<never>,
        // Webhook URL を設定 → notifier が fetch を叩く
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockRejectedValue(new Error('DO unreachable')),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
      const result = await runStrategyCron(envWithBrokenPortfolio, { requestId: 'req-x' })
      expect(result.skipReason).toBe('portfolio_halted')
      // notify は fire-and-forget なので microtask flush 待ち
      await new Promise((r) => setTimeout(r, 0))
      expect(fetchSpy).toHaveBeenCalled()
      const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>
      const body = JSON.parse(String(calls[0]?.[1]?.body))
      expect(body.text).toContain('CRITICAL')
      expect(body.text).toContain('portfolio_halted')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

})

describe('resolvePortfolioForRiskScale', () => {
  it('returns the portfolio unchanged when dailyStartEquity > 0', () => {
    const p = { dailyStartEquity: 10_000, dailyRealizedPnl: -100 }
    const r = resolvePortfolioForRiskScale(p, 3333)
    expect(r.usedFallback).toBe(false)
    expect(r.portfolio).toBe(p)
  })

  it('substitutes totalCapitalUsd when dailyStartEquity is 0 (unseeded)', () => {
    const r = resolvePortfolioForRiskScale(
      { dailyStartEquity: 0, dailyRealizedPnl: 0 },
      3333,
    )
    expect(r.usedFallback).toBe(true)
    expect(r.portfolio.dailyStartEquity).toBe(3333)
    expect(r.portfolio.dailyRealizedPnl).toBe(0)
  })

  it('does NOT fallback when dailyStartEquity is NaN (truly broken)', () => {
    const p = { dailyStartEquity: Number.NaN, dailyRealizedPnl: 0 }
    const r = resolvePortfolioForRiskScale(p, 3333)
    expect(r.usedFallback).toBe(false)
    expect(r.portfolio).toBe(p)
  })

  it('does NOT fallback when totalCapitalUsd is null / 0 / negative', () => {
    const p = { dailyStartEquity: 0, dailyRealizedPnl: 0 }
    expect(resolvePortfolioForRiskScale(p, null).usedFallback).toBe(false)
    expect(resolvePortfolioForRiskScale(p, undefined).usedFallback).toBe(false)
    expect(resolvePortfolioForRiskScale(p, 0).usedFallback).toBe(false)
    expect(resolvePortfolioForRiskScale(p, -100).usedFallback).toBe(false)
    expect(resolvePortfolioForRiskScale(p, Number.NaN).usedFallback).toBe(false)
  })

  it('treats negative dailyStartEquity as unseeded and falls back', () => {
    // Negative finite value is treated as unseeded (not yet initialized),
    // distinct from NaN which means corrupt.
    const r = resolvePortfolioForRiskScale(
      { dailyStartEquity: -1, dailyRealizedPnl: 0 },
      3333,
    )
    expect(r.usedFallback).toBe(true)
  })

  it('does NOT fallback when dailyRealizedPnl is non-finite (corrupt)', () => {
    // CodeRabbit #131 review: if realizedPnl is NaN / Infinity, the portfolio
    // snapshot is corrupt and must trigger fail-closed via drawdownRiskScale,
    // not get silently zeroed by the fallback path.
    const p = { dailyStartEquity: 0, dailyRealizedPnl: Number.NaN }
    const r = resolvePortfolioForRiskScale(p, 3333)
    expect(r.usedFallback).toBe(false)
    expect(r.portfolio).toBe(p)
  })
})

describe('emitStaleRollWarningIfNeeded (issue #140)', () => {
  // 2026-04-25T00:00:00Z を「現在」とみなして、24h 前 / 23h 前 / 48h 前 の
  // 3 ケースを単純化。Date.now の代わりに `now` 注入で時刻 mock。
  const fixedNowMs = Date.parse('2026-04-25T00:00:00.000Z')
  const now = () => fixedNowMs

  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('does NOT warn when lastRolledAt is null (greenfield / first run)', () => {
    emitStaleRollWarningIfNeeded({ lastRolledAt: null, now })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does NOT warn when lastRolledAt is fresh (< 24h)', () => {
    const fresh = new Date(fixedNowMs - 23 * 3_600_000).toISOString()
    emitStaleRollWarningIfNeeded({ lastRolledAt: fresh, now })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns when lastRolledAt is >= 24h old (stale)', () => {
    const stale = new Date(fixedNowMs - 25 * 3_600_000).toISOString()
    emitStaleRollWarningIfNeeded({ lastRolledAt: stale, now, requestId: 'req-1' })
    expect(warnSpy).toHaveBeenCalledOnce()
    const firstCall = warnSpy.mock.calls[0]
    if (!firstCall) throw new Error('warn was not called')
    const payload = JSON.parse(firstCall[0] as string) as Record<string, unknown>
    expect(payload.event).toBe('portfolio_roll_stale')
    expect(payload.requestId).toBe('req-1')
    expect(payload.staleHours).toBe(25)
    expect(payload.thresholdHours).toBe(24)
  })

  it('warns with reason=unparseable_lastRolledAt for malformed timestamp', () => {
    emitStaleRollWarningIfNeeded({ lastRolledAt: 'garbage', now })
    expect(warnSpy).toHaveBeenCalledOnce()
    const firstCall = warnSpy.mock.calls[0]
    if (!firstCall) throw new Error('warn was not called')
    const payload = JSON.parse(firstCall[0] as string) as Record<string, unknown>
    expect(payload.reason).toBe('unparseable_lastRolledAt')
  })
})
