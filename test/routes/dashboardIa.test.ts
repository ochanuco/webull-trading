import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { loadPortfolioEquitySnapshots } from '../../src/infrastructure/db/portfolioEquitySnapshotRepo'
import { loadUsdJpyRate } from '../../src/infrastructure/quotes/fxRate'
import { loadRecentAlerts } from '../../src/infrastructure/notification/notificationEmitLog'
import { resolveActiveNavGroup } from '../../src/routes/dashboard/layout'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

/**
 * #dashboard-ia — 情報アーキテクチャ再編のスモーク。
 *
 * 1. グローバル nav: 13 リンクのフラット並び → 4 項目 (ホーム / 銘柄 /
 *    履歴・分析 / 運用ドロップダウン) + グループ単位の前方一致 active。
 * 2. 履歴・分析 subnav: trades / cron / alerts の 3 ページに共通 subnav。
 * 3. ホーム統合: 資産サマリ帯 + スパークライン + 保有ポジション (DO あり /
 *    なしの graceful degrade)。
 */

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/portfolioEquitySnapshotRepo', () => ({
  loadPortfolioEquitySnapshots: vi.fn(),
}))
vi.mock('../../src/infrastructure/quotes/fxRate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infrastructure/quotes/fxRate')>()),
  loadUsdJpyRate: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/globalConfigRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/infrastructure/db/globalConfigRepo')>()),
  loadOverviewPanelsCsv: vi.fn(async () => ''),
}))
vi.mock('../../src/infrastructure/notification/notificationEmitLog', () => ({
  loadRecentAlerts: vi.fn(),
}))

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }
const authHeader = {}

/** D1 直叩き loader (loadRecentFills 等) 用の空返し fake。 */
function fakeD1(): D1Database {
  const stmt = {
    bind() {
      return stmt
    },
    async all() {
      return { results: [] }
    },
    async first() {
      return null
    },
    async run() {
      return { success: true }
    },
    async raw() {
      return []
    },
  }
  return {
    prepare: () => stmt,
    batch: async () => [],
  } as unknown as D1Database
}

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

