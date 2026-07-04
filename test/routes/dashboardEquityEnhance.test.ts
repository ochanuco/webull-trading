import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { makeGlobalConfigSnapshot } from '../helpers/configFixtures'
import {
  type EquityPoint,
  buildOverviewChartData,
  computeMonthlyReturns,
  computePeriodReturns,
  toBenchmarkReturns,
} from '../../src/routes/dashboard'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))

// overview タブの QQQ ベンチマークは Yahoo fetch (network 依存)。テストでは
// 常に失敗させて「series 省略 + 注記のみ」の fail-graceful 経路を検証する。
vi.mock('../../src/infrastructure/quotes/YahooBarClient', () => ({
  YahooBarClient: class {
    async getDailyBars(): Promise<never> {
      throw new Error('yahoo down (mocked)')
    }
    async getIntradayBars(): Promise<never> {
      throw new Error('yahoo down (mocked)')
    }
  },
  toYahooSymbol: (s: string) => s,
}))

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

function pt(date: string, dailyPnl: number, cumulativePnl: number, drawdownPct = 0): EquityPoint {
  return { date, dailyPnl, cumulativePnl, drawdownPct }
}

describe('computePeriodReturns', () => {
  // 2026-07-03 09:00 JST (UTC 00:00)。JST 日 = 2026-07-03。
  const now = new Date('2026-07-03T00:00:00Z')
  const points = [
    pt('2026-01-05', 10, 10),
    pt('2026-03-01', 5, 15),
    pt('2026-06-10', -3, 12),
    pt('2026-07-01', 8, 20),
  ]

  it('1W/1M/3M/YTD/ALL の PnL 変化額を「期間開始日前の最後の累積値」基準で返す', () => {
    const out = computePeriodReturns(points, now)
    expect(out.map((r) => r.key)).toEqual(['1W', '1M', '3M', 'YTD', 'ALL'])
    const byKey = Object.fromEntries(out.map((r) => [r.key, r.change]))
    // 1W: 開始 2026-06-26 → 基準 12 (06-10) → 20 - 12 = 8
    expect(byKey['1W']).toBeCloseTo(8)
    // 1M: 開始 2026-06-03 → 基準 15 (03-01) → 5
    expect(byKey['1M']).toBeCloseTo(5)
    // 3M: 開始 2026-04-04 → 基準 15 → 5
    expect(byKey['3M']).toBeCloseTo(5)
    // YTD: 開始 2026-01-01 → 期間前 point 無し → 基準 0 → 20
    expect(byKey['YTD']).toBeCloseTo(20)
    expect(byKey['ALL']).toBeCloseTo(20)
  })

  it('ラベルは日本語 (UI 表示用)', () => {
    const out = computePeriodReturns(points, now)
    expect(out.map((r) => r.label)).toEqual(['1週間', '1か月', '3か月', '年初来', '全期間'])
  })

  it('JST 日付で期間境界を切る (UTC 15:00 = JST 翌日 00:00)', () => {
    // UTC 2026-07-02 16:00 = JST 2026-07-03 01:00 → 1W 開始は 2026-06-26
    const jstNext = computePeriodReturns(points, new Date('2026-07-02T16:00:00Z'))
    // UTC 2026-07-02 14:00 = JST 2026-07-02 23:00 → 1W 開始は 2026-06-25
    const jstSame = computePeriodReturns(points, new Date('2026-07-02T14:00:00Z'))
    // どちらも 06-10 の point より後なので値は同じだが、YTD の年判定が
    // JST 基準で計算されていることを年跨ぎで確認する。
    expect(jstNext[3]!.change).toBeCloseTo(20)
    expect(jstSame[3]!.change).toBeCloseTo(20)
    // UTC 2025-12-31 16:00 = JST 2026-01-01 01:00 → YTD は 2026-01-01 開始
    const out = computePeriodReturns([pt('2025-12-20', 7, 7), pt('2026-01-05', 3, 10)], new Date('2025-12-31T16:00:00Z'))
    const ytd = out.find((r) => r.key === 'YTD')!
    expect(ytd.change).toBeCloseTo(3) // 基準 = 2025-12-20 の累積 7
  })

  it('points 空なら空配列', () => {
    expect(computePeriodReturns([], now)).toEqual([])
  })
})

