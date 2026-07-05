import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import {
  MATRIX_DECISION_PRIORITY,
  REASON_CATEGORIES,
  aggregateReasonTrend,
  buildDecisionMatrix,
  buildMatrixDates,
  categorizeReason,
  isJstDateClosedForMarket,
  type DecisionMatrixSourceRow,
} from '../../src/routes/dashboard/cron'

vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(async () => {
    throw new Error('no universe in test')
  }),
}))

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

function srcRow(over: Partial<DecisionMatrixSourceRow> = {}): DecisionMatrixSourceRow {
  return {
    day: '2026-07-01',
    symbol: 'SOXL',
    decision: 'HOLD',
    reason: 'price 30.5 <= sma50 31.2',
    n: 1,
    ...over,
  }
}

/**
 * loadDecisionMatrix は raw D1 (prepare → all) で読むため、fake は
 * dashboardTradesAlertsUi.test.ts の drizzle chain fake ではなく prepare fake。
 */
function fakeMatrixD1(rows: DecisionMatrixSourceRow[]): D1Database {
  return {
    prepare: () => ({
      all: async () => ({ results: rows }),
    }),
  } as unknown as D1Database
}

describe('buildDecisionMatrix (pure)', () => {
  it('行 = 銘柄 (昇順)、列 = JST 日付 (昇順) に整形する', () => {
    const matrix = buildDecisionMatrix([
      srcRow({ day: '2026-07-02', symbol: 'TQQQ' }),
      srcRow({ day: '2026-07-01', symbol: 'SOXL' }),
      srcRow({ day: '2026-07-03', symbol: 'SOXL' }),
    ])
    expect(matrix.dates).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
    expect(matrix.rows.map((r) => r.symbol)).toEqual(['SOXL', 'TQQQ'])
    expect(matrix.rows[0]!.cells['2026-07-01']).toBeDefined()
    expect(matrix.rows[0]!.cells['2026-07-02']).toBeUndefined()
  })

  it('代表判定は BUY > SELL > ERROR > REJECT > SKIP > HOLD の優先度で選ぶ', () => {
    expect(MATRIX_DECISION_PRIORITY).toEqual(['BUY', 'SELL', 'ERROR', 'REJECT', 'SKIP', 'HOLD'])
    const matrix = buildDecisionMatrix([
      srcRow({ decision: 'HOLD', n: 5 }),
      srcRow({ decision: 'BUY', reason: 'pullback -0.03 in uptrend (20d return 0.08)', n: 1 }),
      srcRow({ decision: 'SKIP', reason: 'sizing rejected: zero qty', n: 2 }),
    ])
    const cell = matrix.rows[0]!.cells['2026-07-01']!
    // 件数最多の HOLD ではなく、優先度最高の BUY が代表になる
    expect(cell.decision).toBe('BUY')
    expect(cell.reason).toBe('pullback -0.03 in uptrend (20d return 0.08)')
    expect(cell.count).toBe(1)
    expect(cell.total).toBe(8)
  })

  it('代表 reason は代表 decision 内の最頻 (同数は集計順の先頭)', () => {
    const matrix = buildDecisionMatrix([
      srcRow({ decision: 'SKIP', reason: 'sizing rejected: zero qty', n: 1 }),
      srcRow({ decision: 'SKIP', reason: 'SELL without position', n: 3 }),
      srcRow({ decision: 'HOLD', n: 10 }),
    ])
    const cell = matrix.rows[0]!.cells['2026-07-01']!
    expect(cell.decision).toBe('SKIP')
    expect(cell.reason).toBe('SELL without position')
    expect(cell.count).toBe(4)
    expect(cell.total).toBe(14)
  })

  it('想定外 decision は ERROR 相当の優先度で扱う (REJECT より上、SELL より下)', () => {
    const matrix = buildDecisionMatrix([
      srcRow({ decision: 'REJECT', n: 1 }),
      srcRow({ decision: 'FUTURE_ENUM', reason: null, n: 1 }),
    ])
    expect(matrix.rows[0]!.cells['2026-07-01']!.decision).toBe('FUTURE_ENUM')
    const withSell = buildDecisionMatrix([
      srcRow({ decision: 'FUTURE_ENUM', n: 1 }),
      srcRow({ decision: 'SELL', reason: 'take-profit hit: pnl 0.09 >= 0.08', n: 1 }),
    ])
    expect(withSell.rows[0]!.cells['2026-07-01']!.decision).toBe('SELL')
  })

  it('空入力は空マトリクス', () => {
    const matrix = buildDecisionMatrix([])
    expect(matrix.dates).toEqual([])
    expect(matrix.rows).toEqual([])
  })
})