function fakePortfolioNamespace() {
  const stub = {
    async getPortfolio() {
      return {
        dailyStartEquity: 10000,
        dailyRealizedPnl: -50,
        openExposureUsd: 1200,
        openExposureJpy: 0,
        tradingDisabledUntil: null,
        lastRolledAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: () => 'id',
    get: () => stub,
  } as unknown
}

const sparkRows = [
  {
    id: 1,
    snapshotAt: '2026-06-30T00:00:00.000Z',
    dailyStartEquityUsd: 10000,
    dailyStartEquityJpy: null,
    dailyRealizedPnlUsd: 0,
    dailyRealizedPnlJpy: null,
    drawdownPct: null,
    requestId: null,
  },
  {
    id: 2,
    snapshotAt: '2026-07-01T00:00:00.000Z',
    dailyStartEquityUsd: 10100,
    dailyStartEquityJpy: null,
    dailyRealizedPnlUsd: 100,
    dailyRealizedPnlJpy: null,
    drawdownPct: 0.01,
    requestId: null,
  },
]

describe('dashboard IA — global nav (#dashboard-ia)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
    vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([])
    vi.mocked(loadUsdJpyRate).mockResolvedValue(150.25)
  })
  afterEach(() => vi.resetAllMocks())

  it('renders 4 groups + 運用 dropdown (positions/portfolio are not in the nav)', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    // 最初の <nav> (class 無し) がグローバル nav
    const nav = body.match(/<nav>[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(nav).toContain('href="/dashboard"')
    expect(nav).toContain('>ホーム</a>')
    expect(nav).toContain('href="/dashboard/charts?tab=symbol"')
    expect(nav).toContain('>銘柄</a>')
    expect(nav).toContain('href="/dashboard/trades"')
    expect(nav).toContain('>履歴・分析</a>')
    // 運用ドロップダウン (kill switch と同じ details パターン)
    expect(nav).toContain('<details class="topnav-ops">')
    expect(nav).toContain('運用 ▾')
    for (const href of [
      '/dashboard/config',
      '/dashboard/symbols',
      '/dashboard/events',
      '/dashboard/audit',
      '/dashboard/broker-probe',
      '/dashboard/webull-token',
    ]) {
      expect(nav).toContain(`href="${href}"`)
    }
    // 資産系はホームに統合 → nav から外れる (URL 直アクセスは維持)
    expect(nav).not.toContain('href="/dashboard/positions"')
    expect(nav).not.toContain('href="/dashboard/portfolio"')
    // ホームが active
    expect(nav).toContain('class="nav-link active" href="/dashboard"')
  })

  it('activates 履歴・分析 for /trades /cron /alerts and /charts?tab=quality (group prefix match)', async () => {
    const app = createApp()
    for (const path of [
      '/dashboard/trades',
      '/dashboard/cron',
      '/dashboard/alerts',
      '/dashboard/charts?tab=quality',
      '/dashboard/charts',
    ]) {
      const res = await app.request(path, { headers: authHeader }, baseEnv)
      const body = await res.text()
      expect(body, path).toContain('class="nav-link active" href="/dashboard/trades"')
    }
  })

  it('activates 銘柄 for /charts?tab=symbol and ?tab=grid', async () => {
    const app = createApp()
    for (const path of ['/dashboard/charts?tab=symbol', '/dashboard/charts?tab=grid']) {
      const res = await app.request(path, { headers: authHeader }, baseEnv)
      const body = await res.text()
      expect(body, path).toContain('class="nav-link active" href="/dashboard/charts?tab=symbol"')
    }
  })

  it('activates 運用 summary on ops pages, and nothing on nav-less pages (/positions)', async () => {
    const app = createApp()
    const opsRes = await app.request('/dashboard/config', { headers: authHeader }, baseEnv)
    expect(await opsRes.text()).toContain('<summary class="nav-link active">運用 ▾</summary>')
    // /positions は nav 外の直アクセスページ → どのグループも active にしない
    const posRes = await app.request('/dashboard/positions', { headers: authHeader }, baseEnv)
    expect(posRes.status).toBe(200)
    expect(await posRes.text()).not.toContain('nav-link active')
  })

  it('resolveActiveNavGroup: charts はタブで 銘柄 / 履歴・分析 に分かれる', () => {
    expect(resolveActiveNavGroup('/dashboard')).toBe('home')
    expect(resolveActiveNavGroup('/dashboard/charts', 'symbol')).toBe('symbol')
    expect(resolveActiveNavGroup('/dashboard/charts', 'grid')).toBe('symbol')
    expect(resolveActiveNavGroup('/dashboard/charts', 'quality')).toBe('analysis')
    expect(resolveActiveNavGroup('/dashboard/charts', null)).toBe('analysis')
    expect(resolveActiveNavGroup('/dashboard/cron')).toBe('analysis')
    expect(resolveActiveNavGroup('/dashboard/symbols/SOXL/edit')).toBe('ops')
    expect(resolveActiveNavGroup('/dashboard/positions')).toBeNull()
    expect(resolveActiveNavGroup('/dashboard/portfolio')).toBeNull()
  })
})