describe('computeMonthlyReturns', () => {
  it('JST 月ごとに dailyPnl を合算して昇順で返す', () => {
    const out = computeMonthlyReturns([
      pt('2026-05-02', 3, 3),
      pt('2026-05-20', -1, 2),
      pt('2026-06-01', 4, 6),
      pt('2026-04-30', 10, 10),
    ])
    expect(out).toEqual([
      { month: '2026-04', pnl: 10 },
      { month: '2026-05', pnl: 2 },
      { month: '2026-06', pnl: 4 },
    ])
  })

  it('points 空なら空配列', () => {
    expect(computeMonthlyReturns([])).toEqual([])
  })
})

describe('toBenchmarkReturns', () => {
  const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close })

  it('先頭 close を 0% 基準にした騰落率 % 系列に変換する', () => {
    const out = toBenchmarkReturns([bar('2026-01-01', 100), bar('2026-01-02', 110), bar('2026-01-03', 95)])
    expect(out.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
    expect(out[0]!.returnPct).toBeCloseTo(0)
    expect(out[1]!.returnPct).toBeCloseTo(10)
    expect(out[2]!.returnPct).toBeCloseTo(-5)
  })

  it('不正 close (<= 0 / 非有限) を除外し、残りの先頭を基準にする', () => {
    const out = toBenchmarkReturns([bar('2026-01-01', 0), bar('2026-01-02', 200), bar('2026-01-03', 210)])
    expect(out.map((p) => p.date)).toEqual(['2026-01-02', '2026-01-03'])
    expect(out[0]!.returnPct).toBeCloseTo(0)
    expect(out[1]!.returnPct).toBeCloseTo(5)
  })

  it('日付順が乱れていても昇順に整えてから変換する', () => {
    const out = toBenchmarkReturns([bar('2026-01-03', 120), bar('2026-01-01', 100)])
    expect(out[0]).toEqual({ date: '2026-01-01', returnPct: 0 })
    expect(out[1]!.returnPct).toBeCloseTo(20)
  })

  it('bars 空なら空配列', () => {
    expect(toBenchmarkReturns([])).toEqual([])
  })
})

describe('buildOverviewChartData', () => {
  const equity = [pt('2026-06-10', 5, 5), pt('2026-06-20', 3, 8, -0.1)]
  const marker = (date: string, side: 'BUY' | 'SELL') => ({
    timestamp: `${date}T14:30:00Z`,
    date,
    symbol: 'SOXL',
    side,
    filledPrice: 30,
    filledQty: 3,
    realizedPnl: side === 'SELL' ? 5 : null,
    clientOrderId: 'oid-1',
  })

  it('軸は equity 日付 ∪ マーカー日付、マーカー日は直前の累積で forward-fill', () => {
    const vm = buildOverviewChartData(equity, [marker('2026-06-05', 'BUY'), marker('2026-06-15', 'BUY')], null)
    expect(vm.dates).toEqual(['2026-06-05', '2026-06-10', '2026-06-15', '2026-06-20'])
    // 最初の equity point 前は累積 0、06-15 は直前 (06-10) の 5 を引き継ぐ
    expect(vm.equity).toEqual([0, 5, 5, 8])
    expect(vm.drawdownPct[3]).toBeCloseTo(-10)
    expect(vm.markers.map((m) => m.y)).toEqual([0, 5])
    expect(vm.benchmark).toBeNull()
  })

  it('benchmark は日付キーで forward-fill、データ開始前は null', () => {
    const vm = buildOverviewChartData(equity, [marker('2026-06-05', 'BUY')], [
      { date: '2026-06-09', returnPct: 0 },
      { date: '2026-06-16', returnPct: 2.5 },
    ])
    // 06-05 は benchmark 開始前 → null、06-10 は 06-09 の 0、06-20 は 06-16 の 2.5
    expect(vm.benchmark).toEqual([null, 0, 2.5])
  })
})

// --- overview タブ SSR スモーク (fake D1 + Yahoo 失敗 mock) ---

