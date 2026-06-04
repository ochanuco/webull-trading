import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from '../../src/app'
import type { DailyBar } from '../../src/trading/strategy/indicators'

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}

const unauthEnv = {}

const authHeader = {}

/**
 * Build a synthetic Yahoo-shaped chart payload from a list of DailyBar.
 * Mirrors the columnar response that `normalizeYahooChart` consumes so the
 * admin endpoint sees identical bars to what live YahooBarClient would
 * deliver.
 */
function buildYahooChart(bars: DailyBar[]): unknown {
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD', regularMarketPrice: bars.at(-1)?.close ?? 0 },
          timestamp: bars.map((b) => Math.floor(Date.parse(`${b.date}T00:00:00.000Z`) / 1000)),
          indicators: {
            quote: [
              {
                open: bars.map((b) => b.open),
                high: bars.map((b) => b.high),
                low: bars.map((b) => b.low),
                close: bars.map((b) => b.close),
              },
            ],
          },
        },
      ],
      error: null,
    },
  }
}

function buildBars(start: number, factors: number[], startDate = '2024-01-01'): DailyBar[] {
  const bars: DailyBar[] = []
  let close = start
  let date = new Date(`${startDate}T00:00:00.000Z`)
  for (let i = 0; i < factors.length; i += 1) {
    close = close * factors[i]!
    bars.push({
      date: date.toISOString().slice(0, 10),
      open: close * 0.999,
      high: close * 1.001,
      low: close * 0.998,
      close,
    })
    date = new Date(date.getTime() + 86_400_000)
  }
  return bars
}

/**
 * Stub `loadGlobalConfigFrom` so the route doesn't try to talk to a real D1
 * binding. Returns the canonical defaults verbatim.
 */
vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: async () => ({
    source: 'd1',
    dryRun: true,
    tradingEnabled: false,
    marketHoursCheck: false,
    maxOrderNotional: 100,
    maxOrderNotionalUsd: 2000,
    maxOrderNotionalJpy: 100000,
    totalCapitalUsd: null,
    totalCapitalJpy: null,
    maxPortfolioExposurePct: 0.6,
    drawdownKillThreshold: -0.02,
    staleQuoteMs: 15 * 60 * 1_000,
    gapRejectPct: 0.03,
    spreadLimitPctUs: 0.0025,
    spreadLimitPctJp: 0.006,
    pullbackDefaultStopPct: -0.04,
    pullbackDefaultTakeProfitPct: 0.07,
    pullbackDefaultTimeStopDays: 10,
    pullbackDefaultPullbackMax: -0.03,
    pullbackDefaultPullbackMin: -0.06,
    pullbackDefaultMinReturn50d: 0.08,
    pullbackDefaultRequireAboveSma50: true,
    pullbackDefaultKAtr: 2.0,
    riskBasePerTradePct: 0.004,
    riskDdHalfThreshold: -0.05,
    riskDdHaltThreshold: -0.10,
  }),
}))

describe('GET /admin/backtest', () => {
  let originalFetch: typeof fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('401s without Access JWT', async () => {
    const app = createApp()
    const res = await app.request('/admin/backtest?symbol=AAPL&from=2024-01-01&to=2024-06-30', {}, unauthEnv)
    expect(res.status).toBe(401)
  })

  it('400s when symbol is missing', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/backtest?from=2024-01-01&to=2024-06-30',
      { headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(400)
  })

  it('400s when from > to', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/backtest?symbol=AAPL&from=2024-12-31&to=2024-01-01',
      { headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(400)
  })

  it('400s when no Yahoo bars fall within the requested range', async () => {
    // Regression for the silent fallback bug: previously, when
    // `bars.findIndex(b => b.date >= from)` returned -1 (i.e. Yahoo had
    // nothing inside [from, to] — e.g. `from` is in the future / symbol
    // delisted) the route ran the backtest against the *entire* prior
    // history and returned 200. The endpoint must now reject with 400.
    const pastBars = buildBars(100, Array(80).fill(1.005), '2024-01-01')

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(buildYahooChart(pastBars)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch

    const app = createApp()
    const res = await app.request(
      '/admin/backtest?symbol=AAPL&from=2099-01-01&to=2099-12-31',
      { headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(400)
  })

  it('200s and returns BacktestResult shape on success', async () => {
    // Build an uptrend-then-pullback synthetic series long enough for SMA50.
    const warmup = buildBars(100, Array(80).fill(1.005), '2024-01-01')
    const last = warmup[warmup.length - 1]!.close
    const pullback: DailyBar = {
      date: '2024-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const tail = buildBars(pullback.close, [1.05, 1.05, 1.02, 1.02], '2024-04-02')
    const bars = [...warmup, pullback, ...tail]

    // Stub the global fetch so YahooBarClient returns our synthetic series.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(buildYahooChart(bars)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch

    const app = createApp()
    const res = await app.request(
      '/admin/backtest?symbol=AAPL&from=2024-04-01&to=2024-04-10&initialCash=10000',
      { headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.params).toBeDefined()
    expect(Array.isArray(body.trades)).toBe(true)
    expect(Array.isArray(body.equityCurve)).toBe(true)
    expect(typeof body.totalPnl).toBe('number')
    expect(typeof body.totalReturn).toBe('number')
    expect(typeof body.winRate).toBe('number')
    expect(typeof body.sharpeRatio).toBe('number')
    expect(typeof body.maxDrawdown).toBe('number')
  })
})