describe('dashboard IA — 履歴・分析 subnav (#dashboard-ia)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
  })
  afterEach(() => vi.resetAllMocks())

  it('trades page renders the shared subnav with 約定履歴 active', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/trades', { headers: authHeader }, baseEnv)
    const body = await res.text()
    expect(body).toContain('<nav class="subnav">')
    expect(body).toContain('<span class="subnav-link active">約定履歴</span>')
    for (const href of [
      '/dashboard/cron',
      '/dashboard/cron?view=matrix',
      '/dashboard/charts?tab=quality',
      '/dashboard/charts',
      '/dashboard/alerts',
    ]) {
      expect(body).toContain(`href="${href}"`)
    }
    expect(body).toContain('資産推移')
  })

  it('cron page activates 戦略判定, matrix view activates 判定マトリクス', async () => {
    const app = createApp()
    const cronBody = await (
      await app.request('/dashboard/cron', { headers: authHeader }, baseEnv)
    ).text()
    expect(cronBody).toContain('<span class="subnav-link active">戦略判定</span>')
    const matrixBody = await (
      await app.request('/dashboard/cron?view=matrix', { headers: authHeader }, baseEnv)
    ).text()
    expect(matrixBody).toContain('<span class="subnav-link active">判定マトリクス</span>')
  })

  it('alerts page activates アラート', async () => {
    vi.mocked(loadRecentAlerts).mockResolvedValue([])
    const app = createApp()
    const res = await app.request(
      '/dashboard/alerts',
      { headers: authHeader },
      { ...baseEnv, DB: fakeD1() },
    )
    const body = await res.text()
    expect(body).toContain('<span class="subnav-link active">アラート</span>')
  })

  it('charts page keeps its own subnav only (no double subnav)', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/charts?tab=quality',
      { headers: authHeader },
      baseEnv,
    )
    const body = await res.text()
    expect((body.match(/<nav class="subnav">/g) ?? []).length).toBe(1)
    // charts 自前 subnav の active (title 付き span) が出ている
    expect(body).toContain('class="subnav-link active"')
    expect(body).toContain('>取引品質<')
  })
})

describe('dashboard IA — home integration (#dashboard-ia)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: true }),
    )
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
    vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue(sparkRows)
    vi.mocked(loadUsdJpyRate).mockResolvedValue(150.25)
  })
  afterEach(() => vi.resetAllMocks())

  it('renders 資産サマリ帯 + スパークライン + 保有ポジション + 直近パネル when DOs are bound', async () => {
    const env = {
      ...baseEnv,
      DB: fakeD1(),
      SYMBOL_STATE: fakeSymbolStateNamespace(),
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    // 1. 資産サマリ帯 (portfolio 要約の横並びカード)
    expect(body).toContain('資産サマリ')
    expect(body).toContain('本日開始 equity')
    expect(body).toContain('本日実現損益')
    expect(body).toContain('取引 ON')
    expect(body).toContain('USDJPY')
    expect(body).toContain('150.25')
    // 2. equity スパークライン (直近 30 日)
    expect(body).toContain('id="home-equity-spark"')
    expect(body).toContain('window.__homeEquitySpark')
    // 3. 保有ポジション (positions と同じテーブル)
    expect(body).toContain('保有ポジション')
    expect(body).toContain('SOXL')
    expect(body).toContain('平均取得単価')
    // 4. 既存パネル (直近の約定 / リスク状態) + 導線リンク
    expect(body).toContain('最近の約定 / リスク状態')
    expect(body).toContain('href="/dashboard/portfolio"')
    expect(body).toContain('href="/dashboard/positions"')
    expect(body).toContain('href="/dashboard/cron"')
    expect(body).toContain('href="/dashboard/alerts"')
    // スパークラインは 30d 固定で別途 load される
    expect(vi.mocked(loadPortfolioEquitySnapshots)).toHaveBeenCalledWith(env.DB, { limit: 30 })
  })

  it('home inline scripts (sparkline 含む) parse without syntax errors', async () => {
    const env = {
      ...baseEnv,
      DB: fakeD1(),
      SYMBOL_STATE: fakeSymbolStateNamespace(),
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    const body = await res.text()
    const blocks = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(blocks.length).toBeGreaterThan(0)
    for (const code of blocks) {
      expect(() => new Function(code)).not.toThrow()
    }
  })

  it('omits 資産サマリ帯 and shows positions guidance link when DOs are missing (graceful)', async () => {
    vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([])
    const env = { ...baseEnv, DB: fakeD1() }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    // PORTFOLIO_STATE 不在 → 帯ごと省略 + USDJPY fetch も省略
    expect(body).not.toContain('本日開始 equity')
    expect(body).not.toContain('home-equity-spark')
    expect(vi.mocked(loadUsdJpyRate)).not.toHaveBeenCalled()
    // SYMBOL_STATE 不在 → テーブル省略 + /positions への誘導リンク
    expect(body).toContain('SYMBOL_STATE 未配線')
    expect(body).toContain('href="/dashboard/positions"')
  })
})
