import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { loadPortfolioEquitySnapshots } from '../../src/infrastructure/db/portfolioEquitySnapshotRepo'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/portfolioEquitySnapshotRepo', () => ({
  loadPortfolioEquitySnapshots: vi.fn(),
}))

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}

const authHeader = {}

function fakePortfolioNamespace() {
  const stub = {
    async getPortfolio() {
      return {
        dailyStartEquity: 10000,
        dailyRealizedPnl: -50,
        tradingDisabledUntil: null,
        lastRolledAt: '2026-05-16T00:00:00.000Z',
        updatedAt: '2026-05-16T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: () => 'id',
    get: () => stub,
  } as unknown
}

describe('/dashboard/portfolio equity chart', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }))
  })
  afterEach(() => vi.resetAllMocks())

  it('renders the chart container + payload when snapshots exist', async () => {
    vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([
      {
        id: 1,
        snapshotAt: '2026-05-14T00:00:00.000Z',
        dailyStartEquityUsd: 10000,
        dailyStartEquityJpy: null,
        dailyRealizedPnlUsd: 0,
        dailyRealizedPnlJpy: null,
        drawdownPct: null,
        requestId: null,
      },
      {
        id: 2,
        snapshotAt: '2026-05-15T00:00:00.000Z',
        dailyStartEquityUsd: 10500,
        dailyStartEquityJpy: 1_500_000,
        dailyRealizedPnlUsd: 500,
        dailyRealizedPnlJpy: 10000,
        drawdownPct: 0.05,
        requestId: 'req-1',
      },
    ])
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('総資産チャート')
    expect(body).toContain('id="portfolio-equity-chart"')
    expect(body).toContain('window.__equityChartData')
    // Both USD and JPY series should be flagged on at least one row.
    expect(body).toContain('"hasUsd":true')
    expect(body).toContain('"hasJpy":true')
    // Range tabs for the chart.
    expect(body).toContain('/dashboard/portfolio?range=30d')
    expect(body).toContain('/dashboard/portfolio?range=90d')
    expect(body).toContain('/dashboard/portfolio?range=365d')
    expect(body).toContain('/dashboard/portfolio?range=all')
  })

  it('shows the "no data" message and no chart container when there are no snapshots', async () => {
    vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([])
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('総資産チャート')
    expect(body).toContain('まだ roll-daily 実行履歴がありません')
    expect(body).not.toContain('id="portfolio-equity-chart"')
  })

  it('falls back to default range when ?range= is invalid', async () => {
    const spy = vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([])
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio?range=garbage', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    // default = 90d → limit = 90
    expect(spy).toHaveBeenCalledWith({}, { limit: 90 })
    const body = await res.text()
    // The 90d tab should be active.
    expect(body).toMatch(/class="tab tab-active"[^>]*href="\/dashboard\/portfolio\?range=90d"/)
  })

  it('honours ?range=all by lifting the snapshot limit', async () => {
    const spy = vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([])
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio?range=all', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledWith({}, { limit: 3650 })
  })

  it('survives a snapshot-load failure with the rest of the page intact', async () => {
    vi.mocked(loadPortfolioEquitySnapshots).mockRejectedValue(new Error('table missing'))
    const env = {
      ...baseEnv,
      DB: {} as D1Database,
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard/portfolio', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    // Summary table still rendered.
    expect(body).toContain('dailyStartEquity')
    // Chart degrades to the "no data" message rather than blowing up the page.
    expect(body).toContain('まだ roll-daily 実行履歴がありません')
  })
})
