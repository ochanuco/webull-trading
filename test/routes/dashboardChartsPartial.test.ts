import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { loadSymbolChart } from '../../src/routes/dashboard/charts/loaders'
import type { SymbolChartData } from '../../src/routes/dashboard/charts/loaders'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

// loadSymbolChart は D1 raw SQL / Yahoo / DO を内部で叩くため、route 契約
// (partial 分岐 / __chartData 埋め込み) の検証には stub で十分。
// /dashboard/charts/symbol/json の既存テスト (dashboardJsonApi.test.ts) と
// 同じ mocking 方針を踏襲する。
vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', async (importOriginal) => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradeJournalRepo')>(
    '../../src/infrastructure/db/tradeJournalRepo',
  )
  return { ...actual, createDb: vi.fn() }
})
vi.mock('../../src/routes/dashboard/charts/loaders', async () => {
  const actual = await vi.importActual<typeof import('../../src/routes/dashboard/charts/loaders')>(
    '../../src/routes/dashboard/charts/loaders',
  )
  return { ...actual, loadSymbolChart: vi.fn() }
})

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }
const authHeader = {}

/**
 * `pickDefaultSymbol` (`/charts` route が focusSymbol 解決の前に必ず呼ぶ) 用の
 * 最小 D1 fake。常に空件数を返す — このテストでは常に明示 `?symbol=` を渡す
 * ので default 銘柄の解決結果自体は使わない。`loadSymbolChart` は別途 mock
 * 済みなので、D1 に投げる他クエリはここを通らない。
 */
function fakeChartsDb(): D1Database {
  const stmt = { bind: () => stmt, all: async () => ({ results: [] }) }
  return { prepare: () => stmt } as unknown as D1Database
}

/** `loadDecisionRows` (drizzle 経由) 用の fake chain。dashboardJsonApi.test.ts と同じ形。 */
function fakeCronDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  }
  return { select: vi.fn(() => query) }
}

const fakeChart: SymbolChartData = {
  symbol: 'SOXL',
  points: [{ timestamp: '2026-07-01T00:00:00Z', price: 30, sma50: 28, high20d: 31, low20d: 27 }],
  markers: [],
  position: { avgPrice: 29, openedAt: '2026-06-20T00:00:00Z', qty: 4 },
  rules: { pullbackMax: -0.03, pullbackMin: -0.06, stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10 },
  trendLine: null,
  intradayBars: [],
  latestCronPrice: 30,
  latestCronTimestamp: '2026-07-01T00:00:00Z',
  decisions: [],
  evalIndicators: [],
}

describe('GET /dashboard/charts?tab=symbol&partial=1 (#charts-symbol-redesign Phase C)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
    vi.mocked(createDb).mockReturnValue(fakeCronDb([]) as never)
    vi.mocked(loadSymbolChart).mockResolvedValue(fakeChart)
  })
  afterEach(() => vi.resetAllMocks())

  it('partial=1 は #symbol-main の内側 HTML だけを返す (フルページ要素を含まない)、no-store', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/charts?tab=symbol&symbol=SOXL&partial=1',
      { headers: authHeader },
      { ...baseEnv, DB: fakeChartsDb() },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.text()
    // フルページ限定の要素 (nav / rail / echarts CDN・static script) は含まない
    expect(body).not.toContain('<nav>')
    expect(body).not.toContain('class="symbol-rail"')
    expect(body).not.toContain('id="symbol-main"')
    expect(body).not.toContain('cdn.jsdelivr.net/npm/echarts')
    expect(body).not.toContain('/dashboard/static/symbol-chart.js')
    // #symbol-main の内側 (サブナビ〜トレースパネル) は含む
    expect(body).toContain('class="symbol-subnav"')
    expect(body).toContain('id="symbol-chart"')
    expect(body).toContain('id="decision-trace-panel"')
    // __chartData は type="application/json" の inert script として含む
    expect(body).toContain('<script type="application/json" id="__chartData">')
    expect(body).toContain('"symbol":"SOXL"')
  })

  it('partial 無し (フルページ) は nav / rail / echarts CDN・static script を含む', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/charts?tab=symbol&symbol=SOXL',
      { headers: authHeader },
      { ...baseEnv, DB: fakeChartsDb() },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<nav>')
    expect(body).toContain('class="symbol-rail"')
    expect(body).toContain('id="symbol-main"')
    expect(body).toContain('cdn.jsdelivr.net/npm/echarts')
    expect(body).toContain('/dashboard/static/symbol-chart.js')
  })

  it('チャートデータの無い銘柄でもフルページは client script を読み込む (レール経由の切替に必要)', async () => {
    vi.mocked(loadSymbolChart).mockResolvedValue({ ...fakeChart, points: [] })
    const app = createApp()
    const res = await app.request(
      '/dashboard/charts?tab=symbol&symbol=SOXL',
      { headers: authHeader },
      { ...baseEnv, DB: fakeChartsDb() },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('この銘柄にはまだ判定ログ')
    expect(body).toContain('/dashboard/static/symbol-chart.js')
  })

  it('チャートデータの無い銘柄の partial=1 は __chartData を出さない', async () => {
    vi.mocked(loadSymbolChart).mockResolvedValue({ ...fakeChart, points: [] })
    const app = createApp()
    const res = await app.request(
      '/dashboard/charts?tab=symbol&symbol=SOXL&partial=1',
      { headers: authHeader },
      { ...baseEnv, DB: fakeChartsDb() },
    )
    const body = await res.text()
    expect(body).toContain('この銘柄にはまだ判定ログ')
    expect(body).not.toContain('__chartData')
  })
})
