import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

const baseEnv = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
}

const authHeader = { Authorization: `Basic ${btoa('admin:secret')}` }

function fakeSymbolStateNamespace(cooldownUntil: string | null = null) {
  const stub = {
    async getState(symbol: string) {
      return {
        symbol,
        position: { qty: 10, avgPrice: 100, openedAt: '2026-04-20T00:00:00.000Z' },
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil,
        settledCash: 0,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: { price: 105, asOf: '2026-04-23T00:00:00Z', fetchedAt: '2026-04-23T00:00:00Z', source: 'yahoo' },
        updatedAt: '2026-04-23T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

function fakePortfolioNamespace(portfolio: {
  dailyStartEquity: number
  dailyRealizedPnl: number
  tradingDisabledUntil: string | null
  updatedAt: string
}) {
  const stub = {
    async getPortfolio() {
      return portfolio
    },
  }
  return {
    idFromName: () => 'id',
    get: () => stub,
  } as unknown
}

function fakeCronDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
  }
  return {
    select: vi.fn(() => query),
  }
}

describe('dashboard', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }))
  })
  afterEach(() => vi.resetAllMocks())

  it('401s without basic auth', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', {}, baseEnv)
    expect(res.status).toBe(401)
  })

  it('serves the index landing page', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<title>ダッシュボード')
    expect(body).toContain('/dashboard/positions')
  })

  it('renders positions page with DO state', async () => {
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SOXL')
    expect(body).toContain('100.00')
    expect(body).toContain('5.00%')
  })

  it('renders positions with "unavailable" when SYMBOL_STATE is missing', async () => {
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })

  it('past cooldownUntil (epoch 0 from admin clear-cooldown) is shown as em-dash, not 1970', async () => {
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace('1970-01-01T00:00:00.000Z'),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).not.toContain('1970-01-01')
  })

  it('future cooldownUntil is shown in JST', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace(future),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).toMatch(/<span class="warn">[^<]*JST<\/span>/)
  })

  it('renders portfolio page', async () => {
    const env = {
      ...baseEnv,
      PORTFOLIO_STATE: fakePortfolioNamespace({
        dailyStartEquity: 10_000,
        dailyRealizedPnl: -150,
        tradingDisabledUntil: null,
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('dailyStartEquity')
    expect(body).toContain('-1.50%')
    // 2026-04-23T00:00:00Z → 2026-04-23 09:00:00 JST
    expect(body).toContain('2026-04-23 09:00:00 JST')
  })

  it('renders config page with global_config + symbol table', async () => {
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('global_config')
    expect(body).toContain('SOXL')
  })

  it('escapes potentially-unsafe symbol names on config page', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['<script>'],
        symbolCurrency: { '<script>': 'USD' },
      }),
    )
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).not.toContain('<script>')
    expect(body).toContain('&lt;script&gt;')
  })

  it('renders cron page with "unavailable" when DB is not bound', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/cron', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })

  it('renders cron reason as clickable details', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeCronDb([
        {
          id: 123,
          timestamp: '2026-04-23T00:00:00.000Z',
          requestId: 'req-1',
          symbol: '7203',
          decision: 'REJECT',
          reason: 'sizing rejected: lot-size-round (raw qty 79 < lot 100, stop 286.00, entry 3765)',
          price: 3765,
          indicatorsJson: '{"price":3765,"return50d":0.45873692367299496}',
          clientOrderId: null,
          filledPrice: null,
          filledQty: null,
          realizedPnl: null,
          brokerStatus: null,
        },
      ]) as unknown as ReturnType<typeof createDb>,
    )
    const app = createApp()
    const res = await app.request('/dashboard/cron', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()

    expect(body).toContain('<details class="reason-details">')
    expect(body).toContain('発注スキップ: 売買単位未満')
    expect(body).toContain('計算上は 79 株まで建てられるが、必要な売買単位 100 株に届かないため発注しません。')
    expect(body).toContain('<strong>RUNID</strong>')
    expect(body).toContain('<code>req-1</code>')
    expect(body).toContain('<strong>raw reason</strong>')
    expect(body).toContain('<strong>JSON</strong>')
    expect(body).toContain('&quot;id&quot;: 123')
    expect(body).toContain('&quot;indicators&quot;: {')
    expect(body).toContain('&quot;return50d&quot;: 0.45873692367299496')
    expect(body).not.toContain('/dashboard/cron/json?decisionId=123')
    expect(body).not.toContain('run全体JSON')
  })

  it('exports a single cron decision JSON by decisionId', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeCronDb([
        {
          id: 868,
          timestamp: '2026-04-23T00:00:00.000Z',
          requestId: 'req-1',
          symbol: '7203',
          decision: 'REJECT',
          reason: 'sizing rejected: lot-size-round (raw qty 79 < lot 100, stop 286.00, entry 3765)',
          price: 3765,
          indicatorsJson: '{"price":3765}',
          clientOrderId: null,
          filledPrice: null,
          filledQty: null,
          realizedPnl: null,
          brokerStatus: null,
        },
      ]) as unknown as ReturnType<typeof createDb>,
    )
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron/json?decisionId=868',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      decisionId: 868,
      rowCount: 1,
      decisions: [{ id: 868, symbol: '7203' }],
    })
  })

  it('rejects non-whole cron decisionId values', async () => {
    const app = createApp()

    for (const decisionId of ['123abc', '1.5', '0', '-1', '9007199254740992']) {
      const res = await app.request(
        `/dashboard/cron/json?decisionId=${encodeURIComponent(decisionId)}`,
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body).toEqual({
        error: 'invalid_decision_id',
        message: 'decisionId must be a positive integer',
      })
    }
  })

  it('cron page requires basic auth', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/cron', {}, baseEnv)
    expect(res.status).toBe(401)
  })
})

