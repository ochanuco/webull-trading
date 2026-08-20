import { describe, expect, it, vi } from 'vitest'
import { assessPreMarket, runExtendedHoursObservation } from '../../../src/trading/quotes/extendedHoursScheduler'
import type { PreMarketSeries } from '../../../src/infrastructure/quotes/YahooExtendedHoursClient'
import type { YahooExtendedHoursClient } from '../../../src/infrastructure/quotes/YahooExtendedHoursClient'
import type { Env } from '../../../src/config/env'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../../helpers/configFixtures'
import { fakeD1 } from '../../helpers/fakeD1'

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))

function fakeClient(
  handler: (symbol: string) => PreMarketSeries | null | Promise<PreMarketSeries | null>,
): YahooExtendedHoursClient {
  return { getPreMarketSeries: vi.fn(handler) } as unknown as YahooExtendedHoursClient
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    EXTENDED_HOURS_OBSERVATION_ENABLED: 'true',
    DB: fakeD1(),
    ...overrides,
  } as unknown as Env
}

// 2026-05-20 (Wed, US トレーディング日、非祝日) の NYSE open = 13:30 UTC (EDT)。
const OPEN_UTC = new Date('2026-05-20T13:30:00.000Z')
const IN_WINDOW_NOW = new Date(OPEN_UTC.getTime() - 30 * 60 * 1000) // open-30分
const AFTER_OPEN_NOW = new Date(OPEN_UTC.getTime() + 10 * 60 * 1000) // open+10分
const WEEKEND_NOW = new Date('2026-05-23T13:00:00.000Z') // Sat

describe('runExtendedHoursObservation — opt-in gate', () => {
  it('EXTENDED_HOURS_OBSERVATION_ENABLED 未設定なら fetch を呼ばず即 return する', async () => {
    const client = fakeClient(() => null)
    const env = makeEnv({ EXTENDED_HOURS_OBSERVATION_ENABLED: undefined })
    const summary = await runExtendedHoursObservation({ env, client, now: () => IN_WINDOW_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('extended_hours_observation_disabled')
    expect(client.getPreMarketSeries).not.toHaveBeenCalled()
  })

  it("EXTENDED_HOURS_OBSERVATION_ENABLED が 'false' でも無効", async () => {
    const client = fakeClient(() => null)
    const env = makeEnv({ EXTENDED_HOURS_OBSERVATION_ENABLED: 'false' })
    const summary = await runExtendedHoursObservation({ env, client, now: () => IN_WINDOW_NOW })
    expect(summary.ran).toBe(false)
    expect(client.getPreMarketSeries).not.toHaveBeenCalled()
  })

  it('env.DB が無ければ db_unavailable を返す', async () => {
    const client = fakeClient(() => null)
    const env = makeEnv({ DB: undefined })
    const summary = await runExtendedHoursObservation({ env, client, now: () => IN_WINDOW_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('db_unavailable')
  })
})

describe('runExtendedHoursObservation — premarket window gate', () => {
  it('開場 30 分前 (窓内) は稼働する', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolMarket: { SOXL: 'US' } }),
    )
    const client = fakeClient(() => null)
    const env = makeEnv()
    const summary = await runExtendedHoursObservation({ env, client, now: () => IN_WINDOW_NOW })
    expect(summary.ran).toBe(true)
    expect(client.getPreMarketSeries).toHaveBeenCalledWith('SOXL')
  })

  it('開場 10 分後 (通常セッション中) は skip する', async () => {
    const client = fakeClient(() => null)
    const env = makeEnv()
    const summary = await runExtendedHoursObservation({ env, client, now: () => AFTER_OPEN_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('outside_premarket_window')
    expect(client.getPreMarketSeries).not.toHaveBeenCalled()
  })

  it('土曜は skip する', async () => {
    const client = fakeClient(() => null)
    const env = makeEnv()
    const summary = await runExtendedHoursObservation({ env, client, now: () => WEEKEND_NOW })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('outside_premarket_window')
  })
})

describe('runExtendedHoursObservation — 銘柄単位の fail-safe', () => {
  it('client が throw しても scheduler は throw せず UNKNOWN 行を保存する', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolMarket: { SOXL: 'US' } }),
    )
    const client = fakeClient(() => {
      throw new Error('yahoo unavailable')
    })
    const env = makeEnv()
    const result = await runExtendedHoursObservation({ env, client, now: () => IN_WINDOW_NOW })
    expect(result.ran).toBe(true)
    expect(result.errors).toBe(1)
    expect(result.statuses.UNKNOWN).toBe(1)
    expect(result.persisted).toBe(1)
  })

  it('^ 始まりの index symbol と非 US 銘柄は対象から除外する', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL', '^VIX', '7203'],
        symbolMarket: { SOXL: 'US', '^VIX': 'US', '7203': 'JP' },
      }),
    )
    const client = fakeClient(() => null)
    const env = makeEnv()
    const summary = await runExtendedHoursObservation({ env, client, now: () => IN_WINDOW_NOW })
    expect(summary.symbols).toBe(1)
    expect(client.getPreMarketSeries).toHaveBeenCalledTimes(1)
    expect(client.getPreMarketSeries).toHaveBeenCalledWith('SOXL')
  })
})

