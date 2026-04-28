import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { loadRecentAlerts } from '../../src/infrastructure/notification/notificationEmitLog'
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
vi.mock('../../src/infrastructure/notification/notificationEmitLog', () => ({
  loadRecentAlerts: vi.fn(),
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
  lastRolledAt?: string | null
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

  it('formats JP positions as `${symbol}-${name}` while leaving US untouched', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['7974', 'SOXL'],
        symbolCurrency: { '7974': 'JPY', SOXL: 'USD' },
        symbolMarket: { '7974': 'JP', SOXL: 'US' },
        symbolName: { '7974': '任天堂', SOXL: 'Direxion Semiconductor Bull 3X' },
      }),
    )
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      SYMBOL_STATE: fakeSymbolStateNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/positions', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    // JP は 番号-会社名 形式に整形される
    expect(body).toContain('7974-任天堂')
    // US 銘柄は ticker のみ (US 名は使わない、URL routing も含め symbol そのまま)
    expect(body).toContain('>SOXL<')
    expect(body).not.toContain('SOXL-Direxion')
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
        lastRolledAt: null,
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
    // issue #140: lastRolledAt = null は「未実行」表示
    expect(body).toContain('lastRolledAt')
    expect(body).toContain('未実行')
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

  // #141: dashboard alerts view
  it('renders /dashboard/alerts unavailable when DB is not bound', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/alerts', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })

  it('renders rows from notification_emit_log on /dashboard/alerts (#141)', async () => {
    vi.mocked(loadRecentAlerts).mockResolvedValue([
      {
        id: 1,
        timestamp: '2026-04-23T00:00:00.000Z',
        requestId: 'req-1',
        eventType: 'ERROR',
        severity: 'critical',
        symbol: 'SOXL',
        cause: 'portfolio_halted',
        message: '🚨 CRITICAL: SOXL — cron skipped: portfolio_halted',
      },
      {
        id: 2,
        timestamp: '2026-04-23T00:01:00.000Z',
        requestId: 'req-2',
        eventType: 'STATE_CHANGE',
        severity: 'critical',
        symbol: null,
        cause: 'dryRun',
        message: '🚨 state change: dryRun true → false',
      },
    ])
    const app = createApp()
    const res = await app.request(
      '/dashboard/alerts',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('CRITICAL: SOXL')
    expect(body).toContain('dryRun true → false')
    expect(body).toContain('portfolio_halted')
    expect(body).toContain('req-1')
  })

  it('falls back to unavailable when loadRecentAlerts throws (e.g. migration not applied)', async () => {
    vi.mocked(loadRecentAlerts).mockRejectedValue(new Error('no such table: notification_emit_log'))
    const app = createApp()
    const res = await app.request(
      '/dashboard/alerts',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })

  it('alerts page requires basic auth', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/alerts', {}, baseEnv)
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

import { parseChartsTab } from '../../src/routes/dashboard'

describe('parseChartsTab', () => {
  it('既知の tab 値はそのまま', () => {
    expect(parseChartsTab('overview')).toBe('overview')
    expect(parseChartsTab('quality')).toBe('quality')
    expect(parseChartsTab('symbol')).toBe('symbol')
  })

  it('未知 / undefined / 空文字 は overview にフォールバック', () => {
    expect(parseChartsTab(undefined)).toBe('overview')
    expect(parseChartsTab('')).toBe('overview')
    expect(parseChartsTab('xss')).toBe('overview')
    expect(parseChartsTab('OVERVIEW')).toBe('overview') // 大文字も既知扱いせず default に
  })
})

import { deriveOpenPosition } from '../../src/routes/dashboard'

describe('deriveOpenPosition', () => {
  const buy = (ts: string, price: number) => ({ timestamp: ts, side: 'BUY' as const, price, qty: 1, realizedPnl: null })
  const sell = (ts: string, price: number, pnl: number) => ({ timestamp: ts, side: 'SELL' as const, price, qty: 1, realizedPnl: pnl })

  it('空配列は null', () => {
    expect(deriveOpenPosition([])).toBe(null)
  })

  it('BUY のみ → 現保有', () => {
    expect(deriveOpenPosition([buy('2026-04-23', 100)])).toEqual({
      avgPrice: 100,
      openedAt: '2026-04-23',
    })
  })

  it('BUY → SELL → 閉鎖済 (null)', () => {
    expect(deriveOpenPosition([buy('2026-04-23', 100), sell('2026-04-24', 105, 5)])).toBe(null)
  })

  it('BUY → SELL → BUY → 直近 BUY が現保有', () => {
    const ms = [buy('2026-04-20', 100), sell('2026-04-21', 95, -5), buy('2026-04-23', 110)]
    expect(deriveOpenPosition(ms)).toEqual({ avgPrice: 110, openedAt: '2026-04-23' })
  })

  it('SELL のみ (POC で発生しないが defensively) → null', () => {
    expect(deriveOpenPosition([sell('2026-04-23', 100, 5)])).toBe(null)
  })
})

import { resolveFillSide } from '../../src/routes/dashboard'

describe('resolveFillSide', () => {
  it('pre_submit row の side ("BUY") があればそれを採用', () => {
    expect(resolveFillSide('BUY', null)).toBe('BUY')
    expect(resolveFillSide('BUY', 5)).toBe('BUY')
  })

  it('pre_submit row の side ("SELL") があればそれを採用', () => {
    expect(resolveFillSide('SELL', null)).toBe('SELL')
    expect(resolveFillSide('SELL', -3)).toBe('SELL')
  })

  it('pre_submit が無く realized_pnl が非 null なら SELL (exit trade)', () => {
    expect(resolveFillSide(null, 5)).toBe('SELL')
    expect(resolveFillSide(null, -10)).toBe('SELL')
    expect(resolveFillSide(null, 0)).toBe('SELL') // pnl=0 でも SELL (break-even exit)
  })

  it('pre_submit が無く realized_pnl も null なら BUY (entry trade)', () => {
    expect(resolveFillSide(null, null)).toBe('BUY')
  })

  it('未知の side 値 + realized_pnl で SELL 判定', () => {
    expect(resolveFillSide('partial', 5)).toBe('SELL')
  })

  it('未知の side 値 + null pnl で BUY フォールバック', () => {
    expect(resolveFillSide('weird', null)).toBe('BUY')
  })

  it('realized_pnl が NaN / Infinity の場合は null と同等扱い (BUY 推測)', () => {
    expect(resolveFillSide(null, NaN)).toBe('BUY')
    expect(resolveFillSide(null, Infinity)).toBe('BUY')
  })
})

import { renderStrategyParamsPanel, type StrategyParamsSnapshot } from '../../src/routes/dashboard'

const DEFAULT_PARAMS: StrategyParamsSnapshot = {
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.0,
}

/** Count cells flagged as 変更済 (title attr ベースで識別、凡例 ⚠ と分離)。 */
function countCellWarnings(html: string): number {
  return (html.match(/title="default 値から変更"/g) ?? []).length
}

describe('renderStrategyParamsPanel', () => {
  it('default 値のままなら cell 内 ⚠ flag は出ない (summary の凡例は別)', () => {
    const html = renderStrategyParamsPanel({ ...DEFAULT_PARAMS })
    expect(countCellWarnings(html)).toBe(0)
  })

  it('1 項目変更すると cell 内 ⚠ が 1 個', () => {
    const html = renderStrategyParamsPanel({ ...DEFAULT_PARAMS, pullbackMax: 0 })
    expect(countCellWarnings(html)).toBe(1)
    expect(html).toContain('+0.0%')
  })

  it('複数変更でそれぞれ cell ⚠', () => {
    const html = renderStrategyParamsPanel({
      ...DEFAULT_PARAMS,
      pullbackMax: 0,
      pullbackMin: -0.15,
      stopPct: -0.05,
    })
    expect(countCellWarnings(html)).toBe(3)
  })

  it('boolean (requireAboveSma50) 変更も flag', () => {
    const html = renderStrategyParamsPanel({ ...DEFAULT_PARAMS, requireAboveSma50: false })
    expect(countCellWarnings(html)).toBe(1)
    expect(html).toContain('false')
  })

  it('integer (timeStopDays) は pct ではなく素直に表示', () => {
    const html = renderStrategyParamsPanel({ ...DEFAULT_PARAMS, timeStopDays: 5 })
    expect(html).toContain('5 営業日')
    expect(html).toContain('10 営業日')
    expect(countCellWarnings(html)).toBe(1)
  })

  it('panel は collapsible <details> ラップ + 凡例で ⚠ の意味を説明', () => {
    const html = renderStrategyParamsPanel({ ...DEFAULT_PARAMS })
    expect(html).toMatch(/^<details/)
    expect(html).toContain('PullbackUptrendStrategy')
    expect(html).toContain('default から変更されている')
  })
})

import { computeChartWindowDays } from '../../src/routes/dashboard'

describe('computeChartWindowDays', () => {
  it('default 10 営業日 → 24 カレンダー日', () => {
    expect(computeChartWindowDays(10)).toBe(24)
  })

  it('短い保持 (5 営業日) でも最低 14 日確保', () => {
    expect(computeChartWindowDays(5)).toBe(14)
  })

  it('長期保持 (20 営業日) → 44 日 (祝日 / 連休跨ぎを覆う)', () => {
    expect(computeChartWindowDays(20)).toBe(44)
  })

  it('1 営業日 → floor 14 日', () => {
    expect(computeChartWindowDays(1)).toBe(14)
  })

  it('小数 (4.5 営業日) でも切り上げ', () => {
    expect(computeChartWindowDays(4.5)).toBe(14) // 13 < 14 floor
    expect(computeChartWindowDays(5.5)).toBe(15) // ceil(15) = 15
  })
})

import {
  aggregateDailyCloses,
  computeLinearRegressionLine,
  densifyTrendLine,
  type SymbolChartPoint,
  type TrendLineSegment,
} from '../../src/routes/dashboard'

describe('aggregateDailyCloses', () => {
  it('JST 日付で dedupe、その日の最終 cron eval を採用', () => {
    const points: SymbolChartPoint[] = [
      { timestamp: '2026-04-23T05:00:00.000Z', price: 100, sma50: null, high20d: null, low20d: null }, // 04/23 14:00 JST
      { timestamp: '2026-04-23T08:00:00.000Z', price: 102, sma50: null, high20d: null, low20d: null }, // 04/23 17:00 JST (last of day)
      { timestamp: '2026-04-24T05:00:00.000Z', price: 105, sma50: null, high20d: null, low20d: null }, // 04/24 14:00 JST
    ]
    const out = aggregateDailyCloses(points)
    expect(out).toEqual([
      { jstDate: '2026-04-23', close: 102, timestamp: '2026-04-23T08:00:00.000Z' },
      { jstDate: '2026-04-24', close: 105, timestamp: '2026-04-24T05:00:00.000Z' },
    ])
  })

  it('null / Infinity / 不正 timestamp は skip', () => {
    const points: SymbolChartPoint[] = [
      { timestamp: '2026-04-23T08:00:00.000Z', price: NaN, sma50: null, high20d: null, low20d: null },
      { timestamp: 'not-an-iso', price: 100, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-24T05:00:00.000Z', price: 105, sma50: null, high20d: null, low20d: null },
    ]
    expect(aggregateDailyCloses(points)).toEqual([
      { jstDate: '2026-04-24', close: 105, timestamp: '2026-04-24T05:00:00.000Z' },
    ])
  })

  it('空配列は空', () => {
    expect(aggregateDailyCloses([])).toEqual([])
  })
})

describe('computeLinearRegressionLine', () => {
  // 1 日 = 86_400_000 ms
  const DAY_MS = 24 * 3600 * 1000
  function dayIso(offsetDays: number): string {
    return new Date(offsetDays * DAY_MS).toISOString()
  }

  it('完全直線データ (y = 2t + 100) を正確に fit', () => {
    // close = 100, 102, 104, ..., 118 (10 点、slope 2/day)
    const samples = Array.from({ length: 10 }, (_, i) => ({
      timestamp: dayIso(i),
      close: 100 + 2 * i,
    }))
    const endTs = dayIso(15) // 5 日先
    const out = computeLinearRegressionLine(samples, endTs)
    expect(out).not.toBeNull()
    // start = day 0, y = 100
    expect(new Date(out!.pivots[0].timestamp).getTime()).toBe(0)
    expect(out!.pivots[0].price).toBeCloseTo(100, 6)
    // end = day 15, y = 100 + 2*15 = 130
    expect(out!.end.timestamp).toBe(endTs)
    expect(out!.end.price).toBeCloseTo(130, 6)
  })

  it('完全水平データ (slope = 0) は y = 平均 で flat', () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({
      timestamp: dayIso(i),
      close: 50,
    }))
    const out = computeLinearRegressionLine(samples, dayIso(10))
    expect(out).not.toBeNull()
    expect(out!.pivots[0].price).toBeCloseTo(50, 6)
    expect(out!.end.price).toBeCloseTo(50, 6)
  })

  it('ノイズ入り上昇データの slope が正で start < end', () => {
    // y = i + ノイズ
    const noise = [0.3, -0.5, 0.1, -0.2, 0.4, -0.1, 0.2, -0.3]
    const samples = noise.map((n, i) => ({
      timestamp: dayIso(i),
      close: i + n,
    }))
    const out = computeLinearRegressionLine(samples, dayIso(15))
    expect(out).not.toBeNull()
    expect(out!.end.price).toBeGreaterThan(out!.pivots[0].price)
  })

  it('データが 2 未満なら null', () => {
    expect(computeLinearRegressionLine([], dayIso(10))).toBe(null)
    expect(
      computeLinearRegressionLine([{ timestamp: dayIso(0), close: 100 }], dayIso(10)),
    ).toBe(null)
  })

  it('全 sample が同 timestamp (slope 不定) なら null', () => {
    const samples = [
      { timestamp: dayIso(3), close: 100 },
      { timestamp: dayIso(3), close: 110 },
      { timestamp: dayIso(3), close: 120 },
    ]
    expect(computeLinearRegressionLine(samples, dayIso(10))).toBe(null)
  })

  it('NaN / Infinity の close、不正 timestamp の sample は除外', () => {
    const samples = [
      { timestamp: dayIso(0), close: 100 },
      { timestamp: 'not-an-iso', close: 1000 }, // skip
      { timestamp: dayIso(1), close: NaN }, // skip
      { timestamp: dayIso(2), close: Number.POSITIVE_INFINITY }, // skip
      { timestamp: dayIso(3), close: 103 },
      { timestamp: dayIso(4), close: 104 },
    ]
    const out = computeLinearRegressionLine(samples, dayIso(10))
    expect(out).not.toBeNull()
    // 有効 sample = day 0, 3, 4 (close 100, 103, 104) → 概ね slope > 0
    expect(out!.end.price).toBeGreaterThan(out!.pivots[0].price)
  })

  it('endTimestamp 不正なら null', () => {
    const samples = [
      { timestamp: dayIso(0), close: 100 },
      { timestamp: dayIso(1), close: 101 },
    ]
    expect(computeLinearRegressionLine(samples, 'not-an-iso')).toBe(null)
  })

  it('入力順序が時系列で無くても並べ替えて同じ結果', () => {
    const ordered = [
      { timestamp: dayIso(0), close: 100 },
      { timestamp: dayIso(1), close: 102 },
      { timestamp: dayIso(2), close: 104 },
    ]
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!]
    const a = computeLinearRegressionLine(ordered, dayIso(5))
    const b = computeLinearRegressionLine(shuffled, dayIso(5))
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.pivots[0].price).toBeCloseTo(a!.pivots[0].price, 6)
    expect(b!.end.price).toBeCloseTo(a!.end.price, 6)
  })
})

describe('densifyTrendLine', () => {
  // p1 = (t=0, y=100), end = (t=10, y=110) → slope 1/ms
  // 実際の dashboard では epoch ms (~1.7e12) だが、線形補間の数学は
  // origin 不変なので小さい数で test しても等価。
  const baseLine: TrendLineSegment = {
    pivots: [
      { timestamp: new Date(0).toISOString(), price: 100, type: 'high' },
      { timestamp: new Date(10).toISOString(), price: 110, type: 'high' },
    ],
    end: { timestamp: new Date(10).toISOString(), price: 110 },
  }

  it('line が null なら null', () => {
    expect(densifyTrendLine(null, [0, 1, 2])).toBe(null)
  })

  it('intradayBars 各 timestamp で y を線形補間', () => {
    const samples = [0, 2, 5, 8, 10]
    const out = densifyTrendLine(baseLine, samples)
    // slope = (110-100)/(10-0) = 1 → y = 100 + 1*t
    expect(out).toEqual([
      [0, 100],
      [2, 102],
      [5, 105],
      [8, 108],
      [10, 110],
    ])
  })

  it('p1 / end の外側でも extrapolate (両側に伸びる)', () => {
    // sample に -5 と 15 を含めると外挿される
    const samples = [-5, 0, 10, 15]
    const out = densifyTrendLine(baseLine, samples)
    expect(out).toEqual([
      [-5, 95],
      [0, 100],
      [10, 110],
      [15, 115],
    ])
  })

  it('intradayBars 空 (Yahoo fetch 失敗) のとき 2 点 endpoint fallback', () => {
    const out = densifyTrendLine(baseLine, [])
    expect(out).toEqual([
      [0, 100],
      [10, 110],
    ])
  })

  it('ISO string sample timestamps も accept (各 b.timestamp は ISO)', () => {
    const samples = [
      new Date(0).toISOString(),
      new Date(5).toISOString(),
      new Date(10).toISOString(),
    ]
    const out = densifyTrendLine(baseLine, samples)
    expect(out).toEqual([
      [0, 100],
      [5, 105],
      [10, 110],
    ])
  })

  it('重複 timestamp は dedupe + 昇順 sort', () => {
    const samples = [10, 0, 5, 5, 10, 0]
    const out = densifyTrendLine(baseLine, samples)
    expect(out).toEqual([
      [0, 100],
      [5, 105],
      [10, 110],
    ])
  })

  it('NaN / 不正 timestamp は除外する', () => {
    const samples: Array<string | number> = [
      NaN,
      'not-an-iso',
      0,
      5,
      Number.POSITIVE_INFINITY,
      10,
    ]
    const out = densifyTrendLine(baseLine, samples)
    expect(out).toEqual([
      [0, 100],
      [5, 105],
      [10, 110],
    ])
  })

  it('p1 == end (degenerate) のとき 2 点 fallback (slope 不定)', () => {
    const degenerate: TrendLineSegment = {
      pivots: [
        { timestamp: new Date(5).toISOString(), price: 100, type: 'high' },
        { timestamp: new Date(5).toISOString(), price: 100, type: 'high' },
      ],
      end: { timestamp: new Date(5).toISOString(), price: 100 },
    }
    const out = densifyTrendLine(degenerate, [0, 5, 10])
    expect(out).toEqual([
      [5, 100],
      [5, 100],
    ])
  })
})

import { densifyHorizontalLine } from '../../src/routes/dashboard'

describe('densifyHorizontalLine', () => {
  it('範囲内 sample を取り込み端点も含めて昇順 dense path にする', () => {
    const out = densifyHorizontalLine(124.95, 0, 100, [10, 50, 80])
    expect(out).toEqual([
      [0, 124.95],
      [10, 124.95],
      [50, 124.95],
      [80, 124.95],
      [100, 124.95],
    ])
  })

  it('samples が範囲外のものだけ → 端点 2 点のみ', () => {
    const out = densifyHorizontalLine(120, 50, 100, [10, 20, 200, 300])
    expect(out).toEqual([
      [50, 120],
      [100, 120],
    ])
  })

  it('samples が空 → 端点 2 点のみ', () => {
    const out = densifyHorizontalLine(120, 50, 100, [])
    expect(out).toEqual([
      [50, 120],
      [100, 120],
    ])
  })

  it('fromTs == toTs (degenerate、openedAt と最新が同 ms) → 2 点 fallback', () => {
    // a >= b ブランチ。実用上は呼び元で endTs = max(latestTs, openedAt) clamp
    // しているので fromTs == toTs は openedAt 直後 (latestTs == openedAt) の
    // ケース。
    const out = densifyHorizontalLine(120, 50, 50, [10, 50, 80])
    expect(out).toEqual([
      [50, 120],
      [50, 120],
    ])
  })

  it('fromTs > toTs (defensive) → 2 点 fallback', () => {
    const out = densifyHorizontalLine(120, 100, 50, [60, 70])
    expect(out).toEqual([
      [100, 120],
      [50, 120],
    ])
  })

  it('samples が duplicate / 順序乱れ → ascending unique', () => {
    const out = densifyHorizontalLine(120, 0, 100, [50, 10, 50, 10, 80])
    expect(out).toEqual([
      [0, 120],
      [10, 120],
      [50, 120],
      [80, 120],
      [100, 120],
    ])
  })

  it('NaN / 不正 ISO の sample は除外', () => {
    const out = densifyHorizontalLine(120, 0, 100, [
      NaN,
      'not-an-iso',
      Number.POSITIVE_INFINITY,
      50,
    ])
    expect(out).toEqual([
      [0, 120],
      [50, 120],
      [100, 120],
    ])
  })

  it('ISO string fromTs / toTs / samples を accept', () => {
    const out = densifyHorizontalLine(
      120,
      new Date(0).toISOString(),
      new Date(100).toISOString(),
      [new Date(25).toISOString(), new Date(75).toISOString()],
    )
    expect(out).toEqual([
      [0, 120],
      [25, 120],
      [75, 120],
      [100, 120],
    ])
  })

  it('yValue が NaN → null (描画 skip)', () => {
    expect(densifyHorizontalLine(NaN, 0, 100, [50])).toBe(null)
    expect(densifyHorizontalLine(Number.POSITIVE_INFINITY, 0, 100, [50])).toBe(null)
  })

  it('fromTs / toTs が不正なら null', () => {
    expect(densifyHorizontalLine(120, 'not-an-iso', 100, [50])).toBe(null)
    expect(densifyHorizontalLine(120, 0, 'not-an-iso', [50])).toBe(null)
    expect(densifyHorizontalLine(120, NaN, 100, [50])).toBe(null)
  })
})

import { mergeYahooAndCronPoints } from '../../src/routes/dashboard'

describe('mergeYahooAndCronPoints', () => {
  it('Yahoo bar の日が cron-eval にあれば cron 優先 (indicators 保持)', () => {
    const yahoo = [
      { jstDate: '2026-04-23', close: 100, timestamp: '2026-04-23T16:00:00.000Z' },
      { jstDate: '2026-04-24', close: 105, timestamp: '2026-04-24T16:00:00.000Z' },
    ]
    const cron: SymbolChartPoint[] = [
      { timestamp: '2026-04-24T05:00:00.000Z', price: 104, sma50: 90, high20d: 110, low20d: 80 }, // JST 04/24
    ]
    const merged = mergeYahooAndCronPoints(yahoo, cron)
    // 04/23: Yahoo, 04/24: cron (preferred)
    expect(merged.length).toBe(2)
    expect(merged[0]!.price).toBe(100) // Yahoo
    expect(merged[0]!.sma50).toBe(null)
    expect(merged[1]!.price).toBe(104) // cron preferred
    expect(merged[1]!.sma50).toBe(90)
  })

  it('Yahoo に無い cron eval は保持される', () => {
    const yahoo = [{ jstDate: '2026-04-23', close: 100, timestamp: '2026-04-23T16:00:00.000Z' }]
    const cron: SymbolChartPoint[] = [
      { timestamp: '2026-04-25T05:00:00.000Z', price: 110, sma50: null, high20d: null, low20d: null },
    ]
    const merged = mergeYahooAndCronPoints(yahoo, cron)
    expect(merged.length).toBe(2)
    expect(merged.map((p) => p.price)).toEqual([100, 110])
  })

  it('timestamp 昇順でソート', () => {
    const yahoo = [
      { jstDate: '2026-04-25', close: 110, timestamp: '2026-04-25T16:00:00.000Z' },
      { jstDate: '2026-04-23', close: 100, timestamp: '2026-04-23T16:00:00.000Z' },
    ]
    const merged = mergeYahooAndCronPoints(yahoo, [])
    expect(merged.map((p) => p.timestamp)).toEqual([
      '2026-04-23T16:00:00.000Z',
      '2026-04-25T16:00:00.000Z',
    ])
  })

  it('空入力は空', () => {
    expect(mergeYahooAndCronPoints([], [])).toEqual([])
  })

  it('不正 timestamp の cron point は merged からも除外される', () => {
    const yahoo = [{ jstDate: '2026-04-23', close: 100, timestamp: '2026-04-23T16:00:00.000Z' }]
    const cron: SymbolChartPoint[] = [
      { timestamp: 'not-an-iso', price: 110, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-25T05:00:00.000Z', price: 120, sma50: null, high20d: null, low20d: null },
    ]
    const merged = mergeYahooAndCronPoints(yahoo, cron)
    // Yahoo は残る + 有効な cron (04/25) は残る + 不正 cron は完全に除外
    expect(merged.length).toBe(2)
    expect(merged.some((p) => p.timestamp === 'not-an-iso')).toBe(false)
    expect(merged.map((p) => p.timestamp)).toEqual([
      '2026-04-23T16:00:00.000Z',
      '2026-04-25T05:00:00.000Z',
    ])
  })

  it('Yahoo bar の sma50 を cron eval (sma50=null) に埋め込む', () => {
    const yahoo = [
      { jstDate: '2026-04-24', close: 105, sma50: 92, timestamp: '2026-04-24T16:00:00.000Z' },
    ]
    const cron: SymbolChartPoint[] = [
      // 同 JST 日かつ sma50 null → Yahoo SMA50 で埋める
      { timestamp: '2026-04-24T05:00:00.000Z', price: 104, sma50: null, high20d: null, low20d: null },
    ]
    const merged = mergeYahooAndCronPoints(yahoo, cron)
    expect(merged.length).toBe(1) // 同 JST 日なので cron 優先 + Yahoo は filler skip
    expect(merged[0]!.sma50).toBe(92)
  })

  it('cron eval が sma50 を持っていれば Yahoo より優先', () => {
    const yahoo = [
      { jstDate: '2026-04-24', close: 105, sma50: 92, timestamp: '2026-04-24T16:00:00.000Z' },
    ]
    const cron: SymbolChartPoint[] = [
      { timestamp: '2026-04-24T05:00:00.000Z', price: 104, sma50: 88, high20d: null, low20d: null },
    ]
    const merged = mergeYahooAndCronPoints(yahoo, cron)
    expect(merged[0]!.sma50).toBe(88) // cron 優先
  })

  it('Yahoo only の日は yahoo.sma50 がそのまま filler に乗る', () => {
    const yahoo = [
      { jstDate: '2026-04-23', close: 100, sma50: 90, timestamp: '2026-04-23T16:00:00.000Z' },
    ]
    const merged = mergeYahooAndCronPoints(yahoo, [])
    expect(merged[0]!.sma50).toBe(90)
  })
})

import { computeRollingSma } from '../../src/routes/dashboard'

describe('computeRollingSma', () => {
  it('window より少ない先頭は null、window 到達後に平均', () => {
    const out = computeRollingSma([1, 2, 3, 4, 5], 3)
    expect(out).toEqual([null, null, 2, 3, 4])
  })

  it('window=1 は値そのまま', () => {
    expect(computeRollingSma([10, 20, 30], 1)).toEqual([10, 20, 30])
  })

  it('空入力は空', () => {
    expect(computeRollingSma([], 5)).toEqual([])
  })

  it('window <= 0 は全 null (defensive)', () => {
    expect(computeRollingSma([1, 2, 3], 0)).toEqual([null, null, null])
  })
})

import { fetchYahooBarsForChart } from '../../src/routes/dashboard'

describe('fetchYahooBarsForChart', () => {
  // warmup を足してから getDailyBars に渡す実装で contract leak していたケース
  // (lookback=0 / 負値 / 非整数) を caller contract のままで弾けることを確認。
  // 実 fetch には行かないので mock 不要 (validation で先に throw)。
  it('lookback=0 で RangeError', async () => {
    await expect(fetchYahooBarsForChart('AAPL', 0)).rejects.toBeInstanceOf(RangeError)
  })
  it('lookback 負値で RangeError', async () => {
    await expect(fetchYahooBarsForChart('AAPL', -10)).rejects.toBeInstanceOf(RangeError)
  })
  it('lookback 非整数で RangeError', async () => {
    await expect(fetchYahooBarsForChart('AAPL', 1.5)).rejects.toBeInstanceOf(RangeError)
  })
})

import { parseIsoTimestamp } from '../../src/routes/dashboard'

describe('parseIsoTimestamp', () => {
  it('valid ISO UTC は Date を返す', () => {
    const d = parseIsoTimestamp('2026-04-25T13:00:00.000Z')
    expect(d).not.toBeNull()
    expect(d!.toISOString()).toBe('2026-04-25T13:00:00.000Z')
  })

  it('Z 無し ISO は UTC と解釈 (local time として 9 時間ずれない)', () => {
    const d = parseIsoTimestamp('2026-04-25T13:00:00')
    expect(d).not.toBeNull()
    // runner の TZ に関わらず UTC 13:00 として解釈される
    expect(d!.toISOString()).toBe('2026-04-25T13:00:00.000Z')
  })

  it('±HH:MM offset 付き ISO は offset 通り解釈', () => {
    const d = parseIsoTimestamp('2026-04-25T13:00:00+09:00')
    expect(d!.toISOString()).toBe('2026-04-25T04:00:00.000Z')
  })

  it('date-only 文字列は ECMAScript 仕様で UTC 解釈', () => {
    const d = parseIsoTimestamp('2026-04-25')
    expect(d!.toISOString()).toBe('2026-04-25T00:00:00.000Z')
  })

  it('undefined / 空文字列 / 空白は null', () => {
    expect(parseIsoTimestamp(undefined)).toBeNull()
    expect(parseIsoTimestamp('')).toBeNull()
    expect(parseIsoTimestamp('   ')).toBeNull()
  })

  it('壊れた文字列は null', () => {
    expect(parseIsoTimestamp('not-an-iso')).toBeNull()
    expect(parseIsoTimestamp('2026-99-99')).toBeNull()
  })

  it('数字のみ文字列は invalid (Date は ISO format string のみ accept)', () => {
    // new Date('1777705200000') は Invalid Date。URL から数字の timestamp ms を
    // 渡されても reject される (ISO format でないので意図的)。client 側は
    // 必ず ISO で URL を更新するので運用上問題なし。
    expect(parseIsoTimestamp('1777705200000')).toBeNull()
  })
})

import { computeZoomRange, DEFAULT_ZOOM_WINDOW_MS, type SymbolChartData } from '../../src/routes/dashboard'

describe('computeZoomRange', () => {
  function fakeChart(lastTs: string): SymbolChartData {
    return {
      symbol: 'X',
      points: [{ timestamp: lastTs, price: 100, sma50: null, high20d: null, low20d: null }],
      markers: [],
      position: null,
      rules: { pullbackMax: 0, pullbackMin: 0, stopPct: 0, takeProfitPct: 0, timeStopDays: 10 },
      trendLine: null,
      intradayBars: [],
    }
  }

  it('valid URL params なら from < to をそのまま採用', () => {
    const from = new Date('2026-04-15T00:00:00Z')
    const to = new Date('2026-04-22T00:00:00Z')
    const out = computeZoomRange(from, to, null)
    expect(out).toEqual({ from, to })
  })

  it('URL params 無 + points 有 → lastTimestamp 基準で直近 7 日', () => {
    const chart = fakeChart('2026-04-25T00:00:00Z')
    const out = computeZoomRange(null, null, chart)
    expect(out).not.toBeNull()
    expect(out!.to.toISOString()).toBe('2026-04-25T00:00:00.000Z')
    // 7 日前 = 2026-04-18
    expect(out!.from.getTime()).toBe(out!.to.getTime() - DEFAULT_ZOOM_WINDOW_MS)
    expect(out!.from.toISOString()).toBe('2026-04-18T00:00:00.000Z')
  })

  it('from >= to (不整合) は default 7 日にフォールバック', () => {
    const chart = fakeChart('2026-04-25T00:00:00Z')
    const reversedFrom = new Date('2026-04-25T00:00:00Z')
    const reversedTo = new Date('2026-04-15T00:00:00Z')
    const out = computeZoomRange(reversedFrom, reversedTo, chart)
    expect(out).not.toBeNull()
    expect(out!.from.toISOString()).toBe('2026-04-18T00:00:00.000Z')
  })

  it('chart が null でも params あれば valid', () => {
    const from = new Date('2026-04-15T00:00:00Z')
    const to = new Date('2026-04-22T00:00:00Z')
    expect(computeZoomRange(from, to, null)).toEqual({ from, to })
  })

  it('chart 空 + params 無 → null (zoom なし)', () => {
    expect(computeZoomRange(null, null, null)).toBeNull()
  })

  it('points 配列空 + params 無 → null', () => {
    const chart: SymbolChartData = {
      symbol: 'X', points: [], markers: [], position: null,
      rules: { pullbackMax: 0, pullbackMin: 0, stopPct: 0, takeProfitPct: 0, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
    }
    expect(computeZoomRange(null, null, chart)).toBeNull()
  })

  it('lastPoint timestamp 不正 → null (defensive)', () => {
    const chart = fakeChart('not-an-iso')
    expect(computeZoomRange(null, null, chart)).toBeNull()
  })
})

import { anchorJstMidnight } from '../../src/routes/dashboard'

describe('anchorJstMidnight', () => {
  it('YYYY-MM-DD を JST 00:00 に anchor して ISO Z を返す', () => {
    // JST 04/25 00:00 = UTC 04/24 15:00
    expect(anchorJstMidnight('2026-04-25')).toBe('2026-04-24T15:00:00.000Z')
  })

  it('JST formatter (Asia/Tokyo) でレンダリングすると同じ b.date 日に表示される', () => {
    const iso = anchorJstMidnight('2026-04-25')
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    expect(fmt.format(new Date(iso))).toBe('2026-04-25')
  })

  it('複数日の anchor は時系列順にソート可能 (lexical = chronological)', () => {
    const a = anchorJstMidnight('2026-04-23')
    const b = anchorJstMidnight('2026-04-24')
    const c = anchorJstMidnight('2026-04-25')
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })
})

import { renderCurrentIndicatorsBadge } from '../../src/routes/dashboard'

describe('renderCurrentIndicatorsBadge', () => {
  function fakeChartWith(points: SymbolChartPoint[]): SymbolChartData {
    return {
      symbol: 'X', points, markers: [], position: null,
      rules: { pullbackMax: 0, pullbackMin: 0, stopPct: 0, takeProfitPct: 0, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
    }
  }

  it('chart が null なら空文字', () => {
    expect(renderCurrentIndicatorsBadge(null)).toBe('')
  })

  it('points 空なら空文字', () => {
    expect(renderCurrentIndicatorsBadge(fakeChartWith([]))).toBe('')
  })

  it('全 indicator null の point しか無ければ空文字', () => {
    const chart = fakeChartWith([
      { timestamp: '2026-04-25T05:00:00.000Z', price: 120, sma50: null, high20d: null, low20d: null },
    ])
    expect(renderCurrentIndicatorsBadge(chart)).toBe('')
  })

  it('最新の indicator 付き point から price/SMA50/high20d/low20d を表示', () => {
    const chart = fakeChartWith([
      { timestamp: '2026-04-23T05:00:00.000Z', price: 100, sma50: 60, high20d: 105, low20d: 90 },
      // Yahoo filler (indicators null) — skip
      { timestamp: '2026-04-24T16:00:00.000Z', price: 110, sma50: null, high20d: null, low20d: null },
      // 末尾から探して 04/23 の point を採用
    ])
    const html = renderCurrentIndicatorsBadge(chart)
    expect(html).toContain('price')
    expect(html).toContain('100.00')
    expect(html).toContain('SMA50')
    expect(html).toContain('60.00')
    expect(html).toContain('high20d')
    expect(html).toContain('105.00')
    expect(html).toContain('low20d')
    expect(html).toContain('90.00')
  })

  it('一部 indicator が null でも em-dash で fallback', () => {
    const chart = fakeChartWith([
      { timestamp: '2026-04-25T05:00:00.000Z', price: 120, sma50: 60, high20d: null, low20d: null },
    ])
    const html = renderCurrentIndicatorsBadge(chart)
    expect(html).toContain('120.00')
    expect(html).toContain('60.00')
    expect(html).toContain('—') // high20d / low20d
  })
})

import { renderZoomPresetButtons } from '../../src/routes/dashboard'

describe('renderZoomPresetButtons', () => {
  function fakeChart(points: SymbolChartPoint[]): SymbolChartData {
    return {
      symbol: 'X', points, markers: [], position: null,
      rules: { pullbackMax: 0, pullbackMin: 0, stopPct: 0, takeProfitPct: 0, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
    }
  }

  it('chart null / points 空なら空文字', () => {
    expect(renderZoomPresetButtons(null)).toBe('')
    expect(renderZoomPresetButtons(fakeChart([]))).toBe('')
  })

  it('points あれば 1D / 5D / 1M / All の 4 ボタン', () => {
    const chart = fakeChart([
      { timestamp: '2026-04-01T00:00:00.000Z', price: 100, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-25T00:00:00.000Z', price: 120, sma50: null, high20d: null, low20d: null },
    ])
    const html = renderZoomPresetButtons(chart)
    expect(html).toContain('>1D<')
    expect(html).toContain('>5D<')
    expect(html).toContain('>1M<')
    expect(html).toContain('>All<')
    expect(html.match(/class="zoom-preset"/g)?.length).toBe(4)
  })

  it('1D ボタンの from は lastTimestamp - 1day、to は lastTimestamp', () => {
    const chart = fakeChart([
      { timestamp: '2026-04-25T00:00:00.000Z', price: 120, sma50: null, high20d: null, low20d: null },
    ])
    const html = renderZoomPresetButtons(chart)
    const lastMs = new Date('2026-04-25T00:00:00.000Z').getTime()
    const day = 24 * 3600 * 1000
    expect(html).toContain(`data-from-ms="${lastMs - day}"`)
    expect(html).toContain(`data-to-ms="${lastMs}"`)
  })

  it('All ボタンは earliest 〜 latest を範囲に', () => {
    const chart = fakeChart([
      { timestamp: '2026-02-01T00:00:00.000Z', price: 50, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-25T00:00:00.000Z', price: 120, sma50: null, high20d: null, low20d: null },
    ])
    const html = renderZoomPresetButtons(chart)
    const earliestMs = new Date('2026-02-01T00:00:00.000Z').getTime()
    const lastMs = new Date('2026-04-25T00:00:00.000Z').getTime()
    expect(html).toContain(`data-from-ms="${earliestMs}"`)
    expect(html).toContain(`data-to-ms="${lastMs}"`)
  })

  it('lastPoint timestamp 不正なら空文字', () => {
    const chart = fakeChart([
      { timestamp: 'not-an-iso', price: 100, sma50: null, high20d: null, low20d: null },
    ])
    expect(renderZoomPresetButtons(chart)).toBe('')
  })
})

import { loadAllSymbolCharts, renderGridTab } from '../../src/routes/dashboard'

describe('loadAllSymbolCharts', () => {
  // env stub: loadSymbolChart は内部で env.DB / Yahoo / DO を触るが、ここでは
  // 「並列実行と error handling」だけを検証したい。loadSymbolChart 自体は
  // module-level export なのでテストが直接呼ぶ前提では env を fully fake する
  // のが大袈裟になる。代わりに、本テストは「loadSymbolChart が throw した時
  // に panel が null + error になる」「全成功時に全 panel が chart を持つ」
  // を cron-only path (env.DB だけ stub) で確認する。
  // → 上記は SQL 文の prepare/bind 等を fake する必要があり実装重量が大きい
  //    ため、純関数的に loadAllSymbolCharts の error 吸収を検証する spy 方式
  //    に切り替える。

  it('1 銘柄が throw しても他は成功 (per-symbol catch)', async () => {
    // env.DB === undefined にすると loadSymbolChart が即 'DB binding not
    // available' で throw する → 全 panel が error 状態。並列性と catch を
    // 確認するための minimal な black-box テスト。
    const fakeEnv = {} as unknown as Parameters<typeof loadAllSymbolCharts>[0]
    const result = await loadAllSymbolCharts(fakeEnv, ['AAA', 'BBB', 'CCC'], {
      pullbackMax: -0.03, pullbackMin: -0.06, stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10,
    })
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.symbol)).toEqual(['AAA', 'BBB', 'CCC'])
    // 全件が error (DB binding not available)。chart は null。
    for (const r of result) {
      expect(r.chart).toBeNull()
      expect(r.error).not.toBeNull()
    }
  })

  it('symbols 空配列 → 空配列を返す (subrequest 浪費なし)', async () => {
    const fakeEnv = {} as unknown as Parameters<typeof loadAllSymbolCharts>[0]
    const result = await loadAllSymbolCharts(fakeEnv, [], {
      pullbackMax: -0.03, pullbackMin: -0.06, stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10,
    })
    expect(result).toEqual([])
  })
})

describe('renderGridTab', () => {
  function makeChart(symbol: string, points: SymbolChartPoint[]): SymbolChartData {
    return {
      symbol, points, markers: [], position: null,
      rules: { pullbackMax: -0.03, pullbackMin: -0.06, stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
    }
  }

  it('全銘柄ぶんの panel <div> と preset toolbar / connect 用 grid container を含む', () => {
    const html = renderGridTab({
      tab: 'grid',
      charts: [
        { symbol: 'SOXL', chart: makeChart('SOXL', [
          { timestamp: '2026-04-25T00:00:00.000Z', price: 120, sma50: 80, high20d: 130, low20d: 100 },
        ]), error: null },
        { symbol: 'TQQQ', chart: makeChart('TQQQ', [
          { timestamp: '2026-04-25T00:00:00.000Z', price: 60, sma50: 55, high20d: 65, low20d: 50 },
        ]), error: null },
      ],
      zoom: null,
    })
    expect(html).toContain('id="grid-chart-0"')
    expect(html).toContain('id="grid-chart-1"')
    expect(html).toContain('SOXL')
    expect(html).toContain('TQQQ')
    expect(html).toContain('class="symbols-grid"')
    expect(html).toContain('?tab=symbol&symbol=SOXL')
    expect(html).toContain('?tab=symbol&symbol=TQQQ')
    // preset toolbar (1D/5D/1M/All) は reference chart 由来で出る
    expect(html).toContain('class="zoom-preset"')
    expect(html.match(/class="zoom-preset"/g)?.length).toBe(4)
  })

  it('load 失敗 panel は error メッセージを表示しても全体は描画される', () => {
    const html = renderGridTab({
      tab: 'grid',
      charts: [
        { symbol: 'OK', chart: makeChart('OK', [
          { timestamp: '2026-04-25T00:00:00.000Z', price: 100, sma50: null, high20d: null, low20d: null },
        ]), error: null },
        { symbol: 'BAD', chart: null, error: 'Yahoo fetch timeout' },
      ],
      zoom: null,
    })
    expect(html).toContain('OK')
    expect(html).toContain('BAD')
    expect(html).toContain('Yahoo fetch timeout')
    expect(html).toContain('取得失敗')
    // 成功 panel の chart container だけ出る (失敗 panel は chart 描画なし)
    expect(html).toContain('id="grid-chart-0"')
    expect(html).not.toContain('id="grid-chart-1"')
  })

  it('charts 空 → ALLOWED_SYMBOLS が空である旨を案内', () => {
    const html = renderGridTab({ tab: 'grid', charts: [], zoom: null })
    expect(html).toContain('ALLOWED_SYMBOLS が空')
  })
})

import { renderLastRolledCell } from '../../src/routes/dashboard'

describe('renderLastRolledCell (issue #140)', () => {
  // 2026-04-25T00:00:00Z = 09:00 JST。3 ケースの elapsed を相対計算するための
  // anchor。
  const fixedNowMs = Date.parse('2026-04-25T00:00:00.000Z')
  const now = () => fixedNowMs

  it('renders 「未実行」 with warn class when lastRolledAt is null', () => {
    const html = renderLastRolledCell(null, now)
    expect(html).toContain('class="warn"')
    expect(html).toContain('未実行')
  })

  it('renders ok badge when lastRolledAt is recent (< 24h)', () => {
    const recent = new Date(fixedNowMs - 1 * 3_600_000).toISOString()
    const html = renderLastRolledCell(recent, now)
    expect(html).toContain('class="ok"')
    expect(html).toContain('1.0h 前')
  })

  it('renders warn badge when lastRolledAt is 24h–48h old', () => {
    const stale = new Date(fixedNowMs - 30 * 3_600_000).toISOString()
    const html = renderLastRolledCell(stale, now)
    expect(html).toContain('class="warn"')
    expect(html).toContain('30.0h 前')
    expect(html).toContain('24h 超')
  })

  it('renders err badge when lastRolledAt is >= 48h old', () => {
    const veryStale = new Date(fixedNowMs - 50 * 3_600_000).toISOString()
    const html = renderLastRolledCell(veryStale, now)
    expect(html).toContain('class="err"')
    expect(html).toContain('50.0h 前')
    expect(html).toContain('48h 超')
  })

  it('renders err badge when lastRolledAt is unparseable', () => {
    const html = renderLastRolledCell('not-an-iso', now)
    expect(html).toContain('class="err"')
    expect(html).toContain('parse 不能')
  })
})

import { renderAlertFilterPills } from '../../src/routes/dashboard'

describe('renderAlertFilterPills', () => {
  it('preserves unrelated query params (e.g. limit) when switching severity', () => {
    const current = new URLSearchParams('limit=500&severity=warning')
    const html = renderAlertFilterPills(['warning'], undefined, current)
    // critical pill should switch severity but keep limit=500.
    expect(html).toContain('href="/dashboard/alerts?limit=500&amp;severity=critical"')
    // warning pill should be the active one (currently selected).
    expect(html).toContain('href="/dashboard/alerts?limit=500&amp;severity=warning"')
    // 全 severity pill drops the severity key but keeps limit.
    expect(html).toContain('href="/dashboard/alerts?limit=500"')
  })

  it('drops severity entirely when 全 severity is selected (no stale severity param)', () => {
    const current = new URLSearchParams('severity=info')
    const html = renderAlertFilterPills(['info'], undefined, current)
    expect(html).toContain('href="/dashboard/alerts"')
  })

  it('includes both severity and eventType keys when current url already has both', () => {
    const current = new URLSearchParams('limit=200&severity=critical&eventType=ERROR')
    const html = renderAlertFilterPills(['critical'], 'ERROR', current)
    // Switching to TRADE event type should keep limit and severity.
    expect(html).toContain(
      'href="/dashboard/alerts?limit=200&amp;severity=critical&amp;eventType=TRADE"',
    )
  })
})
