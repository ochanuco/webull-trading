import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { isDecisionRowInSession } from '../../src/routes/dashboard/cron'
import { loadRecentAlerts } from '../../src/infrastructure/notification/notificationEmitLog'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'

vi.mock('../../src/infrastructure/notification/notificationEmitLog', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/notification/notificationEmitLog')>(
    '../../src/infrastructure/notification/notificationEmitLog',
  )
  return { ...actual, loadRecentAlerts: vi.fn() }
})
vi.mock('../../src/infrastructure/db/tradeJournalRepo', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradeJournalRepo')>(
    '../../src/infrastructure/db/tradeJournalRepo',
  )
  return { ...actual, createDb: vi.fn() }
})
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(async () => {
    throw new Error('no universe in test')
  }),
}))

const baseEnv = { ACCESS_DEV_BYPASS_USER: 'admin' }

function journalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    timestamp: '2026-06-11T01:00:00.000Z',
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

function fakeJournalDb(rows: Array<Record<string, unknown>>) {
  return {
    select() {
      return {
        from() {
          const chain = {
            where: () => chain,
            orderBy: () => chain,
            limit: async () => rows,
          }
          return chain
        },
      }
    },
  }
}

describe('/dashboard/trades 新 UI (#alerts-trades-ui)', () => {
  it('日本語イベント・売買バッジ・状態 pill・実現損益列を描画する', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeJournalDb([
        journalRow(),
        journalRow({
          id: 2,
          tradeEventType: 'exit',
          side: 'SELL',
          realizedPnl: 12.34,
          exitReason: 'take_profit',
          brokerStatus: 'FILLED',
        }),
        journalRow({
          id: 3,
          tradeEventType: 'post_submit',
          brokerStatus: null,
          mode: 'DRY_RUN',
          errorMessage:
            'Webull request failed permanently with status 417: {"error_code":"OAUTH_OPENAPI_TICKER_IS_DENY"}',
        }),
      ]) as never,
    )
    const app = createApp()
    const res = await app.request('/dashboard/trades', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    // view filter pills
    expect(body).toContain('view=fills')
    expect(body).toContain('約定・手仕舞い')
    // イベント日本語 + raw は title に保持
    expect(body).toContain('● 約定')
    expect(body).toContain('● 手仕舞い')
    expect(body).toContain('title="post_submit"')
    // 売買バッジ
    expect(body).toContain('>買</span>')
    expect(body).toContain('>売</span>')
    // 実現損益 + exit reason
    expect(body).toContain('+12.34')
    expect(body).toContain('take_profit')
    // エラーは短い日本語 + 全文 details
    expect(body).toContain('エラー: 銘柄取扱なし')
    expect(body).toContain('OAUTH_OPENAPI_TICKER_IS_DENY')
    // mode pill
    expect(body).toContain('実発注')
    expect(body).toContain('>DRY<')
    // AI 用コピー: 全件ボタン + 行ボタン + raw payload (表示で省略した field も含む)
    expect(body).toContain('id="log-copy-all"')
    expect(body).toContain('class="log-copy-btn" data-id="3"')
    expect(body).toContain('window.__tradesCopy')
    expect(body).toContain('trade_journal (約定履歴)')
    // inline script の構文回帰 (#465 ガードをこのページにも)
    for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1]!)).not.toThrow()
    }
  })

  it('view=errors はエラー行のみの絞り込みリンクとして機能する (route param)', async () => {
    vi.mocked(createDb).mockReturnValue(fakeJournalDb([]) as never)
    const app = createApp()
    const res = await app.request('/dashboard/trades?view=errors', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('該当するレコードがありません')
  })
})