describe('assessPreMarket — status 判定 (pure)', () => {
  const NOW = new Date('2026-05-20T13:00:00.000Z')

  function series(overrides: Partial<PreMarketSeries> = {}): PreMarketSeries {
    return {
      symbol: 'SOXL',
      prevClose: 100,
      bars: [{ at: '2026-05-20T12:59:00.000Z', close: 100, low: 99.5 }],
      fetchedAt: NOW.toISOString(),
      ...overrides,
    }
  }

  it('gap -4% は WARNING', () => {
    const result = assessPreMarket({
      series: series({ prevClose: 100, bars: [{ at: '2026-05-20T12:59:00.000Z', close: 96, low: 95 }] }),
      now: NOW,
    })
    expect(result.gapPct).toBeCloseTo(-4, 5)
    expect(result.status).toBe('WARNING')
  })

  it('toStopPct -1 (stop 到達) は STOP_AT_OPEN_CANDIDATE', () => {
    const result = assessPreMarket({
      series: series({
        prevClose: 100,
        bars: [{ at: '2026-05-20T12:59:00.000Z', close: 95, low: 94 }],
      }),
      now: NOW,
      position: { qty: 10, avgPrice: 100 },
      rule: {
        stopPct: -0.05,
        takeProfitPct: 0.07,
        timeStopDays: 10,
        pullbackMax: -0.03,
        pullbackMin: -0.06,
        minReturn50d: 0.08,
        requireAboveSma50: true,
        kAtr: 2,
        maxSma50DeviationPct: 0.6,
        maxAtrRatio: 1.5,
        reentryMinAtrBelowLastExit: 1,
        reentryGuardBusinessDays: 3,
        maxStopToTpRatio: 2,
      },
      atr20: 0,
    })
    // pnlPct = (95-100)/100*100 = -5%, effectiveStopPct = -5% (pct stop) → toStopPct = -5 - (-5) = 0 <= 0
    expect(result.toStopPct).toBeLessThanOrEqual(0)
    expect(result.status).toBe('STOP_AT_OPEN_CANDIDATE')
  })

  it('stale 25 分は UNKNOWN', () => {
    const result = assessPreMarket({
      series: series({ bars: [{ at: '2026-05-20T12:35:00.000Z', close: 100, low: 99 }] }),
      now: NOW,
    })
    expect(result.freshnessSec).toBeGreaterThan(1200)
    expect(result.status).toBe('UNKNOWN')
  })

  it('平常 (gap 小さく position なし) は NORMAL', () => {
    const result = assessPreMarket({
      series: series({ prevClose: 100, bars: [{ at: '2026-05-20T12:59:00.000Z', close: 100.5, low: 100 }] }),
      now: NOW,
    })
    expect(result.status).toBe('NORMAL')
  })

  it('series が null なら UNKNOWN', () => {
    const result = assessPreMarket({ series: null, now: NOW })
    expect(result.status).toBe('UNKNOWN')
    expect(result.preMarketLast).toBeNull()
  })

  it('bars が空なら UNKNOWN', () => {
    const result = assessPreMarket({ series: series({ bars: [] }), now: NOW })
    expect(result.status).toBe('UNKNOWN')
  })

  it('prevClose が null なら UNKNOWN', () => {
    const result = assessPreMarket({ series: series({ prevClose: null }), now: NOW })
    expect(result.status).toBe('UNKNOWN')
  })

  it('direction15mPct は基準 bar が最終 bar と同一なら null', () => {
    const result = assessPreMarket({
      series: series({ bars: [{ at: '2026-05-20T12:59:00.000Z', close: 100, low: 99.5 }] }),
      now: NOW,
    })
    expect(result.direction15mPct).toBeNull()
  })

  it('direction15mPct は 15 分以内で最も古い bar を基準に算出する', () => {
    const result = assessPreMarket({
      series: series({
        bars: [
          { at: '2026-05-20T12:44:00.000Z', close: 100, low: 99 }, // ちょうど15分前 (基準)
          { at: '2026-05-20T12:50:00.000Z', close: 102, low: 101 },
          { at: '2026-05-20T12:59:00.000Z', close: 104, low: 103 },
        ],
      }),
      now: NOW,
    })
    expect(result.direction15mPct).toBeCloseTo(4, 5) // (104-100)/100*100
  })
})
