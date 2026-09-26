import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUOTE_FEED_ALL_KEY,
  reconcileQuoteFeedFailureStreak,
  toQuoteFeedFailureItems,
  updateFailureStreak,
} from '../../../src/trading/quotes/quoteFeedFailureStreak'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'

vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

const fakeD1 = {} as D1Database

function fakeDb(opts: { snapshotRows: Array<{ value: string }> }) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(async () => opts.snapshotRows),
  }
  const deleteChain = { where: vi.fn(async () => undefined) }
  const insertChain = { values: vi.fn(async (_row: unknown) => undefined) }
  return {
    db: {
      select: vi.fn(() => query),
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => insertChain),
    },
    deleteChain,
    insertChain,
  }
}

describe('updateFailureStreak (pure)', () => {
  it('1st and 2nd consecutive failure of a key do not cross', () => {
    const first = updateFailureStreak({}, ['SOXL'])
    expect(first.next).toEqual({ SOXL: 1 })
    expect(first.crossedKeys).toEqual([])

    const second = updateFailureStreak(first.next, ['SOXL'])
    expect(second.next).toEqual({ SOXL: 2 })
    expect(second.crossedKeys).toEqual([])
  })

  it('3rd consecutive failure crosses', () => {
    const result = updateFailureStreak({ SOXL: 2 }, ['SOXL'])
    expect(result.next).toEqual({ SOXL: 3 })
    expect(result.crossedKeys).toEqual(['SOXL'])
  })

  it('4th consecutive failure does not re-notify (only the crossing tick does)', () => {
    const result = updateFailureStreak({ SOXL: 3 }, ['SOXL'])
    expect(result.next).toEqual({ SOXL: 4 })
    expect(result.crossedKeys).toEqual([])
  })

  it('a key that stops failing resets (dropped from next, not carried forward)', () => {
    const result = updateFailureStreak({ SOXL: 2 }, [])
    expect(result.next).toEqual({})
    expect(result.crossedKeys).toEqual([])

    // A subsequent failure after the reset starts back at 1, not 3.
    const after = updateFailureStreak(result.next, ['SOXL'])
    expect(after.next).toEqual({ SOXL: 1 })
    expect(after.crossedKeys).toEqual([])
  })

  it('tracks independent keys separately', () => {
    const result = updateFailureStreak({ SOXL: 2, TQQQ: 1 }, ['SOXL', 'AAPL'])
    expect(result.next).toEqual({ SOXL: 3, AAPL: 1 })
    expect(result.crossedKeys).toEqual(['SOXL'])
  })
})

describe('toQuoteFeedFailureItems', () => {
  it('keys a per-symbol error by symbol and formats "SYMBOL: message"', () => {
    const items = toQuoteFeedFailureItems([{ category: 'US_ETF', symbol: 'SOXL', message: 'Failed to persist SOXL: Internal error' }])
    expect(items).toEqual([{ key: 'SOXL', display: 'Failed to persist SOXL: Internal error' }])
  })

  it('keys a category-level error by category and formats "[CATEGORY] message"', () => {
    const items = toQuoteFeedFailureItems([{ category: 'US_ETF', message: 'snapshot 500' }])
    expect(items).toEqual([{ key: 'category:US_ETF', display: '[US_ETF] snapshot 500' }])
  })
})

