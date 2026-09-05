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
// #exit-only-halt: risk halt でも scheduler まで進む (entry だけ抑止) ようになった
// ので、DO / bar client を叩かずに「何が渡されたか」を検証できるよう scheduler を
// mock する。scheduler 自身の gate 挙動は pullbackScheduler.test.ts が担保する。
vi.mock('../../../src/trading/strategy/pullbackScheduler', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/trading/strategy/pullbackScheduler')>()
  return { ...actual, runPullbackScheduler: vi.fn() }
})
// news-shock-gate PR 2: `loadNewsShockDecision` は D1 read のみ (fetch は
// しない) だが、drizzle 経由の実 D1 plumbing をここで fake するのは重い。
// repo 自体を mock して「D1 read があったこと」ではなく「fetch が無いこと」
// (= 本 PR で最重要な回帰ガード) にテストの焦点を絞る。
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
  // 0012 migration の new tables (config_state_snapshot / notification_emit_log)
  // を mock D1 が知らないので、`this.client.prepare is not a function` 系の
  // warn が大量に出る。挙動には影響しない (silent fallback) ので suppress。
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

  // #276: env=false が DB=true を上書きする。「より制限的な側が勝つ」 invariant の
  // cron 経路での確認。DB が true でも env override が効いていれば cron は
  // trading_disabled で即 skip し、PORTFOLIO_STATE などへ進まない (fail-closed)。
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
    // analysis.config.tradingEnabled は effective 値 (env override 適用後) を反映する。
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
    // #exit-only-halt: run 全体は skip せず、entry だけ止めて exit 判定は続ける。
    expect(result.skipReason).toBeUndefined()
    expect(result.entryHaltReason).toMatch(/^portfolio_halted: tradingDisabledUntil=/)
    expect(result.analysis.entryHalt?.reason).toBe(result.entryHaltReason)
    // 全銘柄が BUY 抑止として scheduler に渡る (SELL は素通り = scheduler 側の契約)。
    const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
    expect(Object.keys(suppressed).sort()).toEqual(['SOXL', 'SOXS'])
    expect(suppressed.SOXL).toBe(result.entryHaltReason)
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
    // drawdown kill は **実現損益**基準 = stop が効いた直後に発火する。ここで
    // 全停止すると残りの保有の stop が消えるので、entry だけを止める。
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

  // dashboard が disabled (active=0) を表示するために `inactiveSymbols` を
  // SymbolUniverse に追加したが、cron / risk gate の評価対象は引き続き
  // `allowedSymbols` のみであることを保証する regression test (= disabled 銘柄が
  // 評価ループに混入しない)。
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
    // analysis.universe.symbols は cron が評価しようとした symbol 集合。
    // inactiveSymbols (9697) は混入しない。
    expect(result.analysis.universe.symbols).toEqual(['SOXL'])
    expect(result.analysis.universe.symbols).not.toContain('9697')
  })

  // #p0-path-fixes 4a: `symbol_config.active = 0` は評価対象から丸ごと外れるため、
  // そこに残った保有はこれまで永久に exit されなかった。qty>0 が残る inactive
  // 銘柄だけを exit-only として run に混ぜる回帰ガード。
  describe('exit-only inactive symbols with a held position (#p0-path-fixes 4a)', () => {
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

  // news-shock-gate PR 2: 同じ sqlite_master probe パターンで
  // `attention_observation` (PR 1) の有無を判定する。
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

    /**
     * **最重要の回帰ガード**: news shock gate (D1 read のみのはず) を有効化
     * しても、15分間隔の strategy tick 中の外部 `fetch` 呼び出し回数が
     * 1 ミリも増えないこと。`globalThis.fetch` を spy に差し替え、
     * `news_shock_mode='off'` の baseline run と `'enforce'` (+ table ready)
     * の run で呼び出し回数が完全に一致することを比較する。
     *
     * 比較方式を使う理由: `loadVixDecision` が `^VIX` を実 fetch するため
     * (既存挙動)、tick 中の fetch 回数は 0 にはならない。baseline との
     * **差分がゼロ**であることが「news shock gate は fetch を足していない」
     * ことの正しい証拠になる。
     */
    it('adds zero external fetch calls when the news shock gate evaluates (enforce mode)', async () => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('network disabled in test')
      })
      const originalFetch = globalThis.fetch
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      const warnSpy2 = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        // baseline: news_shock_mode='off' (default fixture)。
        vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
        await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
          requestId: 'req-news-baseline',
        })
        const baselineCalls = fetchSpy.mock.calls.length
        expect(baselineCalls).toBeGreaterThan(0) // sanity: VIX fetch は実際に起きている

        fetchSpy.mockClear()

        // news shock gate 有効化 + attention_observation ready。
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

    // CodeRabbit PR #619 review (Major): `news_shock_baseline_days` に DB 上の
    // 設定ミス (NaN / 非数) が入ると、sanitize 前の値で `sinceIso` を
    // 計算していた旧コードは `new Date(NaN).toISOString()` の RangeError を
    // 素通しし、strategy tick 全体 (`runStrategyCron`) を落としていた。
    // これはその回帰ガード: この描画専用 fixture (`makeGlobalConfigSnapshot`)
    // は `loadGlobalConfigFrom` を直接 mock しているため、
    // `globalConfigRepo.validateNewsShockConfig` の DB 側 sanitize を経由
    // しない — `loadNewsShockDecision` 自身の防御 (指摘1 対応) が単独で
    // 効くことを確認する。
    it('completes without throwing when newsShockBaselineDays is NaN (misconfigured DB value)', async () => {
      vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
        makeGlobalConfigSnapshot({ newsShockMode: 'enforce', newsShockBaselineDays: Number.NaN }),
      )
      const result = await runStrategyCron(envWithHealthyPortfolio(fakeDbWithAttentionReady()), {
        requestId: 'req-news-nan-baseline',
      })
      // 完走していること自体が主張。加えて cron tick が正常な analysis を
      // 返していることも確認する (無言で壊れた結果を返していないか)。
      expect(result.summary).toBeDefined()
      expect(result.analysis.schema).toBe('strategy_cron_analysis.v1')
    })
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
      expect(result.entryHaltReason).toBe('portfolio_halted: getPortfolio threw: DO unreachable')
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

  // #session-window-gate: 開場30分前〜引けの窓外は戦略評価を skip する。
  // 市場ごと判定 (USD→US / JPY→JP)。flag off は従来挙動。
  describe('session window gate', () => {
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
      // default config は sessionWindowGateEnabled=false。窓外でも gate を通り、
      // PORTFOLIO_STATE 未 bind の exit-only halt まで進む (= gate で止まっていない)。
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
      // gate 通過 → 後段 (PORTFOLIO_STATE 未 bind) で portfolio_halted。
      expect(result.skipReason).not.toBe('outside_session_window')
      // #exit-only-halt: gate 通過の証拠は「run 全体を skip していない」+ 後段の
      // exit-only halt に到達していること。
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
      // #exit-only-halt: gate 通過の証拠は「run 全体を skip していない」+ 後段の
      // exit-only halt に到達していること。
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })

    // 2026-07-03 は Independence Day 振替休場 (7/4=土)。13:00 ET は通常なら窓内の
    // 時刻だが、休場日は market_holiday として skip する (#547 — 実際にこの日
    // stale quote の spread SKIP が量産され、reason から休場と読めなかった)。
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
      // #exit-only-halt: gate 通過の証拠は「run 全体を skip していない」+ 後段の
      // exit-only halt に到達していること。
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })

    it('休場と窓外が混在する場合は outside_session_window に倒す', async () => {
      vi.useFakeTimers()
      // US = 祝日 / JP = 土曜 02:00 JST (窓外)。全 market skip だが「全休場」では
      // ないので従来ラベル。
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
      // #exit-only-halt: gate 通過の証拠は「run 全体を skip していない」+ 後段の
      // exit-only halt に到達していること。
      expect(result.entryHaltReason).toBe('portfolio_halted: PORTFOLIO_STATE binding missing')
    })
  })

  // #p0-path-fixes 1: 寄り前に決定した BUY は MARKET 注文として寄り値と乖離した
  // 価格で約定し得る (実例: SOXS 9/4 寄り前 51.60 判断 → 寄り 49.53 約定)。
  // sessionWindowGateEnabled の値に関わらず、レギュラーセッション外の BUY は
  // 常に抑止する (exit は対象外)。
  describe('regular session BUY gate (#p0-path-fixes 1)', () => {
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
      // default config: sessionWindowGateEnabled=false
      await runStrategyCron(envHealthyPortfolio())
      const suppressed = lastSchedulerOptions().entrySuppressedSymbols ?? {}
      expect(suppressed.SOXL).toBe(SESSION_REASON)
      expect(suppressed.SOXS).toBe(SESSION_REASON)
    })
  })

  // #452 follow-up: cash rebalance pass 2 は pass 1 と同じ挙動制約 (earnings /
  // macro / sanity-failed cooldown / intraday-only close) を受けないと、通常
  // BUY が止まる局面でも退避先へ買い戻す抜け道になる。
  describe('cash rebalance pass 2 shares pass 1 behavioral gates (#452 follow-up)', () => {
    // 2026-04-20 (月) は JP 取引日。09:00-15:30 JST がレギュラーセッション
    // (#p0-path-fixes 1: pass 2 は通貨単位でセッション外を弾く)。
    const JP_IN_SESSION = '2026-04-20T02:00:00.000Z' // 11:00 JST
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

    /** pass 2 テスト共通の universe/config: JPY-only (fx=1) + SOXL→SGOV cash fallback。 */
    function setUpCashFallbackFixture(): void {
      // JPY-only universe (fx=1) を使い、usdJpyRate 取得を経路から外す。SOXL は
      // entry_required だが WATCH/NG 想定 (pass 1 の mocked entrySnapshots) →
      // cash_fallback 先 SGOV へ退避し、pass 2 の BUY 計画が立つ。
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
      // pass 2 が実際に cash rebalance 経路を通ったことの前提確認。
      expect(pass2Options.cashRebalanceQuantityMap).toBeDefined()

      for (const key of [
        'intradayOnlySymbols',
        'sanityFailedCooldown',
        'earningsGate',
        'macroEventGate',
      ] as const) {
        expect(pass1Options[key]).toBeDefined()
        expect(pass2Options[key]).toBeDefined()
      }
    })

    // #p0-path-fixes 1: pass 2 は entrySuppressedSymbols を渡さない唯一の BUY
    // 経路なので、通貨単位でレギュラーセッション外を弾かないと開場前の退避
    // BUY がそのまま素通りしてしまう。
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