import { formatQuoteAsOf } from '../../src/routes/dashboard'

describe('formatQuoteAsOf', () => {
  it('US 金曜引け 16:00 ET → JST 翌 05:00', () => {
    // 2026-04-24 20:00 UTC = 2026-04-25 05:00 JST (DST 中: ET = UTC-4)
    expect(formatQuoteAsOf('2026-04-24T20:00:00.000Z')).toBe('04/25 05:00 JST')
  })
  it('JP 金曜引け 15:00 JST', () => {
    // 2026-04-24 06:00 UTC = 2026-04-24 15:00 JST
    expect(formatQuoteAsOf('2026-04-24T06:00:00.000Z')).toBe('04/24 15:00 JST')
  })
  it('zero-pads month / day / hour', () => {
    expect(formatQuoteAsOf('2026-01-05T00:00:00.000Z')).toBe('01/05 09:00 JST')
  })
  it('invalid → "?"', () => {
    expect(formatQuoteAsOf('not-an-iso')).toBe('?')
  })
})

import { pickFreshQuote } from '../../src/routes/dashboard'

describe('pickFreshQuote', () => {
  const webullOld = { price: 105.64, source: 'webull-snapshot', asOf: '2026-04-23T02:50:00.000Z' }
  const yahooNew = { price: 128.32, asOf: '2026-04-25T03:00:00.000Z' }

  it('Webull が新しいときは Webull を採用', () => {
    const w = { price: 100, source: 'webull-snapshot', asOf: '2026-04-25T05:00:00.000Z' }
    const y = { price: 99, asOf: '2026-04-25T03:00:00.000Z' }
    expect(pickFreshQuote(w, y)).toEqual(w)
  })

  it('Yahoo が新しいときは Yahoo を採用 (bridge 障害シナリオ)', () => {
    const result = pickFreshQuote(webullOld, yahooNew)
    expect(result).toEqual({ price: 128.32, source: 'yahoo-bars', asOf: yahooNew.asOf })
  })

  it('Webull のみの場合は Webull', () => {
    expect(pickFreshQuote(webullOld, null)).toEqual({
      price: 105.64,
      source: 'webull-snapshot',
      asOf: '2026-04-23T02:50:00.000Z',
    })
  })

  it('Yahoo のみの場合は Yahoo', () => {
    expect(pickFreshQuote(null, yahooNew)).toEqual({
      price: 128.32,
      source: 'yahoo-bars',
      asOf: yahooNew.asOf,
    })
  })

  it('両方 null は null', () => {
    expect(pickFreshQuote(null, null)).toBe(null)
  })

  it('asOf 同値なら Webull (intraday の方が信頼性が高い前提)', () => {
    const w = { price: 100, source: 'webull-snapshot', asOf: '2026-04-25T03:00:00.000Z' }
    const y = { price: 99, asOf: '2026-04-25T03:00:00.000Z' }
    expect(pickFreshQuote(w, y)).toEqual(w)
  })

  it('Webull の asOf が不正なら Yahoo を採用', () => {
    const w = { price: 100, source: 'webull-snapshot', asOf: 'not-an-iso' }
    const y = { price: 128.32, asOf: '2026-04-25T03:00:00.000Z' }
    expect(pickFreshQuote(w, y)).toEqual({
      price: 128.32,
      source: 'yahoo-bars',
      asOf: y.asOf,
    })
  })

  it('Yahoo の asOf が不正なら Webull を採用', () => {
    const w = { price: 105.64, source: 'webull-snapshot', asOf: '2026-04-25T03:00:00.000Z' }
    const y = { price: 99, asOf: 'not-an-iso' }
    expect(pickFreshQuote(w, y)).toEqual(w)
  })

  it('両方不正でも crash せず Webull にタイブレーク', () => {
    const w = { price: 100, source: 'webull-snapshot', asOf: 'bad-w' }
    const y = { price: 99, asOf: 'bad-y' }
    expect(pickFreshQuote(w, y)).toEqual(w)
  })
})

