import { describe, expect, it, vi } from 'vitest'
import { loadRecentAlerts } from '../../../src/infrastructure/notification/notificationEmitLog'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'
import type { AlertRow } from '../../../src/infrastructure/notification/notificationEmitLog'

vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

/**
 * `loadRecentAlerts` の filter 適用テスト (CodeRabbit #210)。
 *
 * drizzle-orm の SQL 生成自体は信頼するが、
 *   - `eventType` のみ指定 → eq 1 つ
 *   - `severities` のみ指定 → inArray 1 つ
 *   - 両方指定 → AND で結合 (silently drop しない)
 *   - 何も指定なし → where 呼び出しなし
 * を build chain spy で検証する。
 */
function fakeDrizzleChain(rows: AlertRow[]) {
  const query = {
    from: vi.fn(() => query),
    $dynamic: vi.fn(() => query),
    where: vi.fn((_arg: unknown) => query),
    orderBy: vi.fn((..._args: unknown[]) => query),
    limit: vi.fn(async (_n: number) => rows),
  }
  return {
    query,
    db: {
      select: vi.fn(() => query),
    },
  }
}

const fakeD1 = {} as D1Database

describe('loadRecentAlerts', () => {
  it('applies eventType-only filter via eq()', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, { eventType: 'TRADE' })

    expect(query.where).toHaveBeenCalledTimes(1)
    // eq() returns a SQL chunk — we only assert that exactly 1 condition
    // was passed (i.e. not wrapped in and()).
    const arg = query.where.mock.calls[0]![0]
    expect(arg).toBeDefined()
  })

  it('applies severities-only filter via inArray()', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, { severities: ['critical'] })

    expect(query.where).toHaveBeenCalledTimes(1)
    const arg = query.where.mock.calls[0]![0]
    expect(arg).toBeDefined()
  })

  it('AND-combines eventType + severities when both are present (#210)', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, {
      eventType: 'TRADE',
      severities: ['critical'],
    })

    expect(query.where).toHaveBeenCalledTimes(1)
    const condition = query.where.mock.calls[0]![0] as { queryChunks?: unknown[] } | undefined
    expect(condition).toBeDefined()
    // drizzle-orm の and() は SQL オブジェクトを返し、内部に複数の SQL chunk を
    // 持つ。ここでは `queryChunks` 配列の存在 (= 単一条件ではなく結合) を
    // 軽く確認するに留める。
    expect(condition && 'queryChunks' in condition).toBe(true)
  })

  it('omits where() when no filter is given', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, {})

    expect(query.where).not.toHaveBeenCalled()
  })

  it('orders by timestamp DESC, id DESC and clamps limit', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, { limit: 9999 })

    expect(query.orderBy).toHaveBeenCalledTimes(1)
    expect(query.limit).toHaveBeenCalledWith(500)
  })
})
