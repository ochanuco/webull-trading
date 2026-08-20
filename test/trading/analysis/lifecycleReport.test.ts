import { describe, expect, it } from 'vitest'
import type { Env } from '../../../src/config/env'
import type { DailyBar } from '../../../src/trading/strategy/indicators'
import {
  loadLifecycleReport,
  type LifecycleBarClient,
} from '../../../src/trading/analysis/lifecycleReport'

/**
 * D1 の prepare(sql) を SQL 文字列で dispatch する fake。
 * `test/routes/dashboardChartMarkers.test.ts` の `fakeChartDb` と同じ流儀。
 */
function fakeDb(tables: {
  fills?: unknown[]
  sellReasons?: unknown[]
  skips?: unknown[]
  avgEquity?: { avg_equity: number | null } | null
  extendedHours?: unknown[]
}): D1Database {
  return {
    prepare(sql: string) {
      if (sql.includes('FROM trade_journal AS ps')) {
        return { all: async () => ({ results: tables.fills ?? [] }) }
      }
      if (sql.includes("decision = 'SELL'")) {
        return { all: async () => ({ results: tables.sellReasons ?? [] }) }
      }
      if (sql.includes("decision = 'SKIP'")) {
        return { all: async () => ({ results: tables.skips ?? [] }) }
      }
      if (sql.includes('portfolio_equity_snapshot')) {
        return { first: async () => tables.avgEquity ?? null }
      }
      if (sql.includes('extended_hours_observation')) {
        return { all: async () => ({ results: tables.extendedHours ?? [] }) }
      }
      throw new Error(`fakeDb: unexpected SQL: ${sql}`)
    },
  } as unknown as D1Database
}

const NOW = new Date('2026-06-20T00:00:00.000Z')

function makeBars(symbol: string): DailyBar[] {
  // 06-01 (entry 前 runup 用の warmup) 〜 06-20 まで平日想定の連番 close。
  const dates = [
    '2026-05-20',
    '2026-05-21',
    '2026-05-22',
    '2026-05-25',
    '2026-05-26',
    '2026-05-27',
    '2026-05-28',
    '2026-05-29',
    '2026-06-01',
    '2026-06-02',
    '2026-06-03',
    '2026-06-04',
    '2026-06-05',
    '2026-06-08',
    '2026-06-09',
    '2026-06-10',
  ]
  const base = symbol === 'SOXL' ? 100 : 50
  return dates.map((date, i) => ({
    date,
    open: base + i,
    high: base + i + 1,
    low: base + i - 1,
    close: base + i,
  }))
}

describe('loadLifecycleReport', () => {
  it('D1 + bar client の素材から一気通貫でレポートを組み立てる', async () => {
    const fills = [
      {
        timestamp: '2026-06-01T14:00:00.000Z',
        symbol: 'SOXL',
        pre_side: 'BUY',
        filled_price: 108,
        filled_qty: 1,
        realized_pnl: null,
        estimated_cost: null,
        client_order_id: 'buy-1',
      },
      {
        timestamp: '2026-06-05T14:00:00.000Z',
        symbol: 'SOXL',
        pre_side: 'SELL',
        filled_price: 112,
        filled_qty: 1,
        realized_pnl: 4,
        estimated_cost: 0.1,
        client_order_id: 'sell-1',
      },
    ]
    const sellReasons = [{ client_order_id: 'sell-1', reason: 'take-profit hit: pnl 0.04 >= 0.04' }]
    const skips = [
      { symbol: 'TQQQ', timestamp: '2026-06-02T13:05:00.000Z', reason: 'risk: vix_critical: 40' },
      { symbol: 'TQQQ', timestamp: '2026-06-02T13:20:00.000Z', reason: 'risk: vix_critical: 41' },
    ]
    const db = fakeDb({
      fills,
      sellReasons,
      skips,
      avgEquity: { avg_equity: 2000 },
      extendedHours: [],
    })
    const env = { DB: db } as unknown as Env
    const client: LifecycleBarClient = {
      async getDailyBars(symbol: string) {
        return makeBars(symbol)
      },
    }
    const report = await loadLifecycleReport(env, { client, now: () => NOW })

    expect(report.meta.roundTripCount).toBe(1)
    expect(report.meta.fillCount).toBe(2)
    expect(report.meta.skipSignalCount).toBe(1) // dedup 後 (同日連発は1件)
    expect(report.meta.barFetchFailedSymbols).toEqual([])

    expect(report.exitReasonStats).toEqual([
      { category: 'TP', count: 1, wins: 1, losses: 0, winRate: 1, avgWin: 4, avgLoss: 0, expectancy: 4 },
    ])

    const allForward = report.forwardReturns.find((r) => r.category === 'ALL')
    expect(allForward).toBeDefined()
    expect(allForward!.r1.n).toBe(1)

    expect(report.cost.totalEstimatedCostUsd).toBeCloseTo(0.1)
    expect(report.turnover.avgEquityUsd).toBe(2000)
    expect(report.turnover.buyNotionalUsd).toBe(108)
    expect(report.turnover.sellNotionalUsd).toBe(112)

    const skipAll = report.skipOutcomes.find((r) => r.category === 'ALL')
    expect(skipAll).toBeDefined()
    expect(skipAll!.mfe10.n).toBe(1)
  })

  it('Yahoo fetch 失敗 symbol はその symbol のフォワード系のみ null になる (throw しない)', async () => {
    const fills = [
      {
        timestamp: '2026-06-01T14:00:00.000Z',
        symbol: 'FAILSYM',
        pre_side: 'BUY',
        filled_price: 50,
        filled_qty: 1,
        realized_pnl: null,
        estimated_cost: null,
        client_order_id: 'buy-1',
      },
      {
        timestamp: '2026-06-05T14:00:00.000Z',
        symbol: 'FAILSYM',
        pre_side: 'SELL',
        filled_price: 45,
        filled_qty: 1,
        realized_pnl: -5,
        estimated_cost: null,
        client_order_id: 'sell-1',
      },
    ]
    const db = fakeDb({ fills, sellReasons: [], skips: [], avgEquity: null, extendedHours: [] })
    const env = { DB: db } as unknown as Env
    const client: LifecycleBarClient = {
      async getDailyBars() {
        throw new Error('yahoo unavailable')
      },
    }
    const report = await loadLifecycleReport(env, { client, now: () => NOW })

    expect(report.meta.barFetchFailedSymbols).toEqual(['FAILSYM'])
    expect(report.meta.roundTripCount).toBe(1)
    // reason が join できない (UNKNOWN) round trip の exitReasonStats は
    // realizedPnl があれば集計される (bar 取得失敗とは独立)。
    expect(report.exitReasonStats).toEqual([
      {
        category: 'UNKNOWN',
        count: 1,
        wins: 0,
        losses: 1,
        winRate: 0,
        avgWin: 0,
        avgLoss: -5,
        expectancy: -5,
      },
    ])
    const allForward = report.forwardReturns.find((r) => r.category === 'ALL')
    expect(allForward!.r1).toEqual({ n: 0, avg: null })
    expect(report.turnover.avgEquityUsd).toBeNull()
    expect(report.turnover.turnoverRatio).toBeNull()
  })

  it('DB binding が無ければ throw する', async () => {
    const env = {} as Env
    await expect(loadLifecycleReport(env)).rejects.toThrow('DB binding not available')
  })
})