describe('reconcileQuoteFeedFailureStreak', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not notify on the 1st or 2nd consecutive failure of a key', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }

    const { db: db1 } = fakeDb({ snapshotRows: [] })
    vi.mocked(createDb).mockReturnValue(db1 as unknown as ReturnType<typeof createDb>)
    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [{ key: 'SOXL', display: 'SOXL: boom' }],
      cause: 'quote_feed_partial',
    })
    expect(events).toHaveLength(0)

    const { db: db2 } = fakeDb({ snapshotRows: [{ value: JSON.stringify({ SOXL: 1 }) }] })
    vi.mocked(createDb).mockReturnValue(db2 as unknown as ReturnType<typeof createDb>)
    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [{ key: 'SOXL', display: 'SOXL: boom' }],
      cause: 'quote_feed_partial',
    })
    expect(events).toHaveLength(0)
  })

  it('notifies exactly once on the 3rd consecutive failure, not the 4th', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }

    const { db: dbAt2 } = fakeDb({ snapshotRows: [{ value: JSON.stringify({ SOXL: 2 }) }] })
    vi.mocked(createDb).mockReturnValue(dbAt2 as unknown as ReturnType<typeof createDb>)
    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [{ key: 'SOXL', display: 'SOXL: boom' }],
      cause: 'quote_feed_partial',
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'ERROR', cause: 'quote_feed_partial', severity: 'warning', message: 'SOXL: boom' })

    const { db: dbAt3 } = fakeDb({ snapshotRows: [{ value: JSON.stringify({ SOXL: 3 }) }] })
    vi.mocked(createDb).mockReturnValue(dbAt3 as unknown as ReturnType<typeof createDb>)
    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [{ key: 'SOXL', display: 'SOXL: boom' }],
      cause: 'quote_feed_partial',
    })
    expect(events).toHaveLength(1)
  })

  it('recovery (no failures this tick) resets the streak and writes the empty map once', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }
    const { db, insertChain } = fakeDb({ snapshotRows: [{ value: JSON.stringify({ SOXL: 2 }) }] })
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await reconcileQuoteFeedFailureStreak({ db: fakeD1, notifier, items: [], cause: 'quote_feed_partial' })

    expect(events).toHaveLength(0)
    expect(insertChain.values).toHaveBeenCalledTimes(1)
    expect(insertChain.values.mock.calls[0]![0]).toMatchObject({ value: JSON.stringify({}) })
  })

  it('skips the D1 write on a quiet tick when the map was already empty', async () => {
    const notifier: Notifier = { async notify() {} }
    const { db, insertChain, deleteChain } = fakeDb({ snapshotRows: [] })
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await reconcileQuoteFeedFailureStreak({ db: fakeD1, notifier, items: [], cause: 'quote_feed_partial' })

    expect(insertChain.values).not.toHaveBeenCalled()
    expect(deleteChain.where).not.toHaveBeenCalled()
  })

  it('independent keys cross independently', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }
    const { db } = fakeDb({ snapshotRows: [{ value: JSON.stringify({ SOXL: 2, TQQQ: 0 }) }] })
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [
        { key: 'SOXL', display: 'SOXL: boom' },
        { key: 'TQQQ', display: 'TQQQ: boom' },
      ],
      cause: 'quote_feed_partial',
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type === 'ERROR' && events[0].message).toBe('SOXL: boom')
  })

  it('uses the fixed __all__ key for a full runQuoteFeed rejection', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }
    const { db } = fakeDb({ snapshotRows: [{ value: JSON.stringify({ [QUOTE_FEED_ALL_KEY]: 2 }) }] })
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [{ key: QUOTE_FEED_ALL_KEY, display: 'network down' }],
      cause: 'quote_feed',
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ cause: 'quote_feed', message: 'network down' })
  })

  it('fails open (notifies immediately) when the D1 read throws', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(async () => {
        throw new Error('db down')
      }),
    }
    vi.mocked(createDb).mockReturnValue({ select: vi.fn(() => query) } as unknown as ReturnType<typeof createDb>)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [{ key: 'SOXL', display: 'SOXL: boom' }],
      cause: 'quote_feed_partial',
    })

    expect(events).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('fails open (notifies immediately) when there is no D1 binding', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }

    await reconcileQuoteFeedFailureStreak({
      db: undefined,
      notifier,
      items: [{ key: 'SOXL', display: 'SOXL: boom' }],
      cause: 'quote_feed_partial',
    })

    expect(events).toHaveLength(1)
  })

  it('joins up to 3 crossing items and appends a (+N 件) tail beyond that', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = { async notify(e) { events.push(e) } }
    const { db } = fakeDb({
      snapshotRows: [{ value: JSON.stringify({ A: 2, B: 2, C: 2, D: 2 }) }],
    })
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await reconcileQuoteFeedFailureStreak({
      db: fakeD1,
      notifier,
      items: [
        { key: 'A', display: 'A: boom' },
        { key: 'B', display: 'B: boom' },
        { key: 'C', display: 'C: boom' },
        { key: 'D', display: 'D: boom' },
      ],
      cause: 'quote_feed_partial',
    })

    expect(events).toHaveLength(1)
    expect(events[0]?.type === 'ERROR' && events[0].message).toBe('A: boom | B: boom | C: boom (+1 件)')
  })
})