describe('/dashboard/trades ⇄ /dashboard/cron 相互リンク (#nav-links)', () => {
  it('clientOrderId フィルタはバナー + 判定へ戻るリンクを描画し、pill にも伝搬する', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeJournalDb([journalRow({ clientOrderId: 'co-abc123' })]) as never,
    )
    const app = createApp()
    const res = await app.request(
      '/dashboard/trades?clientOrderId=co-abc123',
      { headers: {} },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // フィルタ中バナー: 注文単位の絞り込み + 判定への逆リンク + 全件へ戻る
    expect(body).toContain('の履歴のみ表示')
    expect(body).toContain('href="/dashboard/cron?clientOrderId=co-abc123"')
    expect(body).toContain('href="/dashboard/trades"')
    // view pill を切り替えても絞り込みが外れない (limit デフォルトは 50)
    expect(body).toContain('view=fills&limit=50&clientOrderId=co-abc123')
  })

  it('symbol フィルタはバナー + チャート/判定リンクを描画する', async () => {
    vi.mocked(createDb).mockReturnValue(fakeJournalDb([journalRow()]) as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/trades?symbol=soxl',
      { headers: {} },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    // symbol は大文字正規化されてリンクに乗る
    expect(body).toContain('のみ表示')
    expect(body).toContain('href="/dashboard/charts?tab=symbol&symbol=SOXL"')
    expect(body).toContain('href="/dashboard/cron?symbol=SOXL"')
  })

  it('clientOrderId を持つ行は「判定→」逆リンク、銘柄セルは ▼ 絞り込みを持つ', async () => {
    vi.mocked(createDb).mockReturnValue(
      fakeJournalDb([journalRow({ clientOrderId: 'co-xyz' })]) as never,
    )
    const app = createApp()
    const res = await app.request('/dashboard/trades', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    expect(body).toContain('href="/dashboard/cron?clientOrderId=co-xyz"')
    expect(body).toContain('判定→')
    expect(body).toContain('href="/dashboard/trades?symbol=SOXL"')
    expect(body).toContain('この銘柄の約定だけに絞り込み')
  })

  it('cron: clientOrderId フィルタバナーと fill セルの trades リンクを描画する', async () => {
    const decisionRow = {
      id: 10,
      timestamp: '2026-06-10T17:45:45.592Z',
      requestId: 'run-1',
      symbol: 'SOXL',
      decision: 'BUY',
      reason: 'entry',
      price: 30.5,
      indicatorsJson: null,
      clientOrderId: 'co-fill1',
      traceJson: null,
      filledPrice: 30.4,
      filledQty: 3,
      realizedPnl: null,
      brokerStatus: 'FILLED',
    }
    vi.mocked(createDb).mockReturnValue(
      {
        select() {
          return {
            from() {
              const chain = {
                leftJoin: () => chain,
                where: () => chain,
                orderBy: () => chain,
                limit: async () => [decisionRow],
              }
              return chain
            },
          }
        },
      } as never,
    )
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron?clientOrderId=co-fill1',
      { headers: {} },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // 注文単位バナー + 約定への逆リンク
    expect(body).toContain('の判定のみ表示')
    expect(body).toContain('href="/dashboard/trades?clientOrderId=co-fill1"')
    // 実 fill セルも同じ注文の trades へ飛べる
    expect(body).toContain('この注文の約定履歴を見る')
  })
})

describe('/dashboard/alerts 新 UI (#alerts-trades-ui)', () => {
  beforeEach(() => {
    vi.mocked(loadRecentAlerts).mockReset()
  })

  it('severity/種別を日本語 pill にし、長文 message は畳む', async () => {
    const longMessage = 'Webull request failed permanently with status 417: ' + 'x'.repeat(200)
    vi.mocked(loadRecentAlerts).mockResolvedValue([
      {
        id: 1,
        timestamp: '2026-06-11T01:00:00.000Z',
        requestId: 'req-9',
        eventType: 'ERROR',
        severity: 'critical',
        symbol: 'USMV',
        cause: 'broker_4xx',
        message: longMessage,
      },
      {
        id: 2,
        timestamp: '2026-06-11T01:01:00.000Z',
        requestId: null,
        eventType: 'STATE_CHANGE',
        severity: 'info',
        symbol: null,
        cause: 'dryRun',
        message: 'state change: dryRun true → false',
      },
    ] as never)
    const app = createApp()
    const res = await app.request('/dashboard/alerts', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('>重大<')
    expect(body).toContain('>情報<')
    expect(body).toContain('設定変更')
    // 長文は先頭 + 全文 details (原文は grep 用に保持)
    expect(body).toContain('<summary class="muted" style="font-size:11px;cursor:pointer">全文</summary>')
    expect(body).toContain(longMessage.slice(0, 100))
    // 短文はそのまま
    expect(body).toContain('dryRun true → false')
    // AI 用コピー
    expect(body).toContain('id="log-copy-all"')
    expect(body).toContain('window.__alertsCopy')
    for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1]!)).not.toThrow()
    }
  })
})