describe('categorizeReason (pure)', () => {
  it('canonical reason の prefix でカテゴリ化する', () => {
    expect(categorizeReason('20d return 0.01 <= 0.05 trend threshold')).toBe('trend')
    expect(categorizeReason('50d return -0.02 <= 0.05 trend threshold')).toBe('trend')
    expect(categorizeReason('price 30.5 <= sma50 31.2')).toBe('trend')
    expect(categorizeReason('pullback -0.01 > -0.03 (not deep enough)')).toBe('pullback')
    expect(categorizeReason('invalid 20d high')).toBe('pullback')
    expect(categorizeReason('sma50 deviation 0.4 > 0.3 (overextended)')).toBe('overheat')
    expect(categorizeReason('atr ratio 2.1 > 1.8 (volatility elevated)')).toBe('overheat')
    expect(categorizeReason('sizing rejected: zero qty')).toBe('sizing')
    expect(
      categorizeReason('sizing rejected: lot-size-round (raw qty 0.5 < lot 1, stop 2, entry 30)'),
    ).toBe('sizing')
    expect(categorizeReason('spread 1.2% exceeds US limit 0.8%')).toBe('spread')
    expect(categorizeReason('SELL without position')).toBe('no_position')
    expect(categorizeReason('insufficient bars for indicators')).toBe('data')
    expect(categorizeReason('invalid price: NaN')).toBe('data')
    expect(categorizeReason('bar fetch: Yahoo 500')).toBe('data')
    expect(categorizeReason('broker submit error: 417 TICKER_IS_DENY')).toBe('broker')
    expect(categorizeReason('cooldown active until 2026-07-01T00:00:00Z')).toBe('cooldown')
    expect(categorizeReason('pending order in flight')).toBe('cooldown')
  })

  it('未知 / 空の reason は other に落ちる', () => {
    expect(categorizeReason(null)).toBe('other')
    expect(categorizeReason(undefined)).toBe('other')
    expect(categorizeReason('')).toBe('other')
    expect(categorizeReason('some future reason format')).toBe('other')
  })

  it('全カテゴリ key は REASON_CATEGORIES に定義されている (凡例と集計キーの整合)', () => {
    const keys = REASON_CATEGORIES.map((c) => c.key)
    for (const reason of [
      '20d return 0.01 <= 0.05 trend threshold',
      'pullback -0.01 > -0.03 (not deep enough)',
      'sizing rejected: zero qty',
      null,
    ]) {
      expect(keys).toContain(categorizeReason(reason))
    }
  })
})

describe('aggregateReasonTrend (pure)', () => {
  it('REJECT / SKIP / ERROR のみをカテゴリ別に日次集計する (BUY/SELL/HOLD は対象外)', () => {
    const trend = aggregateReasonTrend([
      srcRow({ day: '2026-07-01', decision: 'SKIP', reason: 'sizing rejected: zero qty', n: 2 }),
      srcRow({ day: '2026-07-01', decision: 'REJECT', reason: 'broker submit error: 417', n: 1 }),
      srcRow({ day: '2026-07-01', decision: 'HOLD', n: 10 }),
      srcRow({ day: '2026-07-01', decision: 'BUY', reason: 'pullback in uptrend', n: 1 }),
      srcRow({ day: '2026-07-02', decision: 'ERROR', reason: 'bar fetch: timeout', n: 3 }),
    ])
    expect(trend.map((p) => p.date)).toEqual(['2026-07-01', '2026-07-02'])
    expect(trend[0]!.counts.sizing).toBe(2)
    expect(trend[0]!.counts.broker).toBe(1)
    expect(trend[0]!.counts.trend).toBe(0)
    expect(trend[1]!.counts.data).toBe(3)
  })

  it('対象 decision が無ければ空配列', () => {
    expect(aggregateReasonTrend([srcRow({ decision: 'HOLD', n: 5 })])).toEqual([])
  })
})

