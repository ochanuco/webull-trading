import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import { resolvePortfolioForRiskScale, runStrategyCron } from '../../../src/trading/strategy/runStrategyCron'
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
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse())
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('skips with trading_disabled when tradingEnabled=false', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: false }),
    )
    const result = await runStrategyCron(env)
    expect(result.skipReason).toBe('trading_disabled')
    expect(result.summary.evaluated).toBe(0)
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
