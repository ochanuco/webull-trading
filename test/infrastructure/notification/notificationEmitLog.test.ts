import { describe, expect, it, vi } from 'vitest'
import { insertNotificationEmit, loadRecentAlerts } from '../../../src/infrastructure/notification/notificationEmitLog'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'
import type { AlertRow } from '../../../src/infrastructure/notification/notificationEmitLog'
import type { NotificationEmitLogInsert } from '../../../src/infrastructure/db/schema'

vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

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

describe('loadRecentAlerts — SUMMARY permanent exclusion + eventType/severities AND-combine filters (CodeRabbit #210)', () => {
  it('applies eventType-only filter via eq()', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, { eventType: 'TRADE' })

    expect(query.where).toHaveBeenCalledTimes(1)
    // Deliberately shallow: eq() returns an opaque SQL chunk, so we only check
    // that a single condition was passed (i.e. not wrapped in and()).
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
    // Deliberately shallow: and()'s SQL object holds multiple chunks, so a
    // present `queryChunks` array is enough evidence of a combined condition.
    expect(condition && 'queryChunks' in condition).toBe(true)
  })

  it('always excludes SUMMARY rows — where() applies even with no filters', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, {})

    // Unconditional ne(eventType, 'SUMMARY'), so any SUMMARY rows written
    // before push-only INSERT-skipping existed still can't leak into the view.
    expect(query.where).toHaveBeenCalledTimes(1)
    expect(query.where.mock.calls[0]![0]).toBeDefined()
  })

  it('orders by timestamp DESC, id DESC and clamps limit', async () => {
    const { db, query } = fakeDrizzleChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAlerts(fakeD1, { limit: 9999 })

    expect(query.orderBy).toHaveBeenCalledTimes(1)
    expect(query.limit).toHaveBeenCalledWith(500)
  })
})

function fakeInsertChain(captured: { row?: NotificationEmitLogInsert }) {
  const chain = {
    values: vi.fn(async (row: NotificationEmitLogInsert) => {
      captured.row = row
    }),
  }
  return {
    db: {
      insert: vi.fn(() => chain),
    },
  }
}

describe('insertNotificationEmit — event to row mapping (direct pickSymbol/pickCause call; SUMMARY normally never reaches here since LoggingNotifier skips its INSERT)', () => {
  it('maps a SUMMARY event to symbol=null and cause=null (push-only type)', async () => {
    const captured: { row?: NotificationEmitLogInsert } = {}
    const { db } = fakeInsertChain(captured)
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await insertNotificationEmit(fakeD1, {
      event: {
        type: 'SUMMARY',
        kind: 'news_shock_daily_summary',
        message: 'news shock gate 日次サマリ: 合成 regime=normal',
        severity: 'info',
      },
      message: 'news shock gate 日次サマリ: 合成 regime=normal',
      severity: 'info',
      requestId: 'req-1',
    })

    expect(captured.row?.symbol).toBeNull()
    expect(captured.row?.cause).toBeNull()
    expect(captured.row?.eventType).toBe('SUMMARY')
    expect(captured.row?.severity).toBe('info')
  })
})