describe('/dashboard/cron?view=matrix SSR スモーク', () => {
  const matrixRows: DecisionMatrixSourceRow[] = [
    srcRow({ day: '2026-07-01', symbol: 'SOXL', decision: 'HOLD', n: 3 }),
    srcRow({
      day: '2026-07-02',
      symbol: 'SOXL',
      decision: 'BUY',
      reason: 'pullback -0.03 in uptrend (20d return 0.08)',
      n: 1,
    }),
    srcRow({
      day: '2026-07-02',
      symbol: 'TQQQ',
      decision: 'SKIP',
      reason: 'sizing rejected: zero qty',
      n: 2,
    }),
  ]

  it('マトリクス表 + ビュー切替 pill + JSON リンク + 理由推移チャートを描画する', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron?view=matrix',
      { headers: {} },
      { ...baseEnv, DB: fakeMatrixD1(matrixRows) },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // ビュー切替 pill (一覧 / マトリクス)
    expect(body).toContain('>一覧</a>')
    expect(body).toContain('>マトリクス</a>')
    // JSON export リンク
    expect(body).toContain('href="/dashboard/cron/matrix/json"')
    // 行頭 = 銘柄 → チャート銘柄タブへのリンク
    expect(body).toContain('href="/dashboard/charts?tab=symbol&symbol=SOXL"')
    // セル = 色 pill + セルクリックで cron 絞り込みへ
    expect(body).toContain('class="mx-pill mx-ok"')
    expect(body).toContain('href="/dashboard/cron?symbol=SOXL"')
    // title に代表 reason の日本語 (localizeReason)
    expect(body).toContain('買い: 上昇トレンド中の押し目買い')
    // 横スクロール wrapper
    expect(body).toContain('overflow-x:auto')
    // 理由推移チャート (SKIP があるので描画される)
    expect(body).toContain('id="reason-trend-chart"')
    expect(body).toContain('window.__matrixTrend')
    // inline script の構文回帰ガード (#462 と同じ new Function 検証)
    for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1]!)).not.toThrow()
    }
  })

  it('?symbol= フィルタが URL に付いてきても壊れない (pill に伝搬)', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron?view=matrix&symbol=SOXL',
      { headers: {} },
      { ...baseEnv, DB: fakeMatrixD1(matrixRows) },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('href="/dashboard/cron?limit=50&symbol=SOXL"')
  })

  it('判定ログ 0 件でも空メッセージで 200', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron?view=matrix',
      { headers: {} },
      { ...baseEnv, DB: fakeMatrixD1([]) },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('判定ログがまだありません')
  })

  it('D1 エラーは 500 にせず unavailable に落とす', async () => {
    const app = createApp()
    const brokenDb = {
      prepare: () => ({
        all: async () => {
          throw new Error('no such table: strategy_decision_log')
        },
      }),
    } as unknown as D1Database
    const res = await app.request(
      '/dashboard/cron?view=matrix',
      { headers: {} },
      { ...baseEnv, DB: brokenDb },
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('利用不可')
  })
})

describe('GET /dashboard/cron/matrix/json', () => {
  it('dashboard_cron_matrix_export.v1 envelope で matrix packet を返す', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron/matrix/json',
      { headers: {} },
      {
        ...baseEnv,
        DB: fakeMatrixD1([
          srcRow({ day: '2026-07-01', symbol: 'SOXL', decision: 'BUY', reason: 'entry', n: 1 }),
        ]),
      },
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.schema).toBe('dashboard_cron_matrix_export.v1')
    expect(json.days).toBe(30)
    expect(json.rowCount).toBe(1)
    expect(typeof json.exportedAt).toBe('string')
    const matrix = json.matrix as {
      dates: string[]
      rows: Array<{ symbol: string; closedDates?: string[] }>
    }
    // #matrix-closed: 列はログ日だけでなく直近 30 日の開場暦日ベースになった
    expect(matrix.dates).toContain('2026-07-01')
    expect(matrix.dates.length).toBeGreaterThan(1)
    expect(matrix.rows[0]!.symbol).toBe('SOXL')
    // 休場日は closedDates として additive に載る (schema は v1 のまま)
    expect(Array.isArray(matrix.rows[0]!.closedDates)).toBe(true)
  })

  it('DB 未 bind は 503 の error envelope', async () => {
    const app = createApp()
    const res = await app.request('/dashboard/cron/matrix/json', { headers: {} }, { ...baseEnv })
    expect(res.status).toBe(503)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.error).toBe('db_not_bound')
  })
})