function fakeOverviewDb(opts: {
  equityRows?: Array<{ day: string; daily_pnl: number }>
  fillRows?: Array<Record<string, unknown>>
}): D1Database {
  return {
    prepare: (sql: string) => ({
      all: async () => {
        if (sql.includes('SUM(realized_pnl)')) return { results: opts.equityRows ?? [] }
        if (sql.includes("trade_event_type = 'post_submit'")) return { results: opts.fillRows ?? [] }
        return { results: [] }
      },
      bind: () => ({ all: async () => ({ results: [] }) }),
    }),
  } as unknown as D1Database
}

describe('GET /dashboard/charts?tab=overview (equity enhance SSR)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('マーカー + 期間別テーブル + 月次チャートを描画し、Yahoo 失敗時はベンチマーク注記のみ', async () => {
    const env = {
      ...baseEnv,
      DB: fakeOverviewDb({
        equityRows: [
          { day: '2026-06-10', daily_pnl: 5 },
          { day: '2026-06-20', daily_pnl: 3 },
        ],
        fillRows: [
          {
            timestamp: '2026-06-09T14:30:00Z',
            symbol: 'SOXL',
            pre_side: 'BUY',
            filled_price: 28.5,
            filled_qty: 3,
            realized_pnl: null,
            client_order_id: 'oid-buy-1',
          },
          {
            timestamp: '2026-06-20T14:30:00Z',
            symbol: 'SOXL',
            pre_side: 'SELL',
            filled_price: 30.5,
            filled_qty: 3,
            realized_pnl: 6,
            client_order_id: 'oid-sell-1',
          },
        ],
      }),
    }
    const app = createApp()
    const res = await app.request('/dashboard/charts?tab=overview', {}, env as never)
    expect(res.status).toBe(200)
    const body = await res.text()
    // チャート枠 + 期間別テーブル + 月次チャート
    expect(body).toContain('id="equity-chart"')
    expect(body).toContain('id="dd-chart"')
    expect(body).toContain('期間別リターン')
    expect(body).toContain('id="monthly-chart"')
    expect(body).toContain('1週間')
    expect(body).toContain('年初来')
    // Yahoo mock 失敗 → ベンチマーク series 無し、注記のみ (fail-graceful)
    expect(body).toContain('取得失敗のため非表示')
    expect(body).not.toContain('QQQ 騰落率 (% 右軸) — 意味の異なる系列')
    // マーカー payload (safeJsonScript) に fill が乗っている
    expect(body).toContain('oid-sell-1')
    expect(body).toContain('"markers"')
    // クリック遷移先 (実装済みの trades フィルタ)
    expect(body).toContain('/dashboard/trades?clientOrderId=')
  })

  it('全 inline script が構文エラーなく parse できる (#462 回帰ガード)', async () => {
    const env = {
      ...baseEnv,
      DB: fakeOverviewDb({
        equityRows: [{ day: '2026-06-10', daily_pnl: 5 }],
        fillRows: [
          {
            timestamp: '2026-06-10T14:30:00Z',
            symbol: 'SOXL',
            pre_side: 'SELL',
            filled_price: 30.5,
            filled_qty: 3,
            realized_pnl: 5,
            client_order_id: 'oid-1',
          },
        ],
      }),
    }
    const app = createApp()
    const res = await app.request('/dashboard/charts?tab=overview', {}, env as never)
    expect(res.status).toBe(200)
    const body = await res.text()
    const blocks = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(blocks.length).toBeGreaterThan(0)
    for (const code of blocks) {
      // 構文エラーなら new Function が SyntaxError を throw する (実行はしない)。
      expect(() => new Function(code)).not.toThrow()
    }
  })

  it('実 fill が無ければ従来どおり案内メッセージのみ (Yahoo fetch もしない)', async () => {
    const env = { ...baseEnv, DB: fakeOverviewDb({}) }
    const app = createApp()
    const res = await app.request('/dashboard/charts?tab=overview', {}, env as never)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('まだ実 fill (realized_pnl) が無いため')
    expect(body).not.toContain('id="equity-chart"')
  })
})
