import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import {
  emitStaleRollWarningIfNeeded,
  resolvePortfolioForRiskScale,
  runStrategyCron,
} from '../../../src/trading/strategy/runStrategyCron'
import { runPullbackScheduler } from '../../../src/trading/strategy/pullbackScheduler'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../../helpers/configFixtures'

const emptySchedulerSummary = () => ({
  evaluated: 0,
  buys: 0,
  sells: 0,
  holds: 0,
  rejected: [],
  errors: [],
  decisions: [],
  entrySnapshots: {},
})

/** 直近の runPullbackScheduler 呼び出しに渡された options。 */
function lastSchedulerOptions(): Parameters<typeof runPullbackScheduler>[0] {
  const calls = vi.mocked(runPullbackScheduler).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]![0]
}

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
// #exit-only-halt: risk halt でも scheduler まで進むため、DO/bar client を叩かず「何が渡されたか」を
// 検証できるよう scheduler を mock する。scheduler 自身の gate 挙動は pullbackScheduler.test.ts が担保する。
vi.mock('../../../src/trading/strategy/pullbackScheduler', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/trading/strategy/pullbackScheduler')>()
  return { ...actual, runPullbackScheduler: vi.fn() }
})
// loadNewsShockDecision は D1 read のみのはずなので、repo を mock して「fetch が無いこと」
// (= 本 PR で最重要な回帰ガード) にテストの焦点を絞る。drizzle 経由の実 D1 plumbing は重い。
vi.mock('../../../src/infrastructure/db/attentionObservationRepo', () => ({
  createAttentionObservationDb: vi.fn(() => ({}) as unknown),
  createAttentionObservationRepo: vi.fn(() => ({
    fetchRecent: vi.fn().mockResolvedValue([]),
    bulkInsertIgnore: vi.fn(),
    purgeOlderThan: vi.fn(),
  })),
}))

const env = {
  DB: {} as D1Database,
  SYMBOL_STATE: {} as DurableObjectNamespace<never>,
} as unknown as Parameters<typeof runStrategyCron>[0]