describe('/dashboard/cron AI 用コピー (#alerts-trades-ui)', () => {
  it('行コピー (trace 含む full) と全件コピー (trace 省略) の payload を埋める', async () => {
    const decisionRow = {
      id: 2963,
      timestamp: '2026-06-10T17:45:45.592Z',
      requestId: 'run-1',
      symbol: 'USMV',
      decision: 'SKIP',
      reason: 'role: low_volatility entry is not enabled (#452)',
      price: 95.46,
      indicatorsJson: '{"price":95.46}',
      clientOrderId: null,
      traceJson: '[{"label":"risk.role_entry_suppressed","passed":false}]',
      filledPrice: null,
      filledQty: null,
      realizedPnl: null,
      brokerStatus: null,
    }
    vi.mocked(createDb).mockReturnValue(
      {
        select() {
          return {
            from() {
              const chain = {
                leftJoin: () => chain,
                where: () => chain,
                orderBy: () => chain,
                limit: async () => [decisionRow],
              }
              return chain
            },
          }
        },
      } as never,
    )
    const app = createApp()
    const res = await app.request('/dashboard/cron', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="log-copy-all"')
    expect(body).toContain('class="log-copy-btn" data-id="2963"')
    expect(body).toContain('window.__cronCopy')
    // full 側には trace が入る
    expect(body).toContain('risk.role_entry_suppressed')
    // #decisions-chart-unify: 銘柄リンクはチャート銘柄タブへ、cron 内絞り込みは ▼
    expect(body).toContain('href="/dashboard/charts?tab=symbol&symbol=USMV"')
    expect(body).toContain('この銘柄の判定だけに絞り込み')
    // 銘柄レール: universe 不在 (このテストの mock) では出ない — レール無しでも本文は描画される
    expect(body).not.toContain('<aside class="symbol-rail"')
    for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1]!)).not.toThrow()
    }
  })
})