import { computeEquitySeries, safeJsonScript } from '../../src/routes/dashboard'

describe('computeEquitySeries', () => {
  it('累積 PnL を順に積み上げる', () => {
    const out = computeEquitySeries([
      { date: '2026-04-20', dailyPnl: 10 },
      { date: '2026-04-21', dailyPnl: -3 },
      { date: '2026-04-22', dailyPnl: 5 },
    ])
    expect(out.map((p) => p.cumulativePnl)).toEqual([10, 7, 12])
  })

  it('drawdown は peak からの下落率', () => {
    const out = computeEquitySeries([
      { date: '2026-04-20', dailyPnl: 100 }, // peak=100
      { date: '2026-04-21', dailyPnl: -25 }, // cum=75, dd=-25%
      { date: '2026-04-22', dailyPnl: 50 }, // cum=125 = new peak, dd=0
    ])
    expect(out[1]!.drawdownPct).toBeCloseTo(-0.25)
    expect(out[2]!.drawdownPct).toBe(0)
  })

  it('peak が 0 以下の間は drawdown=0 (% 計算が無意味なため)', () => {
    const out = computeEquitySeries([
      { date: '2026-04-20', dailyPnl: -10 },
      { date: '2026-04-21', dailyPnl: -5 },
    ])
    expect(out.every((p) => p.drawdownPct === 0)).toBe(true)
  })

  it('空配列は空配列', () => {
    expect(computeEquitySeries([])).toEqual([])
  })
})

describe('safeJsonScript', () => {
  it('通常データを <script> でラップ', () => {
    const html = safeJsonScript('__d', { a: 1 })
    expect(html).toBe('<script>window.__d = {"a":1};</script>')
  })

  it('</script> 攻撃を遮断 (`<` のみ escape で十分、`>` は無害)', () => {
    const html = safeJsonScript('__d', { evil: '</script><img src=x>' })
    // データ内の </script> が早期 script 終端として解釈されない
    // (ラッパー側の `</script>` は末尾の 1 個だけ残る)
    expect(html.match(/<\/script>/g)?.length).toBe(1)
    expect(html).toContain('\\u003c/script>\\u003cimg src=x>')
  })

  it('単独の "<" も escape (HTML タグ解釈を抑止)', () => {
    const html = safeJsonScript('__d', { html: '<a>' })
    expect(html).toContain('\\u003ca>')
    // <a> という HTML タグとして混入しない
    expect(html.match(/<a>/g)).toBeNull()
  })
})

import { aggregateDecisionRows, computeTradeStats, computePnlHistogram, extractSma50 } from '../../src/routes/dashboard'

describe('aggregateDecisionRows', () => {
  it('日付ごとに decision を集計', () => {
    const out = aggregateDecisionRows([
      { day: '2026-04-23', decision: 'BUY', n: 1 },
      { day: '2026-04-23', decision: 'HOLD', n: 5 },
      { day: '2026-04-23', decision: 'REJECT', n: 2 },
      { day: '2026-04-24', decision: 'HOLD', n: 8 },
      { day: '2026-04-24', decision: 'SELL', n: 1 },
    ])
    expect(out).toEqual([
      { date: '2026-04-23', counts: { BUY: 1, SELL: 0, HOLD: 5, REJECT: 2, ERROR: 0 } },
      { date: '2026-04-24', counts: { BUY: 0, SELL: 1, HOLD: 8, REJECT: 0, ERROR: 0 } },
    ])
  })

  it('未知 decision は ERROR バケットに寄せる (将来の追加に備える)', () => {
    const out = aggregateDecisionRows([
      { day: '2026-04-23', decision: 'WAT', n: 3 },
    ])
    expect(out[0]!.counts.ERROR).toBe(3)
  })

  it('空配列は空配列', () => {
    expect(aggregateDecisionRows([])).toEqual([])
  })

  it('日付順にソート', () => {
    const out = aggregateDecisionRows([
      { day: '2026-04-25', decision: 'HOLD', n: 1 },
      { day: '2026-04-23', decision: 'HOLD', n: 1 },
      { day: '2026-04-24', decision: 'HOLD', n: 1 },
    ])
    expect(out.map((p) => p.date)).toEqual(['2026-04-23', '2026-04-24', '2026-04-25'])
  })
})

