import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
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
      decision: 'REJECT',
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
    for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1]!)).not.toThrow()
    }
  })
})
