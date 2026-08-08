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
  ACCESS_DEV_BYPASS_USER: 'admin',
}

const unauthEnv = {}

const authHeader = {}

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

  it('401s without Access JWT', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', {}, unauthEnv)
    expect(res.status).toBe(401)
  })

  it('serves the index landing page', async () => {
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<title>ダッシュボード')
    // #dashboard-ia: nav は 4 項目に削減 (positions/portfolio はホーム統合で
    // nav から外れたため、代わりに再編後のグローバル nav を検証)
    expect(body).toContain('href="/dashboard/charts?tab=symbol"')
    expect(body).toContain('href="/dashboard/trades"')
    expect(body).toContain('管理 ▾')
    expect(body).toContain('診断 ▾')
  })

  // #276: kill-switch は全 page 共通でサイドバー下部に表示される (banner → sidebar
  // へ配置変更)。DB binding がある時のみ表示、effective=true なら「停止」、
  // false なら「再開」(confirm 付き) ボタンが出る。
  it('renders kill-switch banner with 取引停止 button when tradingEnabled=true', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: true }),
    )
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('取引 ON (有効)')
    expect(body).toContain('取引停止')
    expect(body).toContain('action="/admin/trading/toggle"')
    expect(body).toContain('name="enabled" value="false"')
  })

  it('renders kill-switch banner with 取引再開 + confirm() when tradingEnabled=false', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: false }),
    )
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('取引 OFF (停止中)')
    expect(body).toContain('取引再開')
    // 再開 は誤操作防止に HTML confirm()
    expect(body).toContain('onsubmit="return confirm(')
    expect(body).toContain('name="enabled" value="true"')
  })

  it('shows env override warning + disables buttons when env TRADING_ENABLED=false overrides DB=true', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: true }),
    )
    const env = { ...baseEnv, DB: {} as D1Database, TRADING_ENABLED: 'false' }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    // env override 適用後の effective は OFF
    expect(body).toContain('取引 OFF (停止中)')
    // env override note が出る
    expect(body).toContain('env TRADING_ENABLED で deploy-gate ON')
    // button は disabled
    expect(body).toMatch(/<button[^>]*disabled[^>]*>取引再開<\/button>/)
  })

  // グローバルメニュー上部化: 全 page 共通 shell は上部バー (topnav)。
  // kill switch は上部バー右端の badge + ドロップダウン (details) に入る。
  it('renders global menu as top bar with kill-switch dropdown (no left sidebar)', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: true }),
    )
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).toContain('<header class="header">')
    expect(body).toContain('class="topnav"')
    expect(body).toContain('class="topnav-killswitch"')
    // 旧左サイドバーは無い
    expect(body).not.toContain('class="sidebar"')
    // nav link は維持 (ホーム / 銘柄管理 など)
    expect(body).toContain('href="/dashboard/symbols"')
    // ページタイトル h1 は出さない (nav の active 強調で現在地が分かるため冗長)
    expect(body).not.toContain('page-title')
  })

  // チャートの view 切替 (概要/成績/個別銘柄) は本文 tab strip
  // ではなく header 2段目の subnav に出す (サブメニュー化)。
  it('charts overview/quality pages share the レビュー subnav (#remove-grid)', async () => {
    const app = createApp()
    // DB 未バインドでも subnav は出る (本文は unavailable)
    const res = await app.request(
      '/dashboard/charts?tab=quality',
      { headers: authHeader },
      baseEnv,
    )
    const body = await res.text()
    expect(body).toContain('<nav class="subnav">')
    // 約定履歴と同じ「レビュー」subnav に統一 (現在地 = 成績)
    expect(body).toContain('>成績</span>')
    expect(body).toContain('class="subnav-link active"')
    expect(body).toContain('href="/dashboard/trades"')
    // 旧チャート専用 subnav (個別銘柄 / 銘柄グリッド) は出さない
    // (グローバル nav の「銘柄」リンクは tab=symbol を持つので subnav 内のみ検査)
    expect(body).not.toContain('銘柄グリッド')
    const subnavHtml = body.match(/<nav class="subnav">([\s\S]*?)<\/nav>/)?.[1] ?? ''
    expect(subnavHtml).not.toContain('tab=symbol')
  })


  it('GET /dashboard/symbols/:symbol redirects to chart symbol tab', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/symbols/soxl', { headers: authHeader }, baseEnv)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard/charts?tab=symbol&symbol=SOXL')
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

  it('renders config page with global_config + symbol table', async () => {
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('global_config')
    expect(body).toContain('SOXL')
  })

  // #dashboard-mf-layout: overview パネル ON/OFF フォーム。createDb mock 未設定 →
  // loadOverviewPanelsCsv が default fallback → 全パネル checked で描画
  // (#dashboard-ia で status / positions が additive に増え 6 パネル)。
  it('renders overview panel toggle form on config page (all checked by default)', async () => {
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    const body = await res.text()
    expect(body).toContain('action="/dashboard/config/overview-panels"')
    for (const k of ALL_OVERVIEW_PANELS) {
      expect(body).toContain(`value="${k}"`)
    }
    expect((body.match(/name="panels"[^>]*checked/g) ?? []).length).toBe(ALL_OVERVIEW_PANELS.length)
  })

  it('saves overview panel selection (303 redirect, CSV deduped + invalid dropped)', async () => {
    let storedCsv: string | undefined
    let insertedValues: Record<string, unknown> | undefined
    // setOverviewPanels は db.batch([select(before), insert().values().onConflictDoUpdate()])。
    // select/insert は batch に渡す statement を組むだけ (mock では空 obj)、実 read は batch が返す。
    // batch 呼び出し自体を spy して原子更新 (read→write 退行) の回帰ガードにする。
    const batchSpy = vi.fn(async (_stmts: unknown[]) => [[{ value: 'risk,activity' }], {}])
    vi.mocked(createDb).mockReturnValue({
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({}) }) }) }),
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          insertedValues = vals
          return {
            onConflictDoUpdate: (cfg: { set: { overviewPanels: string } }) => {
              storedCsv = cfg.set.overviewPanels
              return {}
            },
          }
        },
      }),
      batch: batchSpy,
    } as unknown as ReturnType<typeof createDb>)
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request(
      '/dashboard/config/overview-panels',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
          ['panels', 'risk'],
          ['panels', 'activity'],
          ['panels', 'risk'],
          ['panels', 'bogus'],
        ]).toString(),
      },
      env,
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/config')
    expect(storedCsv).toBe('risk,activity')
    // upsert の insert 部の payload も検証 (初回作成時に正しい行が入る)。
    expect(insertedValues).toMatchObject({ id: 'default', overviewPanels: 'risk,activity' })
    expect(typeof insertedValues?.updatedAt).toBe('string')
    // 原子更新の回帰ガード: 1 回の batch に before-read + upsert の 2 statement。
    expect(batchSpy).toHaveBeenCalledTimes(1)
    expect((batchSpy.mock.calls[0]![0] as unknown[]).length).toBe(2)
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

  // inactive (active=0) 銘柄も config / picker / table に表示する (operator visibility)。
  // cron / risk gate の評価対象は変えない (= allowedSymbols のみ)。
  // "INACTIVE" naming: `inactiveSymbols` は disable / pause 双方を含むため
  // 中立的な "INACTIVE" を採用 (CodeRabbit #229)。
  it('renders inactive symbols on config page with grayed-out style and notes tooltip', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        inactiveSymbols: ['9697'],
        symbolCurrency: { SOXL: 'USD', '9697': 'JPY' },
        symbolMarket: { SOXL: 'US', '9697': 'JP' },
        symbolName: { '9697': 'カプコン' },
        symbolNotes: { '9697': 'liquidity dropped' },
      }),
    )
    const env = { ...baseEnv, DB: {} as D1Database }
    const app = createApp()
    const res = await app.request('/dashboard/config', { headers: authHeader }, env)
    const body = await res.text()
    // active 銘柄は通常表示、inactive 銘柄は symbol-disabled クラスで grayed-out
    expect(body).toContain('SOXL')
    expect(body).toContain('9697-カプコン')
    expect(body).toContain('class="symbol-disabled"')
    // tooltip に notes 表示 ("INACTIVE: <notes>" — pause も含むため中立 label)
    expect(body).toContain('INACTIVE: liquidity dropped')
    // 状態列に "inactive" が出る
    expect(body).toContain('>inactive<')
    // count 行に active / inactive 件数が出る
    expect(body).toContain('active 1 / inactive 1')
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
          decision: 'SKIP',
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
    expect(body).toContain('買付余力不足: 売買単位未満')
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

  it('renders the decision-trace ladder when trace_json is present (#decision-trace)', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeCronDb([
        {
          id: 200,
          timestamp: '2026-06-05T14:30:00.000Z', // ET 10:30 (場中) — session フィルタ既定 open を通す
          requestId: 'req-tr',
          symbol: 'TQQQ',
          decision: 'SKIP',
          reason: 'sizing rejected: lot-size-round',
          price: 76,
          indicatorsJson: '{"price":76}',
          clientOrderId: null,
          traceJson: JSON.stringify([
            { label: 'guard.pending_order_absent', label_ja: '発注中でない', passed: true },
            {
              label: 'sizing.quantity_positive',
              label_ja: '発注数量が1株/1単元以上ある',
              passed: false,
              actual: 0,
              operator: '>',
              threshold: 0,
              message: 'lot-size-round',
            },
          ]),
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

    expect(body).toContain('判定トレース')
    expect(body).toContain('trace-ladder')
    expect(body).toContain('発注中でない') // ✅ step
    expect(body).toContain('発注数量が1株/1単元以上ある') // ❌ deciding step
    expect(body).toContain('◀ 採用') // 採用された(最後の)ステップに矢印
    expect(body).toContain('lot-size-round') // message
    expect(body).toContain('tl-out-skip') // 出力ボックス (SKIP 色)
    expect(body).toContain('出力: <strong>SKIP</strong>')
  })

  it('omits the ladder when trace_json is null (graceful, pre-migration rows)', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeCronDb([
        {
          id: 201,
          timestamp: '2026-06-05T14:30:00.000Z', // ET 10:30 (場中) — session フィルタ既定 open を通す
          requestId: 'req-old',
          symbol: 'TQQQ',
          decision: 'HOLD',
          reason: 'holding',
          price: 76,
          indicatorsJson: null,
          clientOrderId: null,
          traceJson: null,
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
    // ラダー見出しは trace があるときだけ描画される (CSS class はスタイルに常駐するので
    // 見出し文字列で判定する)。
    expect(body).not.toContain('判定トレース')
    expect(body).not.toContain('◀ 採用')
  })

  it('exports a single cron decision JSON by decisionId', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeCronDb([
        {
          id: 868,
          timestamp: '2026-04-23T00:00:00.000Z',
          requestId: 'req-1',
          symbol: '7203',
          decision: 'SKIP',
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

  it('cron page requires Access JWT', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/cron', {}, unauthEnv)
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

  it('alerts page requires Access JWT', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/alerts', {}, unauthEnv)
    expect(res.status).toBe(401)
  })
})

import { parseOverviewPanels, ALL_OVERVIEW_PANELS } from '../../src/routes/dashboard'

describe('parseOverviewPanels', () => {
  it('parses a valid CSV into the panel set', () => {
    expect([...parseOverviewPanels('risk,activity')].sort()).toEqual(['activity', 'risk'])
  })
  it('ignores invalid tokens and whitespace', () => {
    expect([...parseOverviewPanels(' risk , bogus ')].sort()).toEqual(['risk'])
  })
  // #dashboard-ia Phase 3: 旧 6 パネルの CSV が保存済みでも設定を作り直させない。
  it('maps legacy panel keys onto the new areas', () => {
    expect([...parseOverviewPanels('risk,activity')].sort()).toEqual(['activity', 'risk'])
    expect([...parseOverviewPanels('positions,composition')].sort()).toEqual(['risk'])
    // status は運転状態へ畳まれ常時表示になったため、単独指定は全表示に倒す
    expect([...parseOverviewPanels('status')].sort()).toEqual(['activity', 'risk'])
  })
  it('empty / all-invalid / null / undefined → all panels (fallback)', () => {
    const all = [...ALL_OVERVIEW_PANELS].sort()
    expect([...parseOverviewPanels('')].sort()).toEqual(all)
    expect([...parseOverviewPanels('x,y')].sort()).toEqual(all)
    expect([...parseOverviewPanels(null)].sort()).toEqual(all)
    expect([...parseOverviewPanels(undefined)].sort()).toEqual(all)
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
      { date: '2026-04-23', counts: { BUY: 1, SELL: 0, HOLD: 5, SKIP: 0, REJECT: 2, ERROR: 0 } },
      { date: '2026-04-24', counts: { BUY: 0, SELL: 1, HOLD: 8, SKIP: 0, REJECT: 0, ERROR: 0 } },
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

  it('BUY のみ → 現保有 (qty は直近 BUY fill の qty、#charts-symbol-redesign Phase C)', () => {
    expect(deriveOpenPosition([buy('2026-04-23', 100)])).toEqual({
      avgPrice: 100,
      openedAt: '2026-04-23',
      qty: 1,
    })
  })

  it('BUY → SELL → 閉鎖済 (null)', () => {
    expect(deriveOpenPosition([buy('2026-04-23', 100), sell('2026-04-24', 105, 5)])).toBe(null)
  })

  it('BUY → SELL → BUY → 直近 BUY が現保有 (qty も直近 BUY 由来)', () => {
    const ms = [buy('2026-04-20', 100), sell('2026-04-21', 95, -5), buy('2026-04-23', 110)]
    expect(deriveOpenPosition(ms)).toEqual({ avgPrice: 110, openedAt: '2026-04-23', qty: 1 })
  })

  it('直近 BUY fill の qty が null なら position.qty も null', () => {
    const ms = [{ timestamp: '2026-04-23', side: 'BUY' as const, price: 100, qty: null, realizedPnl: null }]
    expect(deriveOpenPosition(ms)).toEqual({ avgPrice: 100, openedAt: '2026-04-23', qty: null })
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
  maxSma50DeviationPct: 0.6,
  maxAtrRatio: 1.5,
  maxStopToTpRatio: 2.0,
  reentryMinAtrBelowLastExit: 1.0,
  reentryGuardBusinessDays: 3,
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

  // 銘柄管理の override / role preset が効いている項目は global と異なる値に
  // なる。以前は global 値しか表示されず「銘柄管理で設定した値が出ない」見た目
  // バグがあった (operator 指摘) — effective 値 + 「銘柄別」タグの regression 防止。
  it('global を渡すと effective 値が表示され、global と異なる項目に「銘柄別」タグが付く', () => {
    const effective = { ...DEFAULT_PARAMS, stopPct: -0.05, takeProfitPct: 0.06 }
    const html = renderStrategyParamsPanel(effective, { ...DEFAULT_PARAMS })
    expect(html).toContain('-5.0%')
    expect(html).toContain('+6.0%')
    expect(html.match(/>銘柄別<\/span>/g)?.length).toBe(2) // stopPct / takeProfitPct の 2 行
    expect(html).toContain('この銘柄に適用される値')
  })

  it('global と全一致なら「銘柄別」タグは出ない (脚注の説明文のみ)', () => {
    const html = renderStrategyParamsPanel({ ...DEFAULT_PARAMS }, { ...DEFAULT_PARAMS })
    expect(html).not.toMatch(/>銘柄別<\/span>/)
    expect(html).toContain('「銘柄別」タグ')
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

import { selectLatestCronSnapshot } from '../../src/routes/dashboard'

describe('selectLatestCronSnapshot', () => {
  it('cron 履歴ありなら末尾 price/timestamp を返す (Yahoo filler を含めない)', () => {
    const cron: SymbolChartPoint[] = [
      { timestamp: '2026-04-23T05:00:00.000Z', price: 100, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-25T05:00:00.000Z', price: 110, sma50: null, high20d: null, low20d: null },
    ]
    expect(selectLatestCronSnapshot(cron)).toEqual({
      latestCronPrice: 110,
      latestCronTimestamp: '2026-04-25T05:00:00.000Z',
    })
  })

  it('空配列なら全 null (= preview 描画スキップ)', () => {
    expect(selectLatestCronSnapshot([])).toEqual({
      latestCronPrice: null,
      latestCronTimestamp: null,
    })
  })

  it('末尾 price が NaN なら全 null', () => {
    const cron: SymbolChartPoint[] = [
      { timestamp: '2026-04-25T05:00:00.000Z', price: Number.NaN, sma50: null, high20d: null, low20d: null },
    ]
    expect(selectLatestCronSnapshot(cron)).toEqual({
      latestCronPrice: null,
      latestCronTimestamp: null,
    })
  })

  it('末尾 timestamp が不正 ISO なら全 null', () => {
    const cron: SymbolChartPoint[] = [
      { timestamp: 'not-an-iso', price: 110, sma50: null, high20d: null, low20d: null },
    ]
    expect(selectLatestCronSnapshot(cron)).toEqual({
      latestCronPrice: null,
      latestCronTimestamp: null,
    })
  })

  it('複数 point の中間に 0 価格があっても末尾だけ判定する', () => {
    const cron: SymbolChartPoint[] = [
      { timestamp: '2026-04-23T05:00:00.000Z', price: 0, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-25T05:00:00.000Z', price: 110, sma50: null, high20d: null, low20d: null },
    ]
    expect(selectLatestCronSnapshot(cron).latestCronPrice).toBe(110)
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
      latestCronPrice: null,
      latestCronTimestamp: null,
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
      latestCronPrice: null, latestCronTimestamp: null,
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

import { renderPriceHeader, prevDailyClose } from '../../src/routes/dashboard'

describe('renderPriceHeader (Google Finance 風 価格ヘッダー)', () => {
  function fakeChartWith(
    points: SymbolChartPoint[],
    latestCronPrice: number | null = null,
  ): SymbolChartData {
    return {
      symbol: 'X', points, markers: [], position: null,
      rules: { pullbackMax: 0, pullbackMin: 0, stopPct: 0, takeProfitPct: 0, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
      latestCronPrice, latestCronTimestamp: null,
    }
  }
  const pt = (price: number, ind = false): SymbolChartPoint => ({
    timestamp: '2026-04-25T05:00:00.000Z',
    price,
    sma50: ind ? 60 : null,
    high20d: ind ? 105 : null,
    low20d: ind ? 90 : null,
  })

  it('chart null / points 空なら空文字', () => {
    expect(renderPriceHeader(null)).toBe('')
    expect(renderPriceHeader(fakeChartWith([]))).toBe('')
  })

  it('現在値を大きく + 前日比 (上昇=赤 ▲、日本式)', () => {
    const html = renderPriceHeader(fakeChartWith([pt(100), pt(102)]))
    expect(html).toContain('$102.00')
    expect(html).toContain('▲')
    expect(html).toContain('+2.00%')
    expect(html).toContain('(+2.00)')
    expect(html).toContain('#d23f31') // 上昇 = 赤
    expect(html).toContain('前日比')
  })

  it('下落は緑 ▼', () => {
    const html = renderPriceHeader(fakeChartWith([pt(100), pt(97)]))
    expect(html).toContain('▼')
    expect(html).toContain('-3.00%')
    expect(html).toContain('#188038') // 下落 = 緑
  })

  it('JPY 銘柄は ¥ + 整数表示', () => {
    const universe = makeSymbolUniverse({
      allowedSymbols: ['X'],
      symbolCurrency: { X: 'JPY' },
    })
    const html = renderPriceHeader(fakeChartWith([pt(1535), pt(1549)]), universe)
    expect(html).toContain('¥1,549')
    expect(html).not.toContain('¥1,549.00')
  })

  it('latestCronPrice があれば現在値として優先', () => {
    const html = renderPriceHeader(fakeChartWith([pt(100), pt(102)], 103.5))
    expect(html).toContain('$103.50')
  })

  it('points 1 点 (前日なし) は前日比を出さず価格のみ', () => {
    const html = renderPriceHeader(fakeChartWith([pt(120)]))
    expect(html).toContain('$120.00')
    expect(html).not.toContain('前日比')
  })

  it('サブ行に SMA50/high20d/low20d (最新の indicator 付き point から)', () => {
    const html = renderPriceHeader(fakeChartWith([pt(100, true), pt(110)]))
    expect(html).toContain('SMA50')
    expect(html).toContain('60.00')
    expect(html).toContain('high20d')
    expect(html).toContain('105.00')
  })

  it('prevDailyClose は最終 point の 1 つ前の price (2 点未満は null)', () => {
    expect(prevDailyClose(fakeChartWith([pt(100), pt(102)]))).toBe(100)
    expect(prevDailyClose(fakeChartWith([pt(100)]))).toBeNull()
    expect(prevDailyClose(null)).toBeNull()
  })
})

import {
  parseSymbolView,
  renderBuyabilityPanel,
  renderChartDecisionTrace,
  renderConclusionValue,
  renderDecisionPlotCaption,
  renderEffectiveRuleChips,
  renderJudgmentSummaryGrid,
  renderLatestDecisionValue,
  renderPositionSummaryValue,
  renderSymbolTab,
  renderSymbolViewSubnav,
  type ChartsBodySymbol,
  type DecisionRow,
  type SymbolChartDecision,
} from '../../src/routes/dashboard'
// 銘柄チャートタブの client 側初期化スクリプトは静的ファイル化されている
// (#charts-symbol-redesign)。`renderSymbolTab` の戻り値 (html) には
// `<script src=...>` の参照だけが乗るので、JS 内の文字列 (series 名 /
// click handler 名等) を検証するテストはこの定数を直接見る。
import { SYMBOL_CHART_CLIENT_SCRIPT } from '../../src/routes/dashboard/charts/symbolChartScript'
import { buildBuyabilityView, type EvalIndicatorPoint } from '../../src/trading/strategy/entryDistance'
import {
  TEST_DEFAULT_RULE,
  type PullbackIndicators,
} from '../../src/trading/strategy/strategies/PullbackUptrendStrategy'

// TEST_DEFAULT_RULE: band = high20d×[0.94, 0.97], sma50 floor。
function indFor(overrides: Partial<PullbackIndicators>): PullbackIndicators {
  return { price: 95, sma50: 90, return50d: 0.12, high20d: 100, atr20: 1, baselineAtr20: 1, ...overrides }
}

describe('renderChartDecisionTrace (チャート判定点クリック時のラダー HTML)', () => {
  it('trace があれば renderDecisionLadder のラダーを返す', () => {
    const trace = JSON.stringify([
      { label: 'guard.pending_order_absent', label_ja: '発注中でない', passed: true },
      {
        label: 'risk.overextension',
        label_ja: '過熱していない',
        passed: false,
        actual: 0.4,
        operator: '<=',
        threshold: 0.2,
      },
    ])
    const html = renderChartDecisionTrace(trace, 'REJECT', 'overextension guard')
    expect(html).toContain('判定トレース')
    expect(html).toContain('発注中でない')
    expect(html).toContain('過熱していない')
    expect(html).toContain('◀ 採用') // 最後のステップに採用矢印
    expect(html).toContain('tl-out-reject') // 出力ボックス (REJECT 色)
  })

  it('trace 無し (旧ログ) は出力ボックスのみのフォールバック (◀ 採用 なし)', () => {
    const html = renderChartDecisionTrace(null, 'REJECT', 'overextension guard')
    expect(html).toContain('トレースが保存されていません')
    expect(html).toContain('tl-out-reject')
    expect(html).toContain('出力: <strong>REJECT</strong>')
    expect(html).not.toContain('◀ 採用')
  })

  it('壊れた trace JSON もフォールバックに落ちる (throw しない)', () => {
    const html = renderChartDecisionTrace('not-json', 'ERROR', 'boom')
    expect(html).toContain('トレースが保存されていません')
    expect(html).toContain('tl-out-error')
  })
})

describe('renderDecisionPlotCaption (判定点プロットの凡例 + 件数)', () => {
  function chartWith(decisions: SymbolChartDecision[]): SymbolChartData {
    return {
      symbol: 'TQQQ',
      points: [{ timestamp: '2026-06-06T14:00:00.000Z', price: 80, sma50: null, high20d: null, low20d: null }],
      markers: [], position: null,
      rules: { pullbackMax: -0.03, pullbackMin: -0.15, stopPct: -0.08, takeProfitPct: 0.07, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
      latestCronPrice: null, latestCronTimestamp: null,
      decisions,
    }
  }
  const oneDecision: SymbolChartDecision = {
    id: 1, timestamp: '2026-06-06T14:00:00.000Z', price: 80,
    decision: 'SKIP', reason: 'overextension', ladderHtml: '<div>x</div>',
  }

  it('chart null / decisions 無し / 空配列なら空文字', () => {
    expect(renderDecisionPlotCaption(null)).toBe('')
    expect(renderDecisionPlotCaption(chartWith([]))).toBe('')
  })

  it('decisions があれば凡例 + HOLD 省略の説明を出す', () => {
    const html = renderDecisionPlotCaption(chartWith([oneDecision]))
    expect(html).toContain('買い (BUY)')
    expect(html).toContain('売り (SELL)')
    expect(html).toContain('見送り・bot判定 (SKIP)')
    expect(html).toContain('拒否・証券会社 (REJECT)')
    expect(html).toContain('エラー (ERROR)')
    expect(html).toContain('HOLD')
    expect(html).toContain('クリック')
  })

  it('上限 (250) に達したら truncation を明示 (silent cap を避ける)', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...oneDecision, id: i + 1 }))
    const html = renderDecisionPlotCaption(chartWith(many))
    expect(html).toContain('直近 250 件まで表示')
  })
})

describe('renderSymbolTab — 判定点 scatter + click-to-trace の配線', () => {
  const baseParams = {
    stopPct: -0.08, takeProfitPct: 0.07, timeStopDays: 10,
    pullbackMax: -0.03, pullbackMin: -0.15, minReturn50d: 0,
    requireAboveSma50: true, kAtr: 2,
    maxSma50DeviationPct: 0.6, maxAtrRatio: 1.5,
    maxStopToTpRatio: 2.0,
    reentryMinAtrBelowLastExit: 1.0, reentryGuardBusinessDays: 3,
  }
  function symbolArgs(
    decisions: SymbolChartDecision[],
    buyability?: ChartsBodySymbol['buyability'],
  ): ChartsBodySymbol {
    return {
      tab: 'symbol',
      focusSymbol: 'TQQQ',
      symbolChart: {
        symbol: 'TQQQ',
        points: [{ timestamp: '2026-06-06T14:00:00.000Z', price: 80, sma50: 70, high20d: 90, low20d: 60 }],
        markers: [], position: null,
        rules: { pullbackMax: -0.03, pullbackMin: -0.15, stopPct: -0.08, takeProfitPct: 0.07, timeStopDays: 10 },
        trendLine: null, intradayBars: [],
        latestCronPrice: 80, latestCronTimestamp: '2026-06-06T14:00:00.000Z',
        decisions,
      },
      availableSymbols: ['TQQQ'],
      strategyParams: baseParams,
      zoom: null,
      buyability: buyability ?? null,
    }
  }

  it('decisions があれば scatter series + trace panel + 埋込ラダーを配線する', () => {
    const html = renderSymbolTab(symbolArgs([
      {
        id: 1, timestamp: '2026-06-06T14:00:00.000Z', price: 80,
        decision: 'SKIP', reason: 'overextension',
        ladderHtml: '<div>LADDER_EMBED_MARKER</div>',
      },
    ]))
    // scatter series / click handler は静的ファイル化された client script 側
    // (#charts-symbol-redesign)。html はその参照 (<script src>) だけを持つ。
    expect(SYMBOL_CHART_CLIENT_SCRIPT).toContain("type: 'scatter'")
    expect(SYMBOL_CHART_CLIENT_SCRIPT).toContain("name: '判定'")
    expect(SYMBOL_CHART_CLIENT_SCRIPT).toContain('showDecisionTrace')
    expect(html).toContain('decision-trace-panel')
    // 各点の ladderHtml が payload に埋め込まれている (safeJsonScript で < は
    // < に escape されるが marker テキストは残る)
    expect(html).toContain('LADDER_EMBED_MARKER')
    // 凡例キャプションも出る
    expect(html).toContain('見送り・bot判定 (SKIP)')
    expect(html).toContain('拒否・証券会社 (REJECT)')
  })

  it('decisions が無ければ凡例は出ず payload も空 (scatter JS は静的に常駐 / runtime で 0 件描画)', () => {
    const html = renderSymbolTab(symbolArgs([]))
    // 凡例キャプションは decisions があるときだけ出す
    expect(html).not.toContain('見送り・bot判定 (SKIP)')
    // payload の decisions は空配列 (= runtime で scatter 0 点)
    expect(html).toContain('"decisions":[]')
    // placeholder パネルは常に描画
    expect(html).toContain('decision-trace-panel')
  })

  it('buyability があれば 入場パネル + 押し目ゾーン端の距離ラベルを配線する', () => {
    const view = buildBuyabilityView(
      [{ timestamp: '2026-06-06T14:00:00.000Z', indicators: indFor({ price: 99 }) }],
      TEST_DEFAULT_RULE,
    )
    const html = renderSymbolTab(symbolArgs([], view))
    expect(html).toContain('入場まで') // パネル headline
    // 入場ライン独立線は廃止 → 押し目ゾーン端に距離ラベルを載せる
    // (bandEdgeLabel の呼び出しは静的ファイル化された client script 側)
    expect(SYMBOL_CHART_CLIENT_SCRIPT).toContain("bandEdgeLabel('押し目上端'")
    expect(SYMBOL_CHART_CLIENT_SCRIPT).toContain("bandEdgeLabel('押し目下端'")
    expect(html).not.toContain('"entryLine"') // 独立 entryLine payload は無い
  })

  it('buyability が null なら projection も null', () => {
    const html = renderSymbolTab(symbolArgs([], null))
    expect(html).toContain('"projection":null')
  })

  // 銘柄レール (左固定): 旧 inline picker (「切替: <full name の列挙>」) を置換。
  it('銘柄レールを左に出し、focus は active / inactive は注記付きで識別する', () => {
    const universe = makeSymbolUniverse({
      allowedSymbols: ['TQQQ', 'SOXL'],
      inactiveSymbols: ['1570'],
      symbolName: { TQQQ: 'ProShares UltraPro QQQ', '1570': 'NF 日経レバ' },
      symbolNotes: { '1570': 'liquidity dropped' },
      symbolCurrency: { TQQQ: 'USD', SOXL: 'USD', '1570': 'JPY' },
    })
    const html = renderSymbolTab({
      ...symbolArgs([]),
      availableSymbols: ['TQQQ', 'SOXL', '1570'],
      universe,
    })
    expect(html).toContain('class="symbol-rail"')
    // focus (TQQQ) は active、ticker + 小さい銘柄名の縦リスト
    expect(html).toContain('class="rail-item active"')
    expect(html).toContain('<span class="rail-sym">TQQQ</span>')
    expect(html).toContain('<span class="rail-name">ProShares UltraPro QQQ</span>')
    // inactive (1570) は inactive class + tooltip 注記
    expect(html).toContain('class="rail-item inactive"')
    expect(html).toContain('INACTIVE: liquidity dropped')
    // 旧 inline picker の「| 切替:」は出ない
    expect(html).not.toContain('切替:')
    // active な focus も本文側に見出しを出す (注記なし)
    expect(html).toContain('銘柄: <strong>')
    expect(html).not.toContain('inactive —')
  })

  it('focus が inactive 銘柄の時は見出しに注記を付ける', () => {
    const universe = makeSymbolUniverse({
      allowedSymbols: ['SOXL'],
      inactiveSymbols: ['TQQQ'],
      symbolNotes: { TQQQ: 'paused for review' },
      symbolCurrency: { SOXL: 'USD', TQQQ: 'USD' },
    })
    const html = renderSymbolTab({
      ...symbolArgs([]),
      availableSymbols: ['SOXL', 'TQQQ'],
      universe,
    })
    expect(html).toContain('銘柄: <strong>')
    expect(html).toContain('inactive — paused for review')
  })

  // Google Finance 風: 前日終値を payload に載せ (チャートの点線基準)、
  // 価格ヘッダー (大きい現在値 + 前日比) を chart 上に出す。
  it('前日終値を payload に載せ、価格ヘッダーと range ピルを描画する', () => {
    const base = symbolArgs([])
    const html = renderSymbolTab({
      ...base,
      symbolChart: {
        ...base.symbolChart!,
        points: [
          { timestamp: '2026-06-05T14:00:00.000Z', price: 78, sma50: 70, high20d: 90, low20d: 60 },
          { timestamp: '2026-06-06T14:00:00.000Z', price: 80, sma50: 70, high20d: 90, low20d: 60 },
        ],
      },
    })
    expect(html).toContain('"prevClose":78')
    expect(html).toContain('前日終値 $78.00')
    // 現在値 (latestCronPrice=80) を大きく + 前日比 (上昇=赤)
    expect(html).toContain('$80.00')
    expect(html).toContain('前日比')
    // range ピルは chart container の直後 (chart-pin 内、チャート直下に出す)
    const chartIdx = html.indexOf('id="symbol-chart"')
    const pillIdx = html.indexOf('class="zoom-preset"')
    const panelIdx = html.indexOf('入場まで')
    expect(pillIdx).toBeGreaterThan(chartIdx)
    if (panelIdx >= 0) expect(pillIdx).toBeLessThan(panelIdx)
  })

  // チャートは sticky 固定 (入場ゲート説明 / 判定トレースとグラフを同時に見るため)
  it('チャートと指標バッジを sticky な symbol-chart-pin で包む', () => {
    const html = renderSymbolTab(symbolArgs([]))
    const pinIdx = html.indexOf('class="symbol-chart-pin"')
    expect(pinIdx).toBeGreaterThanOrEqual(0)
    // pin 内に chart container が入る (説明 panel 群は pin の外で下にスクロール)
    expect(html.indexOf('id="symbol-chart"')).toBeGreaterThan(pinIdx)
  })

  // client 側初期化スクリプトの静的ファイル化 (#charts-symbol-redesign)。
  // 巨大インライン <script> (旧: 約1200行/70KB) を外部 route に外出しした
  // ので、html には <script src> 参照のみが ECharts CDN の後に defer で乗る
  // ことを確認する (window.__chartData を読む実行順序を壊さない)。
  it('client script は外部ファイル参照 (<script src> + defer) で、ECharts CDN の後に置く', () => {
    const html = renderSymbolTab(symbolArgs([]))
    const echartsIdx = html.indexOf('cdn.jsdelivr.net/npm/echarts')
    const scriptTagIdx = html.indexOf('<script src="/dashboard/static/symbol-chart.js"')
    expect(echartsIdx).toBeGreaterThanOrEqual(0)
    expect(scriptTagIdx).toBeGreaterThan(echartsIdx)
    expect(html.slice(scriptTagIdx, scriptTagIdx + 80)).toContain('defer')
    // 旧インライン初期化コードそのものはもう SSR html に埋め込まれない
    expect(html).not.toContain("document.addEventListener('DOMContentLoaded'")
  })

  it('銘柄レールの link は zoom 範囲 (from/to) を URL で伝搬する', () => {
    const html = renderSymbolTab({
      ...symbolArgs([]),
      availableSymbols: ['TQQQ', 'SOXL'],
      zoom: { from: new Date('2026-06-01T00:00:00.000Z'), to: new Date('2026-06-06T00:00:00.000Z') },
    })
    expect(html).toContain(
      'href="/dashboard/charts?tab=symbol&symbol=SOXL&from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-06T00%3A00%3A00.000Z"',
    )
  })

  it('projection があれば payload に外挿情報を載せる (参考 価格外挿線)', () => {
    const view = buildBuyabilityView(
      [99.5, 99, 98.5, 98].map((price, i) => ({
        timestamp: `2026-06-0${i + 1}T14:00:00.000Z`,
        indicators: indFor({ price }),
      })),
      TEST_DEFAULT_RULE,
    )
    const html = renderSymbolTab(symbolArgs([], view))
    expect(html).toContain('"projection"')
    expect(html).toContain('"slopePerStep"')
    // 外挿線 series 名 (配線確認)。series 定義は静的ファイル化された client
    // script 側にある (#charts-symbol-redesign)。
    expect(SYMBOL_CHART_CLIENT_SCRIPT).toContain('参考 価格外挿')
  })
})

describe('parseSymbolView (#charts-symbol-redesign)', () => {
  it('detail 指定時のみ detail、それ以外は chart 既定', () => {
    expect(parseSymbolView('detail')).toBe('detail')
    expect(parseSymbolView('chart')).toBe('chart')
    expect(parseSymbolView(undefined)).toBe('chart')
    expect(parseSymbolView('')).toBe('chart')
    expect(parseSymbolView('xss')).toBe('chart')
  })
})

describe('renderSymbolViewSubnav (#charts-symbol-redesign)', () => {
  it('active な view は span、非 active は symbol= を維持した <a> を出す', () => {
    const html = renderSymbolViewSubnav('TQQQ', 'chart')
    expect(html).toContain('<span class="subnav-link active">チャート</span>')
    expect(html).toContain(
      '<a class="subnav-link" href="/dashboard/charts?tab=symbol&symbol=TQQQ&view=detail">履歴・設定</a>',
    )
  })

  it('detail が active なら履歴・設定側が span、チャート側が symbol= のみの <a>', () => {
    const html = renderSymbolViewSubnav('SOXL', 'detail')
    expect(html).toContain('<span class="subnav-link active">履歴・設定</span>')
    expect(html).toContain('<a class="subnav-link" href="/dashboard/charts?tab=symbol&symbol=SOXL">チャート</a>')
  })
})

describe('fold 内 判断サマリ (#charts-symbol-redesign)', () => {
  const baseParams: StrategyParamsSnapshot = {
    stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10,
    pullbackMax: -0.03, pullbackMin: -0.15, minReturn50d: 0,
    requireAboveSma50: true, kAtr: 2,
    maxSma50DeviationPct: 0.6, maxAtrRatio: 1.5,
    maxStopToTpRatio: 2.0,
    reentryMinAtrBelowLastExit: 1.0, reentryGuardBusinessDays: 3,
  }

  describe('renderConclusionValue', () => {
    it('保有中: 現在値起点の stop まで / TP まで距離', () => {
      const { value, color } = renderConclusionValue(
        null,
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z' },
        baseParams,
        104, // 現在値
      )
      // stop=96 → (96-104)/104=-7.69%、TP=107 → (107-104)/104=+2.88%
      expect(value).toContain('stop まで -7.7%')
      expect(value).toContain('TP まで +2.9%')
      expect(color).toBe('#3a3a3c')
    })

    it('未保有 + buyable: 入場条件充足の結論', () => {
      // TEST_DEFAULT_RULE: 押し目帯 = high20d(100)×[0.94, 0.97] = [94, 97]、
      // price=95 は帯内 + sma50(90) 上 + return50d(0.12)≥0.08 で buyable。
      const view = buildBuyabilityView(
        [{ timestamp: '2026-06-06T14:00:00.000Z', indicators: indFor({ price: 95 }) }],
        TEST_DEFAULT_RULE,
      )
      const { value, color } = renderConclusionValue(view, null, baseParams, 95)
      expect(value).toContain('入場条件 充足')
      expect(color).toBe('#057a55')
    })

    it('未保有 + 価格まであと X%: ボトルネックゲート名を併記', () => {
      const view = buildBuyabilityView(
        [{ timestamp: '2026-06-06T14:00:00.000Z', indicators: indFor({ price: 200 }) }],
        TEST_DEFAULT_RULE,
      )
      const { value, color } = renderConclusionValue(view, null, baseParams, 200)
      expect(value).toContain('入場まで あと 価格')
      expect(color).toBe('#b25000')
    })

    it('buyability null: 判定データなし', () => {
      const { value, color } = renderConclusionValue(null, null, baseParams, null)
      expect(value).toBe('判定データなし')
      expect(color).toBe('#86868b')
    })
  })

  describe('renderPositionSummaryValue', () => {
    it('未保有なら 未保有 の 1 語', () => {
      const html = renderPositionSummaryValue(null, baseParams, null, null)
      expect(html).toContain('未保有')
    })

    it('保有中: 平均取得 / 含み損益% / stop・TP 価格を出す (position.qty 欠測時は保有数量行を出さない)', () => {
      const html = renderPositionSummaryValue(
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z' },
        baseParams,
        110,
        null,
      )
      expect(html).toContain('平均取得 $100.00')
      expect(html).toContain('+10.0%') // 含み益
      expect(html).toContain('class="ok"')
      expect(html).toContain('stop $96.00')
      expect(html).toContain('TP $107.00')
      expect(html).not.toContain('保有数量')
    })

    it('position.qty があれば 保有数量 / 含み損益 $ を追加表示する (#charts-symbol-redesign Phase C)', () => {
      const html = renderPositionSummaryValue(
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z', qty: 5 },
        baseParams,
        110,
        null,
      )
      // (110 - 100) * 5 = +50.00
      expect(html).toContain('保有数量 5')
      expect(html).toContain('含み損益 $')
      expect(html).toContain('+$50.00')
      expect(html).toContain('class="ok"')
    })

    it('position.qty があっても含み損なら含み損益 $ を err クラス・マイナス表記で出す', () => {
      const html = renderPositionSummaryValue(
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z', qty: 5 },
        baseParams,
        90,
        null,
      )
      // (90 - 100) * 5 = -50.00
      expect(html).toContain('-$50.00')
    })

    it('position.qty が 0 以下 / null なら保有数量行を出さない (invalid/欠測を静かに無視)', () => {
      const htmlNull = renderPositionSummaryValue(
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z', qty: null },
        baseParams,
        110,
        null,
      )
      expect(htmlNull).not.toContain('保有数量')
      const htmlZero = renderPositionSummaryValue(
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z', qty: 0 },
        baseParams,
        110,
        null,
      )
      expect(htmlZero).not.toContain('保有数量')
    })

    it('含み損なら err クラスで色分け', () => {
      const html = renderPositionSummaryValue(
        { avgPrice: 100, openedAt: '2026-06-01T00:00:00.000Z' },
        baseParams,
        90,
        null,
      )
      expect(html).toContain('class="err"')
      expect(html).toContain('-10.0%')
    })
  })

  describe('renderLatestDecisionValue', () => {
    function decisionRow(overrides: Partial<DecisionRow> = {}): DecisionRow {
      return {
        id: 1, timestamp: '2026-06-06T14:00:00.000Z', requestId: null, symbol: 'TQQQ',
        decision: 'SKIP', reason: 'overextension', price: 100, indicatorsJson: null,
        clientOrderId: null, traceJson: null, filledPrice: null, filledQty: null,
        realizedPnl: null, brokerStatus: null,
        ...overrides,
      }
    }

    it('行が無ければ 判定履歴なし', () => {
      expect(renderLatestDecisionValue(undefined)).toContain('判定履歴なし')
      expect(renderLatestDecisionValue([])).toContain('判定履歴なし')
    })

    it('先頭行 (最新) の decision + 日本語併記 + reason を出す', () => {
      const html = renderLatestDecisionValue([
        decisionRow({ decision: 'SKIP', reason: 'overextension' }),
        decisionRow({ id: 2, decision: 'BUY' }),
      ])
      // rows[0] を採用 (呼び出し側は id DESC で渡す契約)
      expect(html).toContain('SKIP (見送り)')
      expect(html).not.toContain('BUY (買い)')
    })
  })

  describe('renderEffectiveRuleChips', () => {
    it('stop / TP / time-stop を effective 値の chip で出す', () => {
      const html = renderEffectiveRuleChips(baseParams)
      expect(html).toContain('class="chip">stop -4.0%</span>')
      expect(html).toContain('class="chip">TP +7.0%</span>')
      expect(html).toContain('class="chip">time-stop 10営業日</span>')
    })
  })
})

describe('renderSymbolTab — fold 内サマリ / サブタブ分離 (#charts-symbol-redesign)', () => {
  const baseParams: StrategyParamsSnapshot = {
    stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10,
    pullbackMax: -0.03, pullbackMin: -0.15, minReturn50d: 0,
    requireAboveSma50: true, kAtr: 2,
    maxSma50DeviationPct: 0.6, maxAtrRatio: 1.5,
    maxStopToTpRatio: 2.0,
    reentryMinAtrBelowLastExit: 1.0, reentryGuardBusinessDays: 3,
  }
  const decisionRows: DecisionRow[] = [
    {
      id: 2, timestamp: '2026-06-06T14:00:00.000Z', requestId: null, symbol: 'TQQQ',
      decision: 'SKIP', reason: 'overextension', price: 80, indicatorsJson: null,
      clientOrderId: null, traceJson: null, filledPrice: null, filledQty: null,
      realizedPnl: null, brokerStatus: null,
    },
  ]
  function baseArgs(overrides: Partial<ChartsBodySymbol> = {}): ChartsBodySymbol {
    return {
      tab: 'symbol',
      focusSymbol: 'TQQQ',
      symbolChart: {
        symbol: 'TQQQ',
        points: [{ timestamp: '2026-06-06T14:00:00.000Z', price: 80, sma50: 70, high20d: 90, low20d: 60 }],
        markers: [], position: null,
        rules: { pullbackMax: -0.03, pullbackMin: -0.15, stopPct: -0.04, takeProfitPct: 0.07, timeStopDays: 10 },
        trendLine: null, intradayBars: [],
        latestCronPrice: 80, latestCronTimestamp: '2026-06-06T14:00:00.000Z',
        decisions: [],
      },
      availableSymbols: ['TQQQ'],
      strategyParams: baseParams,
      zoom: null,
      buyability: null,
      decisionRows,
      ...overrides,
    }
  }

  it('既定 (view 未指定 / chart): サブナビはチャートが active、判断サマリ grid を出し、判定履歴/戦略パラメータは出さない', () => {
    const html = renderSymbolTab(baseArgs())
    expect(html).toContain('<span class="subnav-link active">チャート</span>')
    expect(html).toContain('href="/dashboard/charts?tab=symbol&symbol=TQQQ&view=detail">履歴・設定</a>')
    expect(html).toContain('class="judgment-grid"')
    expect(html).toContain('未保有') // 保有状態カード (position=null)
    expect(html).toContain('SKIP (見送り)') // 直近判定カード
    expect(html).not.toContain('判定履歴') // renderSymbolDecisionHistory の見出し
    expect(html).not.toContain('戦略パラメータ (PullbackUptrendStrategy')
    // 判定トレースパネルは初期 display:none (プレースホルダ文言は出さない)
    expect(html).toContain('id="decision-trace-panel" class="reason-panel" style="margin-top:10px;display:none"')
    expect(html).not.toContain('判定点 (●) をクリックすると')
    // id="symbol-main" は Phase C の swap 対象 anchor
    expect(html).toContain('id="symbol-main"')
  })

  it('view=detail: サブナビは履歴・設定が active、判定履歴 + 戦略パラメータを出しチャート/判断サマリは出さない', () => {
    const html = renderSymbolTab(baseArgs({ view: 'detail' }))
    expect(html).toContain('<span class="subnav-link active">履歴・設定</span>')
    expect(html).toContain('href="/dashboard/charts?tab=symbol&symbol=TQQQ">チャート</a>')
    expect(html).toContain('判定履歴') // renderSymbolDecisionHistory
    expect(html).toContain('戦略パラメータ (PullbackUptrendStrategy')
    expect(html).not.toContain('class="judgment-grid"')
    expect(html).not.toContain('id="symbol-chart"')
    expect(html).not.toContain('id="decision-trace-panel"')
  })

  it('view=chart: 「入場まで」フルパネルは既定で閉じた details に入る', () => {
    const view = buildBuyabilityView(
      [{ timestamp: '2026-06-06T14:00:00.000Z', indicators: indFor({ price: 99 }) }],
      TEST_DEFAULT_RULE,
    )
    const html = renderSymbolTab(baseArgs({ buyability: view }))
    const detailsIdx = html.indexOf('<details style="margin-top:10px">')
    const summaryIdx = html.indexOf('入場まで — ゲートチェックリスト・距離推移')
    const gridIdx = html.indexOf('class="judgment-grid"')
    expect(detailsIdx).toBeGreaterThanOrEqual(0)
    expect(summaryIdx).toBeGreaterThan(detailsIdx)
    // 判断サマリ grid は details より前 (fold 上部)
    expect(gridIdx).toBeGreaterThanOrEqual(0)
    expect(gridIdx).toBeLessThan(detailsIdx)
    // details に open は付かない (既定で閉じる)
    expect(html).not.toContain('<details open style="margin-top:10px">')
  })
})

describe('renderBuyabilityPanel (入場まで あとどれくらい / いつ頃)', () => {
  function viewFromPrices(prices: number[]): ReturnType<typeof buildBuyabilityView> {
    const evals: EvalIndicatorPoint[] = prices.map((price, i) => ({
      timestamp: `2026-06-0${i + 1}T14:00:00.000Z`,
      indicators: indFor({ price }),
    }))
    return buildBuyabilityView(evals, TEST_DEFAULT_RULE)
  }

  it('null / current 無しなら空文字', () => {
    expect(renderBuyabilityPanel(null)).toBe('')
  })

  it('価格があと下落で入場 → 「入場まで あと 価格」+ 到達価格 + ゲート表', () => {
    const html = renderBuyabilityPanel(viewFromPrices([99]))
    expect(html).toContain('入場まで')
    expect(html).toContain('あと 価格')
    expect(html).toContain('97.00') // band 上端 = 到達価格
    expect(html).toContain('入場ゲート')
    expect(html).toContain('◀ ボトルネック') // 不成立ゲートを明示
  })

  it('全条件充足なら「入場条件を充足」', () => {
    const html = renderBuyabilityPanel(viewFromPrices([95]))
    expect(html).toContain('入場条件を充足')
  })

  it('価格非依存ブロック (トレンド不足) は「価格を動かすだけでは入場不可」', () => {
    const view = buildBuyabilityView(
      [{ timestamp: '2026-06-06T14:00:00.000Z', indicators: indFor({ return50d: 0.02 }) }],
      TEST_DEFAULT_RULE,
    )
    const html = renderBuyabilityPanel(view)
    expect(html).toContain('価格を動かすだけでは入場不可')
    expect(html).toContain('トレンド')
  })

  it('距離が縮小していれば 縮小中 + 参考ETA (非予測注記つき)', () => {
    const html = renderBuyabilityPanel(viewFromPrices([99.5, 99, 98.5, 98, 97.5]))
    expect(html).toContain('縮小中')
    expect(html).toContain('参考 ETA')
    expect(html).toContain('予測ではない')
  })
})

import { renderZoomPresetButtons } from '../../src/routes/dashboard'

describe('renderZoomPresetButtons', () => {
  function fakeChart(points: SymbolChartPoint[]): SymbolChartData {
    return {
      symbol: 'X', points, markers: [], position: null,
      rules: { pullbackMax: 0, pullbackMin: 0, stopPct: 0, takeProfitPct: 0, timeStopDays: 10 },
      trendLine: null, intradayBars: [],
      latestCronPrice: null, latestCronTimestamp: null,
    }
  }

  it('chart null / points 空なら空文字', () => {
    expect(renderZoomPresetButtons(null)).toBe('')
    expect(renderZoomPresetButtons(fakeChart([]))).toBe('')
  })

  it('points あれば 1日 / 5日 / 1か月 / 最大 の 4 ピル (Google Finance JA 準拠)', () => {
    const chart = fakeChart([
      { timestamp: '2026-04-01T00:00:00.000Z', price: 100, sma50: null, high20d: null, low20d: null },
      { timestamp: '2026-04-25T00:00:00.000Z', price: 120, sma50: null, high20d: null, low20d: null },
    ])
    const html = renderZoomPresetButtons(chart)
    expect(html).toContain('>1日<')
    expect(html).toContain('>5日<')
    expect(html).toContain('>1か月<')
    expect(html).toContain('>最大<')
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

import { deriveEntryStatus } from '../../src/trading/strategy/entryStatus'

describe('段階判定の表示 (#452 PR 2)', () => {
  function viewFor(price: number) {
    return buildBuyabilityView(
      [{ timestamp: '2026-06-06T14:00:00.000Z', indicators: indFor({ price }) }],
      TEST_DEFAULT_RULE,
    )
  }

  it('buyability panel に EntryStatus badge を出す (ENTRY)', () => {
    const view = viewFor(95)
    const status = deriveEntryStatus(view.current!)
    expect(status.status).toBe('ENTRY')
    const html = renderBuyabilityPanel(view, { entryStatus: status })
    expect(html).toContain('>ENTRY<')
  })



})

import { renderAllocationLine } from '../../src/routes/dashboard'
import { computeConditionalAllocation } from '../../src/trading/strategy/conditionalAllocation'

describe('renderAllocationLine (#452 Layer 3 target/active 並記)', () => {
  const view = computeConditionalAllocation({
    targetWeights: { SGOV: 0.7, TQQQ: 0.05 },
    policy: {
      entryRequired: new Set(['TQQQ']),
      alwaysActive: new Set(['SGOV']),
      cashFallback: { TQQQ: ['SGOV'] },
    },
    entryStatuses: { TQQQ: 'NG' },
    heldSymbols: new Set(),
    symbolCurrency: { SGOV: 'USD', TQQQ: 'USD' },
  })

  it('退避された銘柄は target → 0% と退避先を表示', () => {
    const html = renderAllocationLine(view.bySymbol.TQQQ)
    expect(html).toContain('target 5%')
    expect(html).toContain('<strong>0%</strong>')
    expect(html).toContain('SGOV へ退避中')
  })

  it('退避先は受入分を表示 (70% + 5% = 75%)', () => {
    const html = renderAllocationLine(view.bySymbol.SGOV)
    expect(html).toContain('target 70%')
    expect(html).toContain('<strong>75%</strong>')
    expect(html).toContain('+5% 退避受入')
  })

  it('配分の無い銘柄は空文字', () => {
    expect(renderAllocationLine(undefined)).toBe('')
  })
})

import { renderSymbolPolicyLine } from '../../src/routes/dashboard'

describe('renderSymbolPolicyLine (#452 個別銘柄タブのロール表示)', () => {
  it('role / target / 条件連動 / 退避先を 1 行に要約する', () => {
    const html = renderSymbolPolicyLine('TQQQ', {
      role: 'leveraged_trend',
      targetWeight: 0.05,
      entryRequired: true,
      alwaysActive: false,
      cashFallbackSymbols: ['SGOV'],
    })
    expect(html).toContain('leveraged_trend')
    expect(html).toContain('レバETF・トレンド')
    expect(html).toContain('配分 target 5%')
    expect(html).toContain('条件連動')
    expect(html).toContain('symbol=SGOV')
    expect(html).toContain('/dashboard/symbols/TQQQ/edit')
  })

  it('role も配分も未設定なら何も出さない (従来挙動の銘柄)', () => {
    expect(
      renderSymbolPolicyLine('SOXL', {
        role: null,
        targetWeight: null,
        entryRequired: false,
        alwaysActive: false,
        cashFallbackSymbols: null,
      }),
    ).toBe('')
  })

  it('不正 role は警告表示', () => {
    const html = renderSymbolPolicyLine('OOPS', {
      role: 'unknown',
      targetWeight: null,
      entryRequired: false,
      alwaysActive: false,
      cashFallbackSymbols: null,
    })
    expect(html).toContain('⚠ unknown')
  })
})

import { symbolMapEditorBody } from '../../src/routes/dashboard'
import type { SymbolConfigRow } from '../../src/infrastructure/db/schema'

describe('symbolMapEditorBody (#symbol-relation-map 編集キャンバス・unit モデル)', () => {
  const edRow = (over: Partial<SymbolConfigRow>): SymbolConfigRow =>
    ({
      symbol: 'X',
      active: true,
      role: null,
      currency: 'USD',
      budgetAllocPct: null,
      cashFallbackSymbols: null,
      entryRequired: false,
      ...over,
    }) as SymbolConfigRow

  const payloadOf = (html: string) =>
    JSON.parse(html.match(/__symbolMapEditor = ([\s\S]*?);<\/script>/)?.[1] ?? 'null')

  it('対は 1 unit (leveraged 側が先頭)、配分は対で 1 枠、退避は unit 解決', () => {
    const html = symbolMapEditorBody(
      [
        edRow({ symbol: 'SOXS', role: 'inverse_hedge', budgetAllocPct: 0.5, cashFallbackSymbols: '["SQQQ"]', entryRequired: true }),
        edRow({ symbol: 'SOXL', role: 'leveraged_trend', budgetAllocPct: 0.5, cashFallbackSymbols: '["TQQQ"]', entryRequired: true }),
        edRow({ symbol: 'TQQQ', role: 'leveraged_trend' }),
        edRow({ symbol: 'SQQQ', role: 'inverse_hedge' }),
      ],
      { SOXL: 'SOXS', SOXS: 'SOXL', TQQQ: 'SQQQ', SQQQ: 'TQQQ' },
      { SQQQ: { native: '$44', jpy: 6600 } },
    )
    const payload = payloadOf(html)
    const sox = payload.units.find((u: { id: string }) => u.id === 'SOXL/SOXS')
    expect(sox).toMatchObject({
      label: 'SOXL ⇄ SOXS',
      pct: 50,
      fallbacks: ['TQQQ/SQQQ'],
    })
    // 保有は side 単位で持つ (SQQQ $44)
    const qqq = payload.units.find((u: { id: string }) => u.id === 'TQQQ/SQQQ')
    expect(qqq.held).toEqual({ SQQQ: '$44' })
    // unitOfSym で銘柄 → unit が引ける (シミュレーション overlay 用)
    expect(payload.unitOfSym.SOXS).toBe('SOXL/SOXS')
  })

  it('片側だけ退避が欠けた旧データも unit の退避として解決 (適用で側別に正規化される)', () => {
    const html = symbolMapEditorBody(
      [
        edRow({ symbol: 'SOXL', role: 'leveraged_trend', budgetAllocPct: 0.5 }),
        edRow({ symbol: 'SOXS', role: 'inverse_hedge', budgetAllocPct: 0.5, cashFallbackSymbols: '["SQQQ"]', entryRequired: true }),
        edRow({ symbol: 'TQQQ', role: 'leveraged_trend' }),
        edRow({ symbol: 'SQQQ', role: 'inverse_hedge' }),
      ],
      { SOXL: 'SOXS', SOXS: 'SOXL', TQQQ: 'SQQQ', SQQQ: 'TQQQ' },
      {},
    )
    const payload = payloadOf(html)
    const sox = payload.units.find((u: { id: string }) => u.id === 'SOXL/SOXS')
    expect(sox.fallbacks).toEqual(['TQQQ/SQQQ'])
  })

  it('多分岐退避 (#496): 複数先は unit の fallbacks に並ぶ', () => {
    const html = symbolMapEditorBody(
      [
        edRow({ symbol: 'AAPL', role: 'core_trend', budgetAllocPct: 0.5, cashFallbackSymbols: '["SGOV","USMV"]', entryRequired: true }),
        edRow({ symbol: 'SGOV', role: 'cash_parking' }),
        edRow({ symbol: 'USMV', role: 'low_volatility' }),
      ],
      {},
      {},
    )
    const payload = payloadOf(html)
    const aapl = payload.units.find((u: { id: string }) => u.id === 'AAPL')
    expect(aapl.fallbacks.sort()).toEqual(['SGOV', 'USMV'])
  })

  it('全側 inactive の unit はスポーン在庫に入る', () => {
    const html = symbolMapEditorBody(
      [
        edRow({ symbol: 'AAPL', role: 'core_trend', budgetAllocPct: 0.5 }),
        edRow({ symbol: 'TQQQ', role: 'leveraged_trend', active: false }),
        edRow({ symbol: 'SQQQ', role: 'inverse_hedge', active: false }),
      ],
      { TQQQ: 'SQQQ', SQQQ: 'TQQQ' },
      {},
    )
    const payload = payloadOf(html)
    expect(payload.units.map((u: { id: string }) => u.id)).toEqual(['AAPL'])
    expect(payload.inventory.map((u: { id: string }) => u.id)).toEqual(['TQQQ/SQQQ'])
  })

  it("view モード: 編集バー無し + sm-view + regime チップ (misconfig は警告)", () => {
    const html = symbolMapEditorBody(
      [
        edRow({ symbol: 'SOXL', role: 'leveraged_trend', budgetAllocPct: 0.5 }),
        edRow({ symbol: 'SOXS', role: 'inverse_hedge', budgetAllocPct: 0.5 }),
      ],
      { SOXL: 'SOXS', SOXS: 'SOXL' },
      {},
      {
        mode: 'view',
        pairRegimes: [
          { bullSymbol: 'SOXL', bearSymbol: 'SOXS', proxySymbol: 'SOXX', invalidConfig: null },
          { bullSymbol: 'TQQQ', bearSymbol: 'SQQQ', proxySymbol: 'TQQQ', invalidConfig: 'self-proxy' },
        ],
      },
    )
    expect(html).not.toContain('id="sm-changes-bar"')
    expect(html).not.toContain('id="sm-apply"')
    expect(html).toContain("el.classList.add('sm-view')")
    expect(html).toContain('✏️ 編集モード')
    expect(html).toContain('regime proxy SOXX → SOXL/SOXS')
    // 盤面に無い対の misconfig は出ない (TQQQ/SQQQ inactive 相当 = 未登録)
    expect(html).not.toContain('self-proxy')
  })

  it('inline script は構文エラーなく parse できる (#462 regression 防止)', () => {
    const html = symbolMapEditorBody(
      [
        edRow({ symbol: 'VUG', role: 'core_trend', budgetAllocPct: 0.3, cashFallbackSymbols: '["SGOV"]', entryRequired: true }),
        edRow({ symbol: 'SGOV', role: 'cash_parking' }),
      ],
      {},
      {},
    )
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
    expect(blocks.length).toBeGreaterThan(0)
    for (const code of blocks) {
      expect(() => new Function(code)).not.toThrow()
    }
  })
})
