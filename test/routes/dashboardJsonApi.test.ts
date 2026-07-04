import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { loadSymbolChart } from '../../src/routes/dashboard/charts/loaders'
import type { SymbolChartData } from '../../src/routes/dashboard/charts/loaders'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradeJournalRepo')>(
    '../../src/infrastructure/db/tradeJournalRepo',
  )
  return { ...actual, createDb: vi.fn() }
})
// loadSymbolChart は内部で env.DB raw SQL / Yahoo / DO を触るため、/json route の
// 契約 (schema / ladderHtml 除去 / rules 伝搬) 検証には stub で十分。
vi.mock('../../src/routes/dashboard/charts/loaders', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/dashboard/charts/loaders')>(
    '../../src/routes/dashboard/charts/loaders',
  )
  return { ...actual, loadSymbolChart: vi.fn() }
})

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }
const authHeader = {}

function fakeSymbolStateNamespace() {
  const stub = {
    async getState(symbol: string) {
      return {
        symbol,
        position: { qty: 10, avgPrice: 100, openedAt: '2026-06-20T00:00:00.000Z' },
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil: null,
        settledCash: 0,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: { price: 105, asOf: '2026-07-01T00:00:00Z', fetchedAt: '2026-07-01T00:00:00Z', source: 'yahoo' },
        updatedAt: '2026-07-01T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

/** trades loader (select→from→where→orderBy→limit) 用の fake chain。 */
function fakeJournalDb(rows: Array<Record<string, unknown>>) {
  const chain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  }
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => chain) })),
  }
  return { db, chain }
}

/** loadDecisionRows (select→from→leftJoin→where→orderBy→limit) 用の fake chain。 */
function fakeCronDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  }
  return {
    select: vi.fn(() => query),
  }
}

function journalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    timestamp: '2026-07-01T01:00:00.000Z',
    tradeEventType: 'fill',
    symbol: 'SOXL',
    side: 'BUY',
    quantity: 3,
    limitPrice: 30.5,
    filledQty: 3,
    filledPrice: 30.4,
    brokerStatus: 'FILLED',
    mode: 'LIVE',
    errorMessage: null,
    realizedPnl: null,
    exitReason: null,
    ...over,
  }
}