describe('休場セルの区別 (#matrix-closed, pure)', () => {
  it('isJstDateClosedForMarket: JP は暦日そのまま (元日/土曜=休、平日=開)', () => {
    expect(isJstDateClosedForMarket('2026-01-01', 'JP')).toBe(true) // 元日 (木)
    expect(isJstDateClosedForMarket('2026-07-03', 'JP')).toBe(false) // 金曜
    expect(isJstDateClosedForMarket('2026-07-04', 'JP')).toBe(true) // 土曜
  })

  it('isJstDateClosedForMarket: US は JST 日 X と X-1 の両方が非営業日のときだけ休', () => {
    // JST 土曜の早朝には ET 金曜セッションの後半が乗る → 開扱い
    expect(isJstDateClosedForMarket('2026-06-27', 'US')).toBe(false) // 土 (前日 金 6/26 が営業日)
    expect(isJstDateClosedForMarket('2026-06-28', 'US')).toBe(true) // 日 (土日とも非営業)
    // 2026-07-03 (金) は独立記念日 7/4 (土) の振替休場 → JST 7/3 は前日 7/2(木) 営業で開、
    // JST 7/4 (土) は 7/3 振替休場 + 7/4 土曜でどちらも非営業 → 休
    expect(isJstDateClosedForMarket('2026-07-03', 'US')).toBe(false)
    expect(isJstDateClosedForMarket('2026-07-04', 'US')).toBe(true)
    expect(isJstDateClosedForMarket('2026-07-05', 'US')).toBe(true) // 日 (前日 土)
  })

  it('buildMatrixDates: 全休列 (JST 日曜) は落ち、ログのある日と開場日は残る', () => {
    const now = new Date('2026-07-01T00:00:00Z') // JST 7/1 09:00
    const dates = buildMatrixDates(new Set(['2026-06-28']), ['US', 'JP'], 7, now)
    // 範囲: 6/25(木)〜7/1(水)。6/28(日) は全休だがログがあるので残る
    expect(dates).toContain('2026-06-28')
    // 6/27(土) は JP 休だが US が開扱い (ET 金曜後半) なので残る
    expect(dates).toContain('2026-06-27')
    expect(dates).toContain('2026-06-25')
    expect(dates).toContain('2026-07-01')
    expect(dates).toEqual([...dates].sort())
  })

  it('buildMatrixDates: US 銘柄が無ければ JST 土日列は落ちる', () => {
    const now = new Date('2026-07-01T00:00:00Z')
    const dates = buildMatrixDates(new Set<string>(), ['JP'], 7, now)
    expect(dates).not.toContain('2026-06-27') // 土
    expect(dates).not.toContain('2026-06-28') // 日
    expect(dates).toContain('2026-06-26') // 金
  })

  it('buildDecisionMatrix (opts 付き): 列が全暦日ベースになり closedDates が付く', () => {
    const rows = [
      srcRow({ day: '2026-06-26', symbol: 'SOXL', decision: 'HOLD' }),
      srcRow({ day: '2026-06-26', symbol: '1357', decision: 'HOLD' }),
    ]
    const matrix = buildDecisionMatrix(rows, { days: 7, now: new Date('2026-07-01T00:00:00Z') })
    // ログの無い平日 (6/29 月) も列に入る
    expect(matrix.dates).toContain('2026-06-29')
    const jp = matrix.rows.find((r) => r.symbol === '1357')!
    const us = matrix.rows.find((r) => r.symbol === 'SOXL')!
    // JST 土曜 6/27: JP は休、US は開 (ログ無し = 判定なし側)
    expect(jp.closedDates).toContain('2026-06-27')
    expect(us.closedDates).not.toContain('2026-06-27')
    // ログがある日は closedDates に入らない
    expect(jp.closedDates).not.toContain('2026-06-26')
  })

  it('buildDecisionMatrix (opts なし): 従来どおりログのあった日のみ (後方互換)', () => {
    const matrix = buildDecisionMatrix([srcRow({ day: '2026-06-26' })])
    expect(matrix.dates).toEqual(['2026-06-26'])
    expect(matrix.rows[0]!.closedDates).toBeUndefined()
  })
})
