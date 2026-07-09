import { describe, expect, it, vi } from 'vitest'

// loadSymbolChart は Yahoo daily / intraday を fetch する。この test では
// 「D1 → marker / span 整形」だけを検証したいので、実 network を触らない
// stub class に差し替える (空配列 = Yahoo fetch 失敗時の fallback と同じ経路)。
vi.mock('../../src/infrastructure/quotes/YahooBarClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/infrastructure/quotes/YahooBarClient')>()
  return {
    ...actual,
    YahooBarClient: class {
      async getDailyBars() {
        return []
      }
      async getIntradayBars() {
        return []
      }
    },
  }
})

import {
  loadSymbolChart,
  pairClosedTrades,
  renderSymbolTab,
  type ChartsBodySymbol,
  type SymbolChartMarker,
  type SymbolChartRules,
} from '../../src/routes/dashboard'
import type { Env } from '../../src/config/env'

const buy = (ts: string, price: number, clientOrderId: string | null = null): SymbolChartMarker => ({
  timestamp: ts,
  side: 'BUY',
  price,
  qty: 1,
  realizedPnl: null,
  clientOrderId,
})
const sell = (
  ts: string,
  price: number,
  pnl: number | null,
  clientOrderId: string | null = null,
): SymbolChartMarker => ({
  timestamp: ts,
  side: 'SELL',
  price,
  qty: 1,
  realizedPnl: pnl,
  clientOrderId,
})

describe('pairClosedTrades (BUY→SELL closed pair の突合)', () => {
  it('空配列は空', () => {
    expect(pairClosedTrades([])).toEqual([])
  })

  it('BUY → SELL の 1 往復は 1 span (SELL の realizedPnl を採用)', () => {
    expect(pairClosedTrades([buy('2026-06-01', 100), sell('2026-06-05', 107, 7)])).toEqual([
      { openTimestamp: '2026-06-01', closeTimestamp: '2026-06-05', realizedPnl: 7 },
    ])
  })

  it('複数往復はそれぞれ独立した span になる', () => {
    const spans = pairClosedTrades([
      buy('2026-06-01', 100),
      sell('2026-06-05', 107, 7),
      buy('2026-06-10', 110),
      sell('2026-06-12', 105, -5),
    ])
    expect(spans).toEqual([
      { openTimestamp: '2026-06-01', closeTimestamp: '2026-06-05', realizedPnl: 7 },
      { openTimestamp: '2026-06-10', closeTimestamp: '2026-06-12', realizedPnl: -5 },
    ])
  })

  it('連続 BUY (部分約定 / position add) は最初の BUY を区間開始にする', () => {
    const spans = pairClosedTrades([
      buy('2026-06-01', 100),
      buy('2026-06-02', 98),
      sell('2026-06-05', 103, 4),
    ])
    expect(spans).toEqual([
      { openTimestamp: '2026-06-01', closeTimestamp: '2026-06-05', realizedPnl: 4 },
    ])
  })

  it('BUY 先行の無い SELL (手動売却の残骸) は区間にしない', () => {
    const spans = pairClosedTrades([
      sell('2026-06-01', 100, 3),
      buy('2026-06-02', 98),
      sell('2026-06-05', 95, -3),
    ])
    expect(spans).toEqual([
      { openTimestamp: '2026-06-02', closeTimestamp: '2026-06-05', realizedPnl: -3 },
    ])
  })

  it('末尾のオープン建玉 (BUY のみで未決済) は span に含めない', () => {
    const spans = pairClosedTrades([
      buy('2026-06-01', 100),
      sell('2026-06-05', 107, 7),
      buy('2026-06-10', 110),
    ])
    expect(spans).toHaveLength(1)
    expect(spans[0]!.closeTimestamp).toBe('2026-06-05')
  })

  it('SELL の realizedPnl 欠損 (旧 fill) は null のまま span に載る', () => {
    // 注: realizedPnl が null の SELL は resolveFillSide の推測経路では BUY
    // 扱いになるため、pre_submit の side が引けた行 (= side 明示) のみで発生。
    const spans = pairClosedTrades([buy('2026-06-01', 100), sell('2026-06-05', 107, null)])
    expect(spans).toEqual([
      { openTimestamp: '2026-06-01', closeTimestamp: '2026-06-05', realizedPnl: null },
    ])
  })
})

// D1 の prepare(sql) を SQL 文字列で dispatch する fake。loadSymbolChart は
// strategy_decision_log と trade_journal の 2 query を投げる。
function fakeChartDb(logRows: unknown[], fillRows: unknown[]): D1Database {
  return {
    prepare(sql: string) {
      const rows = sql.includes('strategy_decision_log') ? logRows : fillRows
      return {
        bind: () => ({ all: async () => ({ results: rows }) }),
      }
    },
  } as unknown as D1Database
}

const rules: SymbolChartRules = {
  pullbackMax: -0.03,
  pullbackMin: -0.15,
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
}