describe('dashboard JSON export API (#dashboard-json-api)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        inactiveSymbols: ['SOXS'],
        symbolCurrency: { SOXL: 'USD', SOXS: 'USD' },
        symbolName: { SOXL: 'Direxion Semiconductor Bull 3X' },
      }),
    )
  })
  afterEach(() => vi.resetAllMocks())

  describe('GET /dashboard/positions/json', () => {
    it('returns schema v1 with the same quote/pnl resolution as the SSR table', async () => {
      const env = {
        ...baseEnv,
        DB: {} as D1Database,
        SYMBOL_STATE: fakeSymbolStateNamespace(),
      }
      const app = createApp()
      const res = await app.request('/dashboard/positions/json', { headers: authHeader }, env)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const json = (await res.json()) as Record<string, any>
      expect(json.schema).toBe('dashboard_positions_export.v1')
      expect(typeof json.exportedAt).toBe('string')
      expect(json.rowCount).toBe(2)
      const soxl = json.positions[0]
      expect(soxl.symbol).toBe('SOXL')
      expect(soxl.displayName).toBe('Direxion Semiconductor Bull 3X')
      expect(soxl.qty).toBe(10)
      expect(soxl.avgPrice).toBe(100)
      // SSR の「現在値」列と同じ pickFreshQuote の結果 (Webull snapshot 側採用)
      expect(soxl.quote).toEqual({ price: 105, source: 'yahoo', asOf: '2026-07-01T00:00:00Z' })
      expect(soxl.unrealizedPnlPct).toBe(5)
      expect(soxl.pendingOrderSide).toBeNull()
      expect(soxl.inactive).toBe(false)
      expect(soxl.error).toBeNull()
      // inactive 銘柄も SSR 同様に含まれ、flag が立つ
      const soxs = json.positions[1]
      expect(soxs.symbol).toBe('SOXS')
      expect(soxs.inactive).toBe(true)
      // SymbolState の内部管理 field は export しない (画面同等に絞る)
      expect(soxl).not.toHaveProperty('settledCash')
      expect(soxl).not.toHaveProperty('appliedClientOrderIds')
    })

    it('returns 503 when SYMBOL_STATE is not bound', async () => {
      const env = { ...baseEnv, DB: {} as D1Database }
      const app = createApp()
      const res = await app.request('/dashboard/positions/json', { headers: authHeader }, env)
      expect(res.status).toBe(503)
      const json = (await res.json()) as Record<string, any>
      expect(json.error).toBe('binding_not_configured')
    })
  })

  describe('GET /dashboard/trades/json', () => {
    it('applies the same ?view/symbol/clientOrderId filters as SSR and echoes them in the envelope', async () => {
      const { db, chain } = fakeJournalDb([journalRow()])
      vi.mocked(createDb).mockReturnValue(db as never)
      const app = createApp()
      const res = await app.request(
        '/dashboard/trades/json?view=fills&symbol=soxl&clientOrderId=coid-1&limit=10',
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, any>
      expect(json.schema).toBe('dashboard_trades_export.v1')
      // filter の明記 (この JSON が何の部分集合かを AI が誤解しないため)
      expect(json.filter).toEqual({
        view: 'fills',
        symbol: 'SOXL',
        clientOrderId: 'coid-1',
        limit: 10,
        before: null,
      })
      expect(json.rowCount).toBe(1)
      // rows は trade_journal row そのまま (__tradesCopy と同等)
      expect(json.rows[0].id).toBe(1)
      expect(json.rows[0].tradeEventType).toBe('fill')
      // フィルタが実際に SQL where に乗っている + limit は SSR と違い +1 しない
      expect(chain.where).toHaveBeenCalledTimes(1)
      expect(chain.limit).toHaveBeenCalledWith(10)
    })

    it('returns 503 when DB is not bound', async () => {
      const app = createApp()
      const res = await app.request('/dashboard/trades/json', { headers: authHeader }, baseEnv)
      expect(res.status).toBe(503)
      const json = (await res.json()) as Record<string, any>
      expect(json.error).toBe('db_not_bound')
    })
  })

  describe('GET /dashboard/charts/symbol/json', () => {
    const fakeChart: SymbolChartData = {
      symbol: 'SOXL',
      points: [{ timestamp: '2026-07-01T00:00:00Z', price: 30, sma50: 28, high20d: 31, low20d: 27 }],
      markers: [],
      position: { avgPrice: 29, openedAt: '2026-06-20T00:00:00Z' },
      rules: { pullbackMax: -0.03, pullbackMin: -0.06, stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10 },
      trendLine: null,
      intradayBars: [],
      latestCronPrice: 30,
      latestCronTimestamp: '2026-07-01T00:00:00Z',
      decisions: [
        {
          id: 11,
          timestamp: '2026-07-01T00:00:00Z',
          price: 30,
          decision: 'SKIP',
          reason: 'pullback -0.01 > -0.03 (not deep enough)',
          ladderHtml: '<div>ladder-html-fragment</div>',
        },
      ],
      evalIndicators: [],
    }

    const decisionRow = {
      id: 11,
      timestamp: '2026-07-01T00:00:00.000Z',
      requestId: 'req-1',
      symbol: 'SOXL',
      decision: 'SKIP',
      reason: 'pullback -0.01 > -0.03 (not deep enough)',
      price: 30,
      indicatorsJson: '{"price":30,"sma50":28}',
      clientOrderId: null,
      traceJson: '[{"label":"entry.above_sma50","passed":true}]',
      filledPrice: null,
      filledQty: null,
      realizedPnl: null,
      brokerStatus: null,
    }

    it('returns schema v1 without HTML fragments and with parsed trace/indicators', async () => {
      vi.mocked(loadSymbolChart).mockResolvedValue(fakeChart)
      vi.mocked(createDb).mockReturnValue(fakeCronDb([decisionRow]) as never)
      const app = createApp()
      // 小文字 symbol は SSR 同様 upper-case に正規化される
      const res = await app.request(
        '/dashboard/charts/symbol/json?symbol=soxl',
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
      expect(res.status).toBe(200)
      // /charts SSR route に食われず JSON が返る (route 定義順の担保)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.text()
      const json = JSON.parse(body) as Record<string, any>
      expect(json.schema).toBe('dashboard_chart_symbol_export.v1')
      expect(json.symbol).toBe('SOXL')
      expect(json.rules).toEqual(fakeChart.rules)
      expect(json.points).toHaveLength(1)
      expect(json.position).toEqual({ avgPrice: 29, openedAt: '2026-06-20T00:00:00Z' })
      // 判定 pin は構造化 field のみ — HTML 断片 (ladderHtml) は落ちる
      expect(json.chartDecisions[0]).toEqual({
        id: 11,
        timestamp: '2026-07-01T00:00:00Z',
        price: 30,
        decision: 'SKIP',
        reason: 'pullback -0.01 > -0.03 (not deep enough)',
      })
      expect(body).not.toContain('ladderHtml')
      expect(body).not.toContain('ladder-html-fragment')
      // 判定履歴は traceJson / indicatorsJson が parse 済み object で入る
      expect(json.decisionHistory[0].trace).toEqual([{ label: 'entry.above_sma50', passed: true }])
      expect(json.decisionHistory[0].indicators).toEqual({ price: 30, sma50: 28 })
      expect(json.decisionHistory[0].requestId).toBe('req-1')
      // loader は SSR と同じ symbol / effective rules で呼ばれる
      const [, calledSymbol, calledRules] = vi.mocked(loadSymbolChart).mock.calls[0]!
      expect(calledSymbol).toBe('SOXL')
      expect(calledRules).toEqual({
        pullbackMax: -0.03,
        pullbackMin: -0.06,
        stopPct: -0.04,
        takeProfitPct: 0.07,
        timeStopDays: 10,
      })
    })

    it('returns 400 when ?symbol= is missing', async () => {
      const app = createApp()
      const res = await app.request(
        '/dashboard/charts/symbol/json',
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
      expect(res.status).toBe(400)
      const json = (await res.json()) as Record<string, any>
      expect(json.error).toBe('symbol_required')
    })

    it('returns 503 when DB is not bound', async () => {
      const app = createApp()
      const res = await app.request('/dashboard/charts/symbol/json?symbol=SOXL', { headers: authHeader }, baseEnv)
      expect(res.status).toBe(503)
      const json = (await res.json()) as Record<string, any>
      expect(json.error).toBe('db_not_bound')
    })

    it('degrades decisionHistory to [] when the decision-log query fails (SSR parity)', async () => {
      vi.mocked(loadSymbolChart).mockResolvedValue(fakeChart)
      const failingDb = {
        select: vi.fn(() => {
          throw new Error('no such table: strategy_decision_log')
        }),
      }
      vi.mocked(createDb).mockReturnValue(failingDb as never)
      const app = createApp()
      const res = await app.request(
        '/dashboard/charts/symbol/json?symbol=SOXL',
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as Record<string, any>
      expect(json.decisionHistory).toEqual([])
    })
  })
})