describe('/dashboard/cron 銘柄レール (#decisions-chart-unify)', () => {
  it('ALL + 銘柄リンクのレールを描画し、選択中をハイライトする', async () => {
    const { loadSymbolUniverse } = await import('../../src/infrastructure/db/symbolUniverse')
    const { makeSymbolUniverse } = await import('../helpers/configFixtures')
    vi.mocked(loadSymbolUniverse).mockResolvedValueOnce(
      makeSymbolUniverse({ allowedSymbols: ['SOXL', 'SOXS'], inactiveSymbols: ['SPY'] }),
    )
    vi.mocked(createDb).mockReturnValue(
      {
        select() {
          return {
            from() {
              const chain = {
                leftJoin: () => chain,
                where: () => chain,
                orderBy: () => chain,
                limit: async () => [],
              }
              return chain
            },
          }
        },
      } as never,
    )
    const app = createApp()
    const res = await app.request('/dashboard/cron?symbol=SOXL', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    expect(body).toContain('<aside class="symbol-rail"')
    // ALL は非選択、SOXL が active
    expect(body).toContain('>ALL</span>')
    expect(body).toMatch(/rail-item active" href="\/dashboard\/cron\?symbol=SOXL/)
    expect(body).toContain('href="/dashboard/cron?symbol=SOXS')
    // inactive 銘柄もレールに出る (grayed)
    expect(body).toContain('href="/dashboard/cron?symbol=SPY')
  })
})

describe('/dashboard/cron セッションフィルタ (#cron-session-filter)', () => {
  function cronDb(rows: unknown[]) {
    return {
      select() {
        return {
          from() {
            const chain = {
              leftJoin: () => chain,
              where: () => chain,
              orderBy: () => chain,
              limit: async () => rows,
            }
            return chain
          },
        }
      },
    } as never
  }
  const inSession = {
    id: 1,
    timestamp: '2026-06-05T14:30:00.000Z', // ET 10:30 金曜 = US 場中
    requestId: 'run-1',
    symbol: 'SOXL',
    decision: 'HOLD',
    reason: 'holding: pnl 0.01 within (-0.05, 0.08)',
    price: 30.5,
    indicatorsJson: null,
    clientOrderId: null,
    traceJson: null,
    filledPrice: null,
    filledQty: null,
    realizedPnl: null,
    brokerStatus: null,
  }
  const outOfSession = {
    ...inSession,
    id: 2,
    timestamp: '2026-06-06T00:00:00.000Z', // ET 金曜 20:00 = 閉場後 (手動 run 相当)
    reason: 'manual run after close',
  }

  it('既定 (開場中のみ) は休場時間帯の行を隠し、切替 pill を出す', async () => {
    vi.mocked(createDb).mockReturnValue(cronDb([inSession, outOfSession]))
    const app = createApp()
    const res = await app.request('/dashboard/cron', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-id="1"')
    expect(body).not.toContain('data-id="2"')
    expect(body).toContain('開場中のみ')
    expect(body).toContain('session=all')
  })

  it('?session=all は全時間帯の行を表示する', async () => {
    vi.mocked(createDb).mockReturnValue(cronDb([inSession, outOfSession]))
    const app = createApp()
    const res = await app.request('/dashboard/cron?session=all', { headers: {} }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    expect(body).toContain('data-id="1"')
    expect(body).toContain('data-id="2"')
  })

  it('isDecisionRowInSession: JP は JST 場中のみ true、不正 timestamp は true (隠さない)', () => {
    expect(isDecisionRowInSession('2026-06-05T01:00:00.000Z', '1357')).toBe(true) // JST 10:00 金曜
    expect(isDecisionRowInSession('2026-06-05T11:00:00.000Z', '1357')).toBe(false) // JST 20:00
    expect(isDecisionRowInSession('2026-06-05T11:00:00.000Z', 'SOXL')).toBe(false) // ET 07:00 寄り前
    expect(isDecisionRowInSession('not-a-date', 'SOXL')).toBe(true)
  })
})

describe('loadDecisionRowsInSession のページ整合 (#cron-session-filter paging)', () => {
  const IN_TS = '2026-06-05T14:30:00.000Z' // ET 10:30 金曜 = US 場中
  const OUT_TS = '2026-06-06T00:00:00.000Z' // ET 金曜 20:00 = 閉場後
  const mkRow = (id: number, inSession: boolean) => ({
    id,
    timestamp: inSession ? IN_TS : OUT_TS,
    requestId: 'run-1',
    symbol: 'SOXL',
    decision: 'HOLD',
    reason: null,
    price: 30.5,
    indicatorsJson: null,
    clientOrderId: null,
    traceJson: null,
    filledPrice: null,
    filledQty: null,
    realizedPnl: null,
    brokerStatus: null,
  })
  /**
   * limit() 呼び出しごとに次のバッチを返す stateful fake (カーソル前進を模擬)。
   * 判定クエリは leftJoin を通るので、それ以外のクエリ (kill switch の
   * global_config 読みなど) には空を返して queue を消費させない。
   */
  function batchedDb(batches: unknown[][]) {
    const queue = [...batches]
    return {
      select() {
        let isDecisionQuery = false
        const chain = {
          leftJoin: () => {
            isDecisionQuery = true
            return chain
          },
          where: () => chain,
          orderBy: () => chain,
          limit: async () => (isDecisionQuery ? (queue.shift() ?? []) : []),
        }
        return { from: () => chain }
      },
    } as never
  }

  it('休場行 200 件を跨いで次バッチから開場行を limit 件そろえる', async () => {
    const batch1 = Array.from({ length: 200 }, (_, i) => mkRow(400 - i, false))
    const batch2 = [mkRow(200, true), mkRow(199, true)]
    vi.mocked(createDb).mockReturnValue(batchedDb([batch1, batch2]))
    const { loadDecisionRowsInSession } = await import('../../src/routes/dashboard/cron')
    const page = await loadDecisionRowsInSession(createDb({} as D1Database), { limit: 1 })
    expect(page.rows.map((r) => r.id)).toEqual([200])
    expect(page.hasMore).toBe(true) // 開場行が limit+1 件見つかった
  })

  it('データ末尾に到達したら hasMore=false (フェッチ窓でなく表示行基準)', async () => {
    vi.mocked(createDb).mockReturnValue(
      batchedDb([[mkRow(5, true), mkRow(4, false), mkRow(3, true)]]),
    )
    const { loadDecisionRowsInSession } = await import('../../src/routes/dashboard/cron')
    const page = await loadDecisionRowsInSession(createDb({} as D1Database), { limit: 50 })
    expect(page.rows.map((r) => r.id)).toEqual([5, 3])
    expect(page.hasMore).toBe(false)
  })

  it('走査上限 (5 バッチ) で打ち切り、hasMore=true + lastScannedId で前進できる', async () => {
    const batches = Array.from({ length: 6 }, (_, b) =>
      Array.from({ length: 200 }, (_, i) => mkRow(2000 - b * 200 - i, false)),
    )
    vi.mocked(createDb).mockReturnValue(batchedDb(batches))
    const { loadDecisionRowsInSession } = await import('../../src/routes/dashboard/cron')
    const page = await loadDecisionRowsInSession(createDb({} as D1Database), { limit: 50 })
    expect(page.rows).toEqual([])
    expect(page.hasMore).toBe(true)
    expect(page.lastScannedId).toBe(2000 - 5 * 200 + 1) // 5 バッチ分の末尾
  })

  it('route: 次ページカーソルは「最後に表示した行」の id になる', async () => {
    // 開場 [5,3,1] / 休場 [4,2]。limit=2 → 表示 [5,3]、次カーソルは 3
    vi.mocked(createDb).mockReturnValue(
      batchedDb([[mkRow(5, true), mkRow(4, false), mkRow(3, true), mkRow(2, false), mkRow(1, true)]]),
    )
    const app = createApp()
    const res = await app.request(
      '/dashboard/cron?limit=2',
      { headers: {} },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('data-id="5"')
    expect(body).toContain('data-id="3"')
    expect(body).not.toContain('data-id="4"')
    expect(body).not.toContain('data-id="1"') // limit=2 で切れる
    expect(body).toContain('before=3') // 表示末尾がカーソル
  })
})
