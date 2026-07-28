import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { loadPortfolioEquitySnapshots } from '../../src/infrastructure/db/portfolioEquitySnapshotRepo'
import { loadUsdJpyRate } from '../../src/infrastructure/quotes/fxRate'
import { loadRecentAlerts } from '../../src/infrastructure/notification/notificationEmitLog'
import { resolveActiveNavGroup } from '../../src/routes/dashboard/layout'
import { tradesBody } from '../../src/routes/dashboard/trades'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

/**
 * #dashboard-ia — 情報アーキテクチャ再編のスモーク。
 *
 * 1. グローバル nav: 日常 3 画面 (ホーム / 銘柄 / レビュー) + 管理 ▾ + 診断 ▾。
 *    判定ログ・アラート・監査・broker 診断・token は診断へ降格 (削除はしない)。
 * 2. レビュー subnav: 約定履歴 / 成績 / 実現損益の推移。診断ページは診断 subnav。
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

  it('renders 3 日常画面 + 管理 / 診断 dropdown (positions/portfolio are not in the nav)', async () => {
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
    expect(nav).toContain('>レビュー</a>')
    // 管理 / 診断ドロップダウン (kill switch と同じ details パターン)
    expect(nav).toContain('<details class="topnav-ops">')
    expect(nav).toContain('管理 ▾')
    expect(nav).toContain('診断 ▾')
    // 管理 = 書き込みを伴う画面だけ
    for (const href of ['/dashboard/config', '/dashboard/symbols', '/dashboard/events']) {
      expect(nav).toContain(`href="${href}"`)
    }
    // 診断 = 障害時にだけ開く画面 (降格しても消さない)
    for (const href of [
      '/dashboard/alerts',
      '/dashboard/cron',
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

  it('activates レビュー for /trades and /charts (quality / equity)', async () => {
    const app = createApp()
    for (const path of ['/dashboard/trades', '/dashboard/charts?tab=quality', '/dashboard/charts']) {
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

  it('activates 管理 / 診断 summary on their pages, and redirects the retired pages', async () => {
    const app = createApp()
    const opsRes = await app.request('/dashboard/config', { headers: authHeader }, baseEnv)
    expect(await opsRes.text()).toContain('<summary class="nav-link active">管理 ▾</summary>')
    const diagRes = await app.request('/dashboard/cron', { headers: authHeader }, baseEnv)
    expect(await diagRes.text()).toContain('診断 ▾</summary>')
    // #dashboard-ia Phase 5: /positions /portfolio はホームへ統合済み → 302
    for (const path of ['/dashboard/positions', '/dashboard/portfolio']) {
      const res = await app.request(path, { headers: authHeader }, baseEnv)
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location'), path).toBe('/dashboard')
    }
  })

  it('resolveActiveNavGroup: charts はタブで 銘柄 / レビュー に分かれ、診断系は diag', () => {
    expect(resolveActiveNavGroup('/dashboard')).toBe('home')
    expect(resolveActiveNavGroup('/dashboard/charts', 'symbol')).toBe('symbol')
    expect(resolveActiveNavGroup('/dashboard/charts', 'grid')).toBe('symbol')
    expect(resolveActiveNavGroup('/dashboard/charts', 'quality')).toBe('review')
    expect(resolveActiveNavGroup('/dashboard/charts', null)).toBe('review')
    expect(resolveActiveNavGroup('/dashboard/trades')).toBe('review')
    expect(resolveActiveNavGroup('/dashboard/cron')).toBe('diag')
    expect(resolveActiveNavGroup('/dashboard/alerts')).toBe('diag')
    expect(resolveActiveNavGroup('/dashboard/audit')).toBe('diag')
    expect(resolveActiveNavGroup('/dashboard/webull-token')).toBe('diag')
    expect(resolveActiveNavGroup('/dashboard/symbols/SOXL/edit')).toBe('ops')
    expect(resolveActiveNavGroup('/dashboard/positions')).toBeNull()
    expect(resolveActiveNavGroup('/dashboard/portfolio')).toBeNull()
  })
})

describe('dashboard IA — レビュー / 診断 subnav (#dashboard-ia)', () => {
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
    for (const href of ['/dashboard/charts?tab=quality', '/dashboard/charts']) {
      expect(body).toContain(`href="${href}"`)
    }
    expect(body).toContain('実現損益の推移')
    // 判定ログ / アラートはレビュー subnav からは外れる (診断側へ)
    expect(body).not.toContain('<a class="subnav-link" href="/dashboard/cron">')
    expect(body).not.toContain('<a class="subnav-link" href="/dashboard/alerts">')
  })

  it('cron page activates 判定ログ (診断 subnav)', async () => {
    const app = createApp()
    const cronBody = await (
      await app.request('/dashboard/cron', { headers: authHeader }, baseEnv)
    ).text()
    expect(cronBody).toContain('<span class="subnav-link active">判定ログ</span>')
    // 判定マトリクスは廃止 (#dashboard-ia)
    expect(cronBody).not.toContain('判定マトリクス')
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
    expect(body).toContain('>成績<')
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

  it('renders 運転状態帯 + 3 領域 (リスクと建玉 / 最近の活動) when DOs are bound', async () => {
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
    // 1. 運転状態帯 (常時表示。実行モードと取引状態は隠せない)
    expect(body).toContain('実行モード')
    expect(body).toContain('株価の鮮度')
    expect(body).toContain('取引 ON')
    expect(body).toContain('最終 cron')
    expect(body).toContain('未確認アラート')
    // 2. 領域見出し
    expect(body).toContain('リスクと建玉')
    expect(body).toContain('最近の活動')
    // 3. リスクと建玉 (KPI / 資産構成を畳んだ 1 枚)
    expect(body).toContain('建玉')
    expect(body).toContain('実効 stop は ATR と R:R 上限')
    // 4. 直近の約定 + 導線リンク
    expect(body).toContain('直近の約定')
    expect(body).toContain('href="/dashboard/trades"')
    expect(body).toContain('href="/dashboard/cron"')
    expect(body).toContain('href="/dashboard/alerts"')
  })

  it('home inline scripts parse without syntax errors', async () => {
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

  it('DO 不在でも運転状態帯は出し、建玉パネルは理由を出す (graceful)', async () => {
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
    // SYMBOL_STATE 不在 → 建玉テーブルは出さず理由だけ出す
    expect(body).toContain('SYMBOL_STATE 未配線')
    // 運転状態帯は DO 不在でも出る (実行モード / 取引は D1 由来)
    expect(body).toContain('実行モード')
    expect(body).toContain('未確認アラート')
  })
})

describe('dashboard IA — CodeRabbit #559 対応', () => {
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

  it('スナップショット取得は range 用の 1 回だけ (スパークライン廃止で二重取得なし)', async () => {
    const env = {
      ...baseEnv,
      DB: fakeD1(),
      SYMBOL_STATE: fakeSymbolStateNamespace(),
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard?range=30d', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    // スパークライン廃止で二重取得は無くなった (range 用の 1 回だけ)
    expect(vi.mocked(loadPortfolioEquitySnapshots)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(loadPortfolioEquitySnapshots)).toHaveBeenCalledWith(env.DB, { limit: 30 })
    expect(body).not.toContain('id="home-equity-spark"')
  })

  it('既定 range (90d) でも取得は 1 回だけ', async () => {
    const env = {
      ...baseEnv,
      DB: fakeD1(),
      SYMBOL_STATE: fakeSymbolStateNamespace(),
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    expect(vi.mocked(loadPortfolioEquitySnapshots)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(loadPortfolioEquitySnapshots)).toHaveBeenCalledWith(env.DB, { limit: 90 })
  })

  it('資産推移チャートを含む領域が出ても ECharts CDN script タグは 1 個に畳まれる', async () => {
    const env = {
      ...baseEnv,
      DB: fakeD1(),
      SYMBOL_STATE: fakeSymbolStateNamespace(),
      PORTFOLIO_STATE: fakePortfolioNamespace(),
    }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    const body = await res.text()
    const cdnTags = body.match(/<script src="[^"]*echarts[^"]*" defer><\/script>/g) ?? []
    expect(cdnTags.length).toBe(1)
  })
})

// #dashboard-ia: 幅の上限は **ホームだけ**。銘柄チャートや判定マトリクスに
// 効かせると、チャートがはみ出したりテーブルのヘッダが 1 文字ずつ折り返す。
describe('dashboard 幅の上限はホーム限定 (#dashboard-ia)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
    vi.mocked(loadPortfolioEquitySnapshots).mockResolvedValue([])
    vi.mocked(loadUsdJpyRate).mockResolvedValue(150.25)
  })
  afterEach(() => vi.resetAllMocks())

  // 読み幅の上限は全ページ共通 (1160px)。列幅ルールは table.fit の opt-in なので
  // main-narrow は現状ホームの marker として残るのみ (幅は変えない)。
  it('ホームだけ main-narrow が付く (marker、幅は全ページ共通)', async () => {
    const app = createApp()
    const home = await (await app.request('/dashboard', { headers: authHeader }, baseEnv)).text()
    expect(home).toContain('class="main main-narrow"')

    for (const path of ['/dashboard/trades', '/dashboard/charts?tab=symbol', '/dashboard/cron']) {
      const body = await (await app.request(path, { headers: authHeader }, baseEnv)).text()
      // CSS 定義自体は全ページに inline されるので、class 属性で判定する
      expect(body, path).toContain('class="main"')
      expect(body, path).not.toContain('class="main main-narrow"')
    }
  })
})

// 列幅は「役割」で決める (#dashboard-ia)。1 行 1 レコードで読ませる表は
// table.fit を付け、余りを吸う列だけ grow を持つ。短い列 (状態 / 数量 / 単価)
// に幅が回ると値が縦に折り返す。
describe('table.fit の列ルール (#dashboard-ia)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolCurrency: { SOXL: 'USD' } }),
    )
  })
  afterEach(() => vi.resetAllMocks())

  // 日時〜実現損益は折り返し禁止。余りを吸って折り返してよいのは 状態 (エラー文)。
  it('約定履歴は table.fit + 状態列が grow (銘柄は折り返さない)', () => {
    // route ではなく renderer を直接叩く (loader の fake を用意するより堅い)
    const html = tradesBody(
      [
        {
          id: 1,
          timestamp: '2026-07-28T00:00:00.000Z',
          tradeEventType: 'post_submit',
          symbol: 'SOXL',
          side: 'BUY',
          filledQty: 1,
          filledPrice: 100,
          limitPrice: 100,
          notional: 100,
          realizedPnl: null,
          brokerStatus: 'FILLED',
          mode: 'LIVE',
        } as unknown as Parameters<typeof tradesBody>[0][number],
      ],
      50,
    )
    expect(html).toContain('<table class="fit">')
    expect(html).toContain('<th class="grow">状態</th>')
    // 銘柄は折り返さない (grow を持たない) → ticker のみ表示で列幅も暴れない
    expect(html).not.toContain('<th class="grow">銘柄</th>')
    expect(html).toContain('<strong>SOXL</strong>')
  })
})