describe('runStrategyCron', () => {
  // mock D1 は 0012 migration の new tables を知らず prepare 系 warn が出る (silent fallback、無害) → suppress
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse())
    vi.mocked(runPullbackScheduler).mockResolvedValue(emptySchedulerSummary())
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

  it('env TRADING_ENABLED=false overrides DB tradingEnabled=true (#276 kill-switch)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: true }),
    )
    const envWithEnvOverride = {
      ...env,
      TRADING_ENABLED: 'false',
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithEnvOverride)
    expect(result.skipReason).toBe('trading_disabled')
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

  it('portfolio_halted halts entry only — exit judgment continues (#exit-only-halt)', async () => {
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
    expect(result.skipReason).toBeUndefined()
    expect(result.entryHaltReason).toMatch(/^portfolio_halted: tradingDisabledUntil=/)
    expect(result.analysis.entryHalt?.reason).toBe(result.entryHaltReason)
    const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
    expect(Object.keys(suppressed).sort()).toEqual(['SOXL', 'SOXS'])
    expect(suppressed.SOXL).toBe(result.entryHaltReason)
  })

  it('drawdown_kill (realized-PnL basis) halts entry only — holding positions keep their stop', async () => {
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
    expect(result.skipReason).toBeUndefined()
    expect(result.entryHaltReason).toMatch(/^drawdown_kill: ratio=/)
    const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
    expect(suppressed.SOXL).toBe(result.entryHaltReason)
    expect(suppressed.SOXS).toBe(result.entryHaltReason)
  })

  it('exit-only halt でも scheduler は全銘柄を評価対象として受け取る (exit を止めない)', async () => {
    const envWithPortfolio = {
      ...env,
      PORTFOLIO_STATE: {
        idFromName: () => ({}),
        get: () => ({
          getPortfolio: vi.fn().mockResolvedValue({
            dailyStartEquity: 10_000,
            dailyRealizedPnl: -250,
            tradingDisabledUntil: null,
            updatedAt: new Date().toISOString(),
          }),
        }),
      },
    } as unknown as Parameters<typeof runStrategyCron>[0]
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ drawdownKillThreshold: -0.02 }),
    )
    await runStrategyCron(envWithPortfolio)
    // symbols を間引くと保有が orphan になる (exit 判定が走らない) ので全銘柄渡す。
    expect(lastSchedulerOptions().symbols).toEqual(['SOXL', 'SOXS'])
  })

  it('fail-closes to portfolio_halted when PORTFOLIO_STATE binding is missing', async () => {
    const envWithoutPortfolio = {
      DB: {} as D1Database,
      SYMBOL_STATE: {} as DurableObjectNamespace<never>,
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithoutPortfolio)
    expect(result.skipReason).toBeUndefined()
    expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    expect(result.analysis.universe.symbols).toEqual(['SOXL', 'SOXS'])
    expect(lastSchedulerOptions().entrySuppressedSymbols?.SOXL).toBe(result.entryHaltReason)
  })

  it('cron only evaluates allowedSymbols and ignores inactiveSymbols', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        inactiveSymbols: ['9697'],
        symbolCurrency: { SOXL: 'USD', '9697': 'JPY' },
        symbolMarket: { SOXL: 'US', '9697': 'JP' },
        symbolNotes: { '9697': 'paused for review' },
      }),
    )
    const envWithoutBridge = {
      DB: {} as D1Database,
    } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithoutBridge)
    expect(result.analysis.universe.symbols).toEqual(['SOXL'])
    expect(result.analysis.universe.symbols).not.toContain('9697')
  })

  describe('exit-only inactive symbols with a held position', () => {
    function fakeSymbolState(
      states: Record<string, { position: { qty: number } | null }>,
    ): DurableObjectNamespace<never> {
      return {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          getState: vi.fn().mockResolvedValue(states[id.name] ?? { position: null }),
        }),
      } as unknown as DurableObjectNamespace<never>
    }

    function envWithSymbolState(
      symbolState: DurableObjectNamespace<never>,
    ): Parameters<typeof runStrategyCron>[0] {
      return {
        DB: {} as D1Database,
        SYMBOL_STATE: symbolState,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 0,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
    }

    const inactiveUniverse = () =>
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        inactiveSymbols: ['9697'],
        symbolCurrency: { SOXL: 'USD', '9697': 'JPY' },
        symbolMarket: { SOXL: 'US', '9697': 'JP' },
        symbolLotSize: { SOXL: 1, '9697': 100 },
      })

    it('inactive symbol with qty>0 is added to its currency run and suppressed as exit-only', async () => {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(inactiveUniverse())
      const symbolState = fakeSymbolState({ '9697': { position: { qty: 100 } } })
      const result = await runStrategyCron(envWithSymbolState(symbolState))

      expect(result.analysis.exitOnlySymbols).toEqual(['9697'])
      // 評価対象 (universe) には混ぜない — dashboard / risk gate 表示の意味を保つ。
      expect(result.analysis.universe.symbols).toEqual(['SOXL'])

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      const jpyCall = calls.find((c) => c[0].symbols.includes('9697'))
      expect(jpyCall).toBeDefined()
      expect(jpyCall![0].entrySuppressedSymbols?.['9697']).toBe('symbol inactive: exit-only')
    })

    it('inactive symbol with no position is not added to any run', async () => {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(inactiveUniverse())
      const symbolState = fakeSymbolState({ '9697': { position: null } })
      const result = await runStrategyCron(envWithSymbolState(symbolState))

      expect(result.analysis.exitOnlySymbols).toEqual([])
      const calls = vi.mocked(runPullbackScheduler).mock.calls
      for (const [opts] of calls) {
        expect(opts.symbols).not.toContain('9697')
      }
    })

    it('logs exit_only_state_read_failed and skips the symbol when getState throws', async () => {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(inactiveUniverse())
      const symbolState = {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          getState: vi.fn().mockRejectedValue(new Error('DO unavailable')),
        }),
      } as unknown as DurableObjectNamespace<never>
      const result = await runStrategyCron(envWithSymbolState(symbolState))

      expect(result.analysis.exitOnlySymbols).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('exit_only_state_read_failed'),
      )
    })
  })

  describe('risk-% sizing equity — no phantom capital baseline', () => {
    it('omits equity from scheduler options and reports null in analysis when total_capital_usd is unset', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ totalCapitalUsd: null }),
      )
      const result = await runStrategyCron(env)
      expect(lastSchedulerOptions().equity).toBeUndefined()
      const usdRun = result.analysis.runs.find((r) => r.currency === 'USD')
      expect(usdRun?.equity).toBeNull()
    })

    it('passes total_capital_usd through as scheduler equity and analysis.runs equity when set', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ totalCapitalUsd: 50_000 }),
      )
      const result = await runStrategyCron(env)
      expect(lastSchedulerOptions().equity).toBe(50_000)
      const usdRun = result.analysis.runs.find((r) => r.currency === 'USD')
      expect(usdRun?.equity).toBe(50_000)
    })
  })

  // manual /trade/execute と cash-rebalance では既に効いていたが cron の通常 BUY sizing は未対応だった回帰ガード
  describe('global max order notional cap passthrough', () => {
    it('passes max_order_notional_usd through to the scheduler for a USD run', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ maxOrderNotionalUsd: 3_000 }),
      )
      await runStrategyCron(env)
      expect(lastSchedulerOptions().maxOrderNotional).toBe(3_000)
    })

    it('omits maxOrderNotional when the configured value is non-finite/non-positive', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ maxOrderNotionalUsd: 0 }),
      )
      await runStrategyCron(env)
      expect(lastSchedulerOptions().maxOrderNotional).toBeUndefined()
    })
  })

  // manual 経路 (TradingService) は PortfolioState.openExposure* を見るが、cron は自身が読む symbol state から建玉を積み上げる
  describe('portfolio exposure ledger', () => {
    function fakeSymbolStateWithPositions(
      positions: Record<string, { qty: number; avgPrice: number } | null>,
    ): DurableObjectNamespace<never> {
      return {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          getState: vi.fn().mockResolvedValue({ position: positions[id.name] ?? null }),
        }),
      } as unknown as DurableObjectNamespace<never>
    }

    function envWithSymbolState(
      symbolState: DurableObjectNamespace<never>,
    ): Parameters<typeof runStrategyCron>[0] {
      return {
        DB: {} as D1Database,
        SYMBOL_STATE: symbolState,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 0,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
    }

    it('builds an ok ledger from held JPY symbol states and applies the exposure ceiling', async () => {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(
        makeSymbolUniverse({
          allowedSymbols: ['9697'],
          symbolCurrency: { '9697': 'JPY' },
          symbolMarket: { '9697': 'JP' },
          symbolLotSize: { '9697': 100 },
        }),
      )
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ totalCapitalJpy: 1_000_000, maxPortfolioExposurePct: 0.6 }),
      )
      const symbolState = fakeSymbolStateWithPositions({ '9697': { qty: 100, avgPrice: 2000 } })
      const result = await runStrategyCron(envWithSymbolState(symbolState))

      expect(result.analysis.exposure).toEqual({
        status: 'ok',
        ceilingJpy: 600_000,
        currentJpy: 200_000,
        remainingJpy: 400_000,
      })
      expect(lastSchedulerOptions().exposureCap?.status).toBe('ok')
    })

    it('reports unavailable when total_capital_jpy is unset', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ totalCapitalJpy: null }),
      )
      const result = await runStrategyCron(env)
      expect(result.analysis.exposure?.status).toBe('unavailable')
      expect(result.analysis.exposure?.reason).toBe('total_capital_jpy unset')
    })

    it('fails closed when a USD position exists but the usd/jpy rate is unavailable', async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('network disabled in test')
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      try {
        vi.mocked(loadSymbolUniverse).mockResolvedValue(
          makeSymbolUniverse({
            allowedSymbols: ['AAPL'],
            symbolCurrency: { AAPL: 'USD' },
            symbolMarket: { AAPL: 'US' },
            symbolLotSize: { AAPL: 1 },
          }),
        )
        vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
          makeGlobalConfigSnapshot({ totalCapitalJpy: 1_000_000 }),
        )
        const symbolState = fakeSymbolStateWithPositions({ AAPL: { qty: 10, avgPrice: 100 } })
        const result = await runStrategyCron(envWithSymbolState(symbolState))

        expect(result.analysis.exposure?.status).toBe('unavailable')
        expect(result.analysis.exposure?.reason).toBe('usd/jpy rate unavailable')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('includes a held JPY position in the ledger while only the US session window is open', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-20T17:00:00.000Z')) // US 13:00 ET (in) / JP 02:00 JST 火 (out)
      const fetchSpy = vi.fn(async () => {
        throw new Error('network disabled in test')
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      try {
        vi.mocked(loadSymbolUniverse).mockResolvedValue(
          makeSymbolUniverse({
            allowedSymbols: ['AAPL', '9697'],
            symbolCurrency: { AAPL: 'USD', '9697': 'JPY' },
            symbolMarket: { AAPL: 'US', '9697': 'JP' },
            symbolLotSize: { AAPL: 1, '9697': 100 },
          }),
        )
        vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
          makeGlobalConfigSnapshot({
            sessionWindowGateEnabled: true,
            totalCapitalJpy: 1_000_000,
            maxPortfolioExposurePct: 0.6,
          }),
        )
        const symbolState = fakeSymbolStateWithPositions({ '9697': { qty: 100, avgPrice: 2000 } })
        const result = await runStrategyCron(envWithSymbolState(symbolState))

        expect(result.analysis.exposure).toEqual({
          status: 'ok',
          ceilingJpy: 600_000,
          currentJpy: 200_000,
          remainingJpy: 400_000,
        })
        expect(vi.mocked(runPullbackScheduler).mock.calls).toHaveLength(1)
        expect(lastSchedulerOptions().symbols).toEqual(['AAPL'])
      } finally {
        globalThis.fetch = originalFetch
        vi.useRealTimers()
      }
    })

    it('fails closed when a held position has a non-finite avgPrice', async () => {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(
        makeSymbolUniverse({
          allowedSymbols: ['9697'],
          symbolCurrency: { '9697': 'JPY' },
          symbolMarket: { '9697': 'JP' },
          symbolLotSize: { '9697': 100 },
        }),
      )
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ totalCapitalJpy: 1_000_000, maxPortfolioExposurePct: 0.6 }),
      )
      const symbolState = fakeSymbolStateWithPositions({ '9697': { qty: 100, avgPrice: NaN } })
      const result = await runStrategyCron(envWithSymbolState(symbolState))

      expect(result.analysis.exposure?.status).toBe('unavailable')
      expect(result.analysis.exposure?.reason).toBe('invalid position valuation for 9697')
    })
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
    expect(result.skipReason).toBeUndefined()
    expect(result.entryHaltReason).toBe(
      'portfolio_halted: tradingDisabledUntil=not-an-iso-timestamp',
    )
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
    expect(result.skipReason).toBeUndefined()
    expect(result.entryHaltReason).toBe('portfolio_halted: getPortfolio threw: DO unreachable')
  })

  it('disables earnings gate when earnings_calendar table is missing (#196 review)', async () => {
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

      // scheduler 内部 (bar fetch / DO etc.) はスコープ外なので例外は握りつぶす — 見るのは probe + warn ログのみ
      await runStrategyCron(envWithMissingTable, { requestId: 'req-no-table' }).catch(
        () => undefined,
      )

      const calls = (fakeDb.prepare as ReturnType<typeof vi.fn>).mock.calls as Array<[string]>
      const probedSqliteMaster = calls.some(
        (c) => c[0].includes('sqlite_master') && c[0].includes('earnings_calendar'),
      )
      expect(probedSqliteMaster).toBe(true)
      const warnLines = warnSpy2.mock.calls.map((c) => String(c[0]))
      expect(
        warnLines.some((l) => l.includes('earnings_gate_disabled_table_missing')),
      ).toBe(true)
    } finally {
      warnSpy2.mockRestore()
    }
  })

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

  describe('news shock gate wiring (news-shock-gate PR 2)', () => {
    /** `sqlite_master` probe で `attention_observation` だけ ready、他は未存在扱いの fake D1。 */
    function fakeDbWithAttentionReady(): D1Database {
      return {
        prepare: vi.fn((sql: string) => ({
          first: vi.fn(async () =>
            sql.includes("name='attention_observation'") ? { ok: 1 } : null,
          ),
        })),
      } as unknown as D1Database
    }

    function envWithHealthyPortfolio(db: D1Database) {
      return {
        DB: db,
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
    }

    // 比較方式を使う理由: loadVixDecision が ^VIX を実 fetch するため tick 中の fetch 回数は 0 にならない。
    // baseline (mode=off) との差分ゼロが「news shock gate は fetch を足していない」ことの証拠になる。
    it('adds zero external fetch calls when the news shock gate evaluates (enforce mode)', async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('network disabled in test')
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
        await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
          requestId: 'req-news-baseline',
        })
        const baselineCalls = fetchSpy.mock.calls.length
        expect(baselineCalls).toBeGreaterThan(0) // sanity: VIX fetch は実際に起きている

        fetchSpy.mockClear()

        vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
          makeGlobalConfigSnapshot({ newsShockMode: 'enforce' }),
        )
        await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
          requestId: 'req-news-enforce',
        })
        const enforceCalls = fetchSpy.mock.calls.length

        expect(enforceCalls).toBe(baselineCalls)
      } finally {
        globalThis.fetch = originalFetch
        warnSpy2.mockRestore()
      }
    })

    it('passes a newsShockGate option to runPullbackScheduler when mode=enforce and the table is ready', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ newsShockMode: 'enforce' }),
      )
      await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
        requestId: 'req-news-option',
      })
      const opts = lastSchedulerOptions()
      expect(opts.newsShockGate).toBeDefined()
      expect(opts.newsShockGate?.mode).toBe('enforce')
      expect(opts.newsShockGate?.decision.regime).toBeDefined()
    })

    it('omits the newsShockGate option when news_shock_mode=off (default)', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
      await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
        requestId: 'req-news-off',
      })
      const opts = lastSchedulerOptions()
      expect(opts.newsShockGate).toBeUndefined()
    })

    it('omits the newsShockGate option and warns when attention_observation table is missing (mode=enforce)', async () => {
      const firstSpy = vi.fn(async () => null)
      const fakeDb = {
        prepare: vi.fn(() => ({ first: firstSpy })),
      } as unknown as D1Database
      const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
          makeGlobalConfigSnapshot({ newsShockMode: 'enforce' }),
        )
        await runStrategyCron(envWithHealthyPortfolio(fakeDb), { requestId: 'req-news-no-table' })
        const opts = lastSchedulerOptions()
        expect(opts.newsShockGate).toBeUndefined()
        const warnLines = warnSpy2.mock.calls.map((c) => String(c[0]))
        expect(
          warnLines.some((l) => l.includes('news_shock_gate_disabled_table_missing')),
        ).toBe(true)
      } finally {
        warnSpy2.mockRestore()
      }
    })

    // #619: mock は globalConfigRepo の DB-side sanitize を経由しないため、
    // loadNewsShockDecision 自身の NaN 防御が単独で効くことを確認する回帰ガード。
    it('completes without throwing when newsShockBaselineDays is NaN (misconfigured DB value, #619)', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ newsShockMode: 'enforce', newsShockBaselineDays: Number.NaN }),
      )
      const result = await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
        requestId: 'req-news-nan-baseline',
      })
      expect(result.summary).toBeDefined()
      expect(result.analysis.schema).toBe('strategy_cron_analysis.v1')
    })
  })

  // formatter は WebhookNotifier.test に分離済み — ここでは POST が 1 回入ることだけ確認する
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
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x',
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockRejectedValue(new Error('DO unreachable')),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
      const result = await runStrategyCron(envWithBrokenPortfolio, { requestId: 'req-x' })
      expect(result.entryHaltReason).toBe('portfolio_halted: getPortfolio threw: DO unreachable')
      // notify は fire-and-forget なので microtask flush 待ち
      await new Promise((r) => setTimeout(r, 0))
      expect(fetchSpy).toHaveBeenCalled()
      const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>
      const body = JSON.parse(String(calls[0]?.[1]?.body))
      expect(body.text).toContain('🚨')
      expect(body.text).toContain('売買停止中 (ポートフォリオ停止)')
      expect(body.text).toContain('portfolio_halted')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // 市場ごとに判定 (USD→US / JPY→JP)。flag off は従来挙動。
  describe('session window gate (#session-window-gate)', () => {
    // 2026-04-20(月) EDT。US 窓 [09:00,16:00 ET]、JP 窓 [08:30,15:30 JST]。
    const T_US_IN = '2026-04-20T17:00:00.000Z' // US 13:00 ET (in) / JP 02:00 JST 火 (out)
    const T_JP_IN = '2026-04-20T01:00:00.000Z' // JP 10:00 JST 月 (in) / US 21:00 ET 日 (out)
    const T_US_OUT = '2026-04-20T06:00:00.000Z' // US 02:00 ET (out)

    afterEach(() => {
      vi.useRealTimers()
    })

    const jpyUniverse = () =>
      makeSymbolUniverse({
        allowedSymbols: ['7203'],
        symbolCurrency: { '7203': 'JPY' },
        symbolMarket: { '7203': 'JP' },
        symbolLotSize: { '7203': 100 },
      })

    it('flag off では窓外でも outside_session_window で skip しない', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_US_OUT))
      const result = await runStrategyCron(env)
      expect(result.skipReason).toBeUndefined()
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })

    it('flag on + 全市場窓外 → outside_session_window で即 skip', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_US_OUT))
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      const result = await runStrategyCron(env)
      expect(result.skipReason).toBe('outside_session_window')
      expect(result.summary.evaluated).toBe(0)
    })

    it('flag on + 窓内 → gate を通過して評価に進む', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_US_IN))
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      const result = await runStrategyCron(env)
      expect(result.skipReason).not.toBe('outside_session_window')
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })

    it('per-market: JPY 銘柄は US 窓内でも JP 窓外なら skip', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_US_IN)) // US in / JP out
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      vi.mocked(loadSymbolUniverse).mockResolvedValue(jpyUniverse())
      const result = await runStrategyCron(env)
      expect(result.skipReason).toBe('outside_session_window')
    })

    it('per-market: JPY 銘柄は JP 窓内なら US 窓外でも評価に進む', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_JP_IN)) // JP in / US out
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      vi.mocked(loadSymbolUniverse).mockResolvedValue(jpyUniverse())
      const result = await runStrategyCron(env)
      expect(result.skipReason).not.toBe('outside_session_window')
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })

    // 2026-07-03 は Independence Day 振替休場 (7/4=土)。13:00 ET は通常なら窓内だが休場日は market_holiday で skip する。
    const T_US_HOLIDAY = '2026-07-03T17:00:00.000Z'

    it('flag on + US 祝日 → market_holiday で skip (#547)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_US_HOLIDAY))
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      const result = await runStrategyCron(env)
      expect(result.skipReason).toBe('market_holiday')
      expect(result.summary.evaluated).toBe(0)
    })

    it('flag off では祝日でも gate で止まらない (従来挙動)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(T_US_HOLIDAY))
      const result = await runStrategyCron(env)
      expect(result.skipReason).not.toBe('market_holiday')
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })

    it('休場と窓外が混在する場合は outside_session_window に倒す', async () => {
      vi.useFakeTimers()
      // US = 祝日 / JP = 窓外。全 market skip だが「全休場」ではないので従来ラベル。
      vi.setSystemTime(new Date(T_US_HOLIDAY))
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      vi.mocked(loadSymbolUniverse).mockResolvedValue(
        makeSymbolUniverse({
          allowedSymbols: ['SOXL', '7203'],
          symbolCurrency: { SOXL: 'USD', '7203': 'JPY' },
          symbolMarket: { SOXL: 'US', '7203': 'JP' },
          symbolLotSize: { SOXL: 1, '7203': 100 },
        }),
      )
      const result = await runStrategyCron(env)
      expect(result.skipReason).toBe('outside_session_window')
    })

    it('半日取引日 (2026-11-27) は 13:00 ET 以降 outside_session_window (#547)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-11-27T18:30:00.000Z')) // 13:30 ET (早引け後)
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      const result = await runStrategyCron(env)
      expect(result.skipReason).toBe('outside_session_window')
    })

    it('半日取引日でも 13:00 ET 前は評価に進む', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-11-27T17:00:00.000Z')) // 12:00 ET
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      const result = await runStrategyCron(env)
      expect(result.skipReason).not.toBe('outside_session_window')
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })
  })

  // 寄り前に決定した BUY は MARKET 注文として寄り値と乖離した価格で約定し得るため、
  // sessionWindowGateEnabled の値に関わらずレギュラーセッション外の BUY は常に抑止する (exit は対象外)。
  describe('regular session BUY gate', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** PORTFOLIO_STATE を健全な値で bind した env (entryHaltReason を null に保つ)。 */
    function envHealthyPortfolio(): Parameters<typeof runStrategyCron>[0] {
      return {
        DB: {} as D1Database,
        SYMBOL_STATE: {} as DurableObjectNamespace<never>,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 0,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
    }

    const SESSION_REASON = 'outside regular session: BUY deferred (exits still evaluated)'

    it('gate on: 寄り前 (09:10 ET) は USD 銘柄全てが session 理由で BUY 抑止される', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-20T13:10:00.000Z')) // 09:10 ET (月)
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      await runStrategyCron(envHealthyPortfolio())
      const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
      expect(suppressed.SOXL).toBe(SESSION_REASON)
      expect(suppressed.SOXS).toBe(SESSION_REASON)
    })

    it('gate on: 開場後 (09:35 ET) は session 理由で抑止されない', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-20T13:35:00.000Z')) // 09:35 ET (月)
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ sessionWindowGateEnabled: true }),
      )
      await runStrategyCron(envHealthyPortfolio())
      const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
      expect(suppressed.SOXL).toBeUndefined()
      expect(suppressed.SOXS).toBeUndefined()
    })

    it('gate off でも時間外 (20:00 ET) は session 理由で抑止される (終日評価の素通し防止)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z')) // 20:00 ET (月)
      await runStrategyCron(envHealthyPortfolio())
      const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
      expect(suppressed.SOXL).toBe(SESSION_REASON)
      expect(suppressed.SOXS).toBe(SESSION_REASON)
    })
  })

  // pass 2 が pass 1 と同じ制約 (earnings / macro / sanity-failed cooldown / intraday-only close)
  // を受けないと、通常 BUY が止まる局面でも退避先へ買い戻す抜け道になる。
  describe('cash rebalance pass 2 shares pass 1 behavioral gates (#452 follow-up)', () => {
    const JP_IN_SESSION = '2026-04-20T02:00:00.000Z' // 11:00 JST、レギュラーセッション内
    const JP_PRE_OPEN = '2026-04-19T23:00:00.000Z' // 08:00 JST (月, 開場前)

    afterEach(() => {
      vi.useRealTimers()
    })

    /** sqlite_master probe に全 table ready (`{ ok: 1 }`) で応答する fake D1。 */
    function fakeDbAllTablesReady(): D1Database {
      return {
        prepare: vi.fn(() => ({
          first: vi.fn(async () => ({ ok: 1 })),
        })),
      } as unknown as D1Database
    }

    function envWithHealthyPortfolio(db: D1Database) {
      return {
        DB: db,
        SYMBOL_STATE: {} as DurableObjectNamespace<never>,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 0,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
    }

    // JPY-only universe (fx=1) で usdJpyRate 取得を経路から外す。SOXL は entry_required だが
    // WATCH/NG 想定 → cash_fallback 先 SGOV へ退避し、pass 2 の BUY 計画が立つ。
    function setUpCashFallbackFixture(): void {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(
        makeSymbolUniverse({
          allowedSymbols: ['SOXL', 'SGOV'],
          symbolCurrency: { SOXL: 'JPY', SGOV: 'JPY' },
          symbolMarket: { SOXL: 'JP', SGOV: 'JP' },
          symbolLotSize: { SOXL: 1, SGOV: 1 },
          symbolBudgetAllocPct: { SOXL: 0.5 },
          symbolEntryRequired: { SOXL: true },
          symbolCashFallback: { SOXL: ['SGOV'] },
        }),
      )
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ cashFallbackOrdersEnabled: true, totalCapitalJpy: 10_000_000 }),
      )
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'NG', price: 100, heldQty: 0 },
          SGOV: { status: 'NG', price: 100, heldQty: 0 },
        },
      })
    }

    it('pass 2 runPullbackScheduler call receives the same behavioral gate options as pass 1', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackFixture()

      const db = fakeDbAllTablesReady()
      await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(2) // pass 1 + cash rebalance pass 2
      const [pass1Options] = calls[0]!
      const [pass2Options] = calls[1]!
      expect(pass2Options.cashRebalanceQuantityMap).toBeDefined() // pass 2 が cash rebalance 経路を通った前提確認

      for (const key of [
        'intradayOnlySymbols',
        'sanityFailedCooldown',
        'earningsGate',
        'macroEventGate',
      ] as const) {
        expect(pass1Options[key]).toBeDefined()
        expect(pass2Options[key]).toBeDefined()
      }

      // exposure ledger は同一 object を pass 1/2 で共有し逐次減算する契約 — 別 object だと
      // 片方の BUY 消費が他方に反映されず tick 全体で上限を超過し得る。
      expect(pass1Options.exposureCap).toBeDefined()
      expect(pass2Options.exposureCap).toBe(pass1Options.exposureCap)
    })

    // pass 2 は entrySuppressedSymbols を渡さない唯一の BUY 経路なので、通貨単位で
    // レギュラーセッション外を弾かないと開場前の退避 BUY が素通りしてしまう。
    it('pass 2 is not invoked before the regular session opens', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_PRE_OPEN))
      setUpCashFallbackFixture()

      const db = fakeDbAllTablesReady()
      const result = await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(1) // pass 1 のみ、cash rebalance pass 2 は skip
      expect(result.analysis.allocation?.rebalanceSkipped).toContainEqual(
        expect.objectContaining({
          symbol: 'SGOV',
          reason: 'outside regular session: cash rebalance deferred',
        }),
      )
    })
  })

  describe('cash rebalance SELL (#452 follow-up)', () => {
    const JP_IN_SESSION = '2026-04-20T02:00:00.000Z' // 11:00 JST

    afterEach(() => {
      vi.useRealTimers()
    })

    function fakeDbAllTablesReady(): D1Database {
      return {
        prepare: vi.fn(() => ({
          first: vi.fn(async () => ({ ok: 1 })),
        })),
      } as unknown as D1Database
    }

    function envWithHealthyPortfolio(db: D1Database) {
      return {
        DB: db,
        SYMBOL_STATE: {} as DurableObjectNamespace<never>,
        PORTFOLIO_STATE: {
          idFromName: () => ({}),
          get: () => ({
            getPortfolio: vi.fn().mockResolvedValue({
              dailyStartEquity: 0,
              dailyRealizedPnl: 0,
              tradingDisabledUntil: null,
              updatedAt: new Date().toISOString(),
            }),
          }),
        },
      } as unknown as Parameters<typeof runStrategyCron>[0]
    }

    // JPY-only universe (fx=1) + SOXL→SGOV cash fallback。maxOrderNotionalJpy は各テストで
    // default (100,000) を超える上限に上書きする — 想定 quantity を clamp してしまうため。
    function setUpCashFallbackSellUniverse(): void {
      vi.mocked(loadSymbolUniverse).mockResolvedValue(
        makeSymbolUniverse({
          allowedSymbols: ['SOXL', 'SGOV'],
          symbolCurrency: { SOXL: 'JPY', SGOV: 'JPY' },
          symbolMarket: { SOXL: 'JP', SGOV: 'JP' },
          symbolLotSize: { SOXL: 1, SGOV: 1 },
          symbolBudgetAllocPct: { SOXL: 0.5 },
          symbolEntryRequired: { SOXL: true },
          symbolCashFallback: { SOXL: ['SGOV'] },
        }),
      )
    }

    it('observe: 発注せず log と rebalanceSkipped だけに計画を残す', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackSellUniverse()
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({
          cashFallbackSellMode: 'observe',
          totalCapitalJpy: 10_000_000,
          maxOrderNotionalJpy: 100_000_000,
        }),
      )
      // SOXL 保有中 (自身の枠を使用中 → desired=0) かつ同 tick で買い増しを試行 (= 需要あり)、SGOV は保有超過
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'NG', price: 100, heldQty: 10 },
          SGOV: { status: 'NG', price: 1000, heldQty: 10_000 },
        },
        decisions: [{ symbol: 'SOXL', decision: 'BUY' }],
      })
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

      const db = fakeDbAllTablesReady()
      const result = await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(1) // pass 1 のみ、observe は発注しない

      const observedLog = logSpy.mock.calls
        .map((args) => JSON.parse(args[0] as string) as Record<string, unknown>)
        .find((payload) => payload.event === 'cash_rebalance_sell_observed')
      expect(observedLog?.orders).toEqual([
        { symbol: 'SGOV', quantity: 10_000, estimatedNotional: 10_000_000 },
      ])

      expect(result.analysis.allocation?.rebalanceSkipped).toContainEqual({
        symbol: 'SGOV',
        reason: 'observe: would sell 10000 toward active weight',
      })
      logSpy.mockRestore()
    })

    it('enforce: 退避元の BUY 試行を起点に pass 2 が cashRebalanceSellQuantityMap 付きで呼ばれる', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackSellUniverse()
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({
          cashFallbackSellMode: 'enforce',
          cashFallbackOrdersEnabled: false, // BUY 側は off のままでも SELL 側は独立に動く
          totalCapitalJpy: 10_000_000,
          maxOrderNotionalJpy: 100_000_000,
        }),
      )
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'NG', price: 100, heldQty: 10 },
          SGOV: { status: 'NG', price: 1000, heldQty: 10_000 },
        },
        decisions: [{ symbol: 'SOXL', decision: 'BUY' }],
      })

      const db = fakeDbAllTablesReady()
      await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(2) // pass 1 + cash rebalance pass 2 (SELL)
      const [pass2Options] = calls[1]!
      expect(pass2Options.cashRebalanceSellQuantityMap).toEqual({ SGOV: 10_000 })
      expect(pass2Options.cashRebalanceQuantityMap).toBeUndefined()
    })

    it('enforce: 退避元を保有しているだけでは需要にならない (exit 後の買い戻し往復を防ぐ)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackSellUniverse()
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({
          cashFallbackSellMode: 'enforce',
          totalCapitalJpy: 10_000_000,
          maxOrderNotionalJpy: 100_000_000,
        }),
      )
      // SOXL は既に約定済み (現金は消費済み) で、この tick に BUY 試行は無い。
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'NG', price: 100, heldQty: 10 },
          SGOV: { status: 'NG', price: 1000, heldQty: 10_000 },
        },
      })

      const db = fakeDbAllTablesReady()
      const result = await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(1) // pass 1 のみ
      expect(result.analysis.allocation?.rebalanceSkipped).toContainEqual({
        symbol: 'SGOV',
        reason: 'no demand from reroute sources',
      })
    })

    it('enforce: 需要は未保有の退避元の BUY 試行からも成立する', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackSellUniverse()
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({
          cashFallbackSellMode: 'enforce',
          totalCapitalJpy: 10_000_000,
          maxOrderNotionalJpy: 100_000_000,
        }),
      )
      // SOXL は未保有 (WATCH → SGOV へ reroute) だが pass 1 で BUY を試みている (broker reject/error でも需要ありとみなす)
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'WATCH', price: 100, heldQty: 0 },
          SGOV: { status: 'NG', price: 1000, heldQty: 10_000 },
        },
        decisions: [{ symbol: 'SOXL', decision: 'BUY' }],
      })

      const db = fakeDbAllTablesReady()
      await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(2)
      const [pass2Options] = calls[1]!
      // desired = 0.5 * 10M = 5,000,000 JPY → excess = 5,000,000 → 5,000 株。
      expect(pass2Options.cashRebalanceSellQuantityMap).toEqual({ SGOV: 5_000 })
    })

    it('需要が無ければ売らない (pass 2 呼ばれず、skip 理由が残る)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackSellUniverse()
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({
          cashFallbackSellMode: 'enforce',
          totalCapitalJpy: 10_000_000,
          maxOrderNotionalJpy: 100_000_000,
        }),
      )
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'WATCH', price: 100, heldQty: 0 },
          SGOV: { status: 'NG', price: 1000, heldQty: 10_000 },
        },
      })

      const db = fakeDbAllTablesReady()
      const result = await runStrategyCron(envWithHealthyPortfolio(db))

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(1) // pass 1 のみ
      expect(result.analysis.allocation?.rebalanceSkipped).toContainEqual({
        symbol: 'SGOV',
        reason: 'no demand from reroute sources',
      })
    })

    it('entryHaltReason がある tick では SELL 計画も止める (#exit-only-halt)', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(JP_IN_SESSION))
      setUpCashFallbackSellUniverse()
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({
          cashFallbackSellMode: 'enforce',
          totalCapitalJpy: 10_000_000,
          maxOrderNotionalJpy: 100_000_000,
        }),
      )
      vi.mocked(runPullbackScheduler).mockResolvedValueOnce({
        ...emptySchedulerSummary(),
        entrySnapshots: {
          SOXL: { status: 'NG', price: 100, heldQty: 10 },
          SGOV: { status: 'NG', price: 1000, heldQty: 10_000 },
        },
        decisions: [{ symbol: 'SOXL', decision: 'BUY' }],
      })

      const result = await runStrategyCron(env)

      const calls = vi.mocked(runPullbackScheduler).mock.calls
      expect(calls.length).toBe(1) // pass 1 のみ、halt 中は SELL pass 2 も止まる
      expect(result.entryHaltReason).toBeDefined()
    })
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
    // negative finite = unseeded (not yet initialized), distinct from NaN which means corrupt
    const r = resolvePortfolioForRiskScale(
      { dailyStartEquity: -1, dailyRealizedPnl: 0 },
      3333,
    )
    expect(r.usedFallback).toBe(true)
  })

  it('does NOT fallback when dailyRealizedPnl is non-finite (corrupt, #131 review)', () => {
    const p = { dailyStartEquity: 0, dailyRealizedPnl: Number.NaN }
    const r = resolvePortfolioForRiskScale(p, 3333)
    expect(r.usedFallback).toBe(false)
    expect(r.portfolio).toBe(p)
  })
})

describe('emitStaleRollWarningIfNeeded (issue #140)', () => {
  // Date.now の代わりに now 注入で時刻を mock し、24h/23h/48h 前のケースを単純化する
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