describe('loadSymbolChart — fill marker の clientOrderId / holdingSpans', () => {
  it('markers に client_order_id を載せ、closed pair から holdingSpans を組む', async () => {
    const db = fakeChartDb(
      [
        {
          id: 1,
          timestamp: '2026-06-01T14:00:00.000Z',
          price: 100,
          decision: 'HOLD',
          reason: null,
          indicators_json: null,
          trace_json: null,
        },
      ],
      [
        {
          timestamp: '2026-06-01T14:05:00.000Z',
          pre_side: 'BUY',
          filled_price: 100,
          filled_qty: 2,
          realized_pnl: null,
          client_order_id: 'ord-buy-1',
        },
        {
          timestamp: '2026-06-05T14:05:00.000Z',
          pre_side: 'SELL',
          filled_price: 107,
          filled_qty: 2,
          realized_pnl: 14,
          client_order_id: 'ord-sell-1',
        },
      ],
    )
    const env = { DB: db } as unknown as Env
    const chart = await loadSymbolChart(env, 'TQQQ', rules)
    expect(chart.markers).toHaveLength(2)
    expect(chart.markers[0]).toMatchObject({ side: 'BUY', clientOrderId: 'ord-buy-1' })
    expect(chart.markers[1]).toMatchObject({ side: 'SELL', clientOrderId: 'ord-sell-1', realizedPnl: 14 })
    expect(chart.holdingSpans).toEqual([
      {
        openTimestamp: '2026-06-01T14:05:00.000Z',
        closeTimestamp: '2026-06-05T14:05:00.000Z',
        realizedPnl: 14,
      },
    ])
  })

  it('client_order_id 欠損 (旧 fill) は null にフォールバック', async () => {
    const db = fakeChartDb(
      [],
      [
        {
          timestamp: '2026-06-01T14:05:00.000Z',
          pre_side: 'BUY',
          filled_price: 100,
          filled_qty: 1,
          realized_pnl: null,
          client_order_id: null,
        },
      ],
    )
    const env = { DB: db } as unknown as Env
    const chart = await loadSymbolChart(env, 'TQQQ', rules)
    expect(chart.markers[0]!.clientOrderId).toBeNull()
    // BUY のみ (未決済) → span なし
    expect(chart.holdingSpans).toEqual([])
  })
})

describe('renderSymbolTab — fill 詳細パネル + 保有区間 markArea の配線 (SSR smoke)', () => {
  const baseParams = {
    stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10,
    pullbackMax: -0.03, pullbackMin: -0.15, minReturn50d: 0,
    requireAboveSma50: true, kAtr: 2,
    maxSma50DeviationPct: 0.6, maxAtrRatio: 1.5,
    reentryMinAtrBelowLastExit: 1.0, reentryGuardBusinessDays: 3,
  }
  function args(): ChartsBodySymbol {
    return {
      tab: 'symbol',
      focusSymbol: 'TQQQ',
      symbolChart: {
        symbol: 'TQQQ',
        points: [
          { timestamp: '2026-06-01T14:00:00.000Z', price: 100, sma50: 90, high20d: 110, low20d: 85 },
          { timestamp: '2026-06-05T14:00:00.000Z', price: 107, sma50: 91, high20d: 110, low20d: 85 },
        ],
        markers: [
          buy('2026-06-01T14:05:00.000Z', 100, 'ord-buy-1'),
          sell('2026-06-05T14:05:00.000Z', 107, 14, 'ord-sell-1'),
        ],
        position: null,
        rules,
        trendLine: null,
        intradayBars: [],
        latestCronPrice: 107,
        latestCronTimestamp: '2026-06-05T14:00:00.000Z',
        holdingSpans: [
          {
            openTimestamp: '2026-06-01T14:05:00.000Z',
            closeTimestamp: '2026-06-05T14:05:00.000Z',
            realizedPnl: 14,
          },
        ],
      },
      availableSymbols: ['TQQQ'],
      strategyParams: baseParams,
      zoom: null,
    }
  }

  it('payload に clientOrderId / holdingSpans が埋まり、fill クリック配線が出る', () => {
    const html = renderSymbolTab(args())
    // marker payload に注文への逆リンク素材が乗る
    expect(html).toContain('"clientOrderId":"ord-buy-1"')
    expect(html).toContain('"clientOrderId":"ord-sell-1"')
    // markArea 用の閉区間データ
    expect(html).toContain('"holdingSpans":[{"openTimestamp":"2026-06-01T14:05:00.000Z"')
    // client 側の配線 (fill 詳細パネル + trades への逆リンク + markArea host)
    expect(html).toContain('showFillDetail')
    expect(html).toContain('/dashboard/trades?clientOrderId=')
    expect(html).toContain('保有区間 (確定)')
    expect(html).toContain('holdingAreaData')
  })

  it('inline script が構文エラーなく parse できる (#462 系 regression)', () => {
    const html = renderSymbolTab(args())
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(blocks.length).toBeGreaterThan(0)
    for (const code of blocks) {
      expect(() => new Function(code)).not.toThrow()
    }
  })
})