describe('computeTradeStats', () => {
  it('空配列はゼロ統計', () => {
    const s = computeTradeStats([])
    expect(s).toEqual({ count: 0, wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, total: 0 })
  })

  it('勝率 / 平均利益・損失 / profit factor', () => {
    const s = computeTradeStats([10, -5, 8, -3, 12])
    expect(s.count).toBe(5)
    expect(s.wins).toBe(3)
    expect(s.losses).toBe(2)
    expect(s.winRate).toBeCloseTo(0.6)
    expect(s.avgWin).toBeCloseTo(10) // (10+8+12)/3
    expect(s.avgLoss).toBeCloseTo(-4) // (-5 + -3) / 2
    expect(s.profitFactor).toBeCloseTo(30 / 8)
    expect(s.total).toBe(22)
    expect(s.expectancy).toBeGreaterThan(0)
  })

  it('全勝なら profit factor は Infinity', () => {
    const s = computeTradeStats([10, 5])
    expect(s.profitFactor).toBe(Infinity)
  })

  it('全敗なら profit factor は 0、expectancy は負', () => {
    const s = computeTradeStats([-10, -5])
    expect(s.profitFactor).toBe(0)
    expect(s.expectancy).toBeLessThan(0)
  })

  it('break-even (pnl=0) は勝負カウントに入れず expectancy 中立', () => {
    const s = computeTradeStats([0, 0, 0])
    expect(s.wins).toBe(0)
    expect(s.losses).toBe(0)
    expect(s.winRate).toBe(0)
    expect(s.expectancy).toBe(0)
  })
})

describe('computePnlHistogram', () => {
  it('空は空', () => {
    expect(computePnlHistogram([])).toEqual([])
  })

  it('absMax の対称範囲でビン分割し全件分類', () => {
    const out = computePnlHistogram([1, 2, -1, -2, 0, 3, -3])
    const total = out.reduce((acc, b) => acc + b.count, 0)
    expect(total).toBe(7)
    expect(out.length).toBeGreaterThanOrEqual(3)
    // 範囲は ±3 で対称
    expect(out[0]!.binStart).toBeCloseTo(-3)
    expect(out[out.length - 1]!.binEnd).toBeCloseTo(3)
  })

  it('全 0 は単一ビン', () => {
    const out = computePnlHistogram([0, 0])
    expect(out).toEqual([{ label: '0', binStart: 0, binEnd: 0, binCenter: 0, count: 2 }])
  })

  it('境界値 (max abs ちょうど) も末尾ビンに入る', () => {
    const out = computePnlHistogram([5, -5])
    const total = out.reduce((acc, b) => acc + b.count, 0)
    expect(total).toBe(2)
  })
})

describe('extractSma50', () => {
  it('正常な JSON から sma50 を返す', () => {
    expect(extractSma50('{"sma50":123.45,"price":120}')).toBe(123.45)
  })

  it('null / 空文字 / undefined は null', () => {
    expect(extractSma50(null)).toBe(null)
    expect(extractSma50('')).toBe(null)
  })

  it('壊れた JSON は null (履歴の schema 変動でも落ちない)', () => {
    expect(extractSma50('not-json')).toBe(null)
  })

  it('sma50 が無い / 数値でないと null', () => {
    expect(extractSma50('{"price":100}')).toBe(null)
    expect(extractSma50('{"sma50":"foo"}')).toBe(null)
    expect(extractSma50('{"sma50":null}')).toBe(null)
  })

  it('Infinity / NaN は null (JSON では NaN は parse 不可、Infinity は文字列)', () => {
    expect(extractSma50('{"sma50":1e9999}')).toBe(null)
  })
})
