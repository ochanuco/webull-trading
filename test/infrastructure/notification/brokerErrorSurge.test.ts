import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROKER_ERROR_CAUSES,
  DEFAULT_BROKER_SURGE_CONFIG,
  classifyBrokerErrorCause,
  detectBrokerErrorSurge,
  notifyBrokerErrorSurgeIfChanged,
} from '../../../src/infrastructure/notification/brokerErrorSurge'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'
import {
  BrokerAuthError,
  BrokerClientError,
  BrokerRateLimitError,
  BrokerRequestError,
  BrokerServerError,
} from '../../../src/shared/errors'
import type {
  Notifier,
  NotificationEvent,
} from '../../../src/infrastructure/notification/Notifier'

vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

const fakeD1 = {} as D1Database

/**
 * `detectBrokerErrorSurge` で使う drizzle chain の最小 stub。
 *   db.select().from(...).where(...) が `rows` を返す。
 */
function fakeSelectChain(rows: Array<{ cause: string | null }>) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(async (_arg: unknown) => rows),
  }
  return {
    query,
    db: {
      select: vi.fn(() => query),
    },
  }
}

describe('classifyBrokerErrorCause', () => {
  it('classifies 429 as broker_429', () => {
    expect(classifyBrokerErrorCause(new BrokerRateLimitError('rl', 'op'))).toBe('broker_429')
  })
  it('classifies BrokerAuthError as broker_4xx', () => {
    expect(classifyBrokerErrorCause(new BrokerAuthError('auth', 'op'))).toBe('broker_4xx')
  })
  it('classifies BrokerClientError as broker_4xx', () => {
    expect(classifyBrokerErrorCause(new BrokerClientError('bad', 'op'))).toBe('broker_4xx')
  })
  it('classifies BrokerServerError as broker_5xx', () => {
    expect(classifyBrokerErrorCause(new BrokerServerError('500', 'op'))).toBe('broker_5xx')
  })
  it('falls back to brokerStatus for raw BrokerRequestError', () => {
    expect(
      classifyBrokerErrorCause(new BrokerRequestError('x', 'op', { brokerStatus: 503 })),
    ).toBe('broker_5xx')
    expect(
      classifyBrokerErrorCause(new BrokerRequestError('x', 'op', { brokerStatus: 404 })),
    ).toBe('broker_4xx')
    expect(
      classifyBrokerErrorCause(new BrokerRequestError('x', 'op', { brokerStatus: 429 })),
    ).toBe('broker_429')
  })
  it('returns broker_other when status is unknown', () => {
    expect(classifyBrokerErrorCause(new BrokerRequestError('x', 'op'))).toBe('broker_other')
  })
  it('returns null for non-broker errors', () => {
    expect(classifyBrokerErrorCause(new Error('boom'))).toBeNull()
    expect(classifyBrokerErrorCause('string')).toBeNull()
  })
})

describe('detectBrokerErrorSurge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns surging=false when no rows in lookback window', async () => {
    const { db } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)
    const result = await detectBrokerErrorSurge(fakeD1, DEFAULT_BROKER_SURGE_CONFIG, new Date())
    expect(result.surging).toBe(false)
    expect(result.errorCount).toBe(0)
    expect(result.causes).toEqual([])
  })

  it('returns surging=false when count is below threshold', async () => {
    const rows = Array.from({ length: 3 }, () => ({ cause: 'broker_5xx' }))
    const { db } = fakeSelectChain(rows)
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)
    const result = await detectBrokerErrorSurge(
      fakeD1,
      { ...DEFAULT_BROKER_SURGE_CONFIG, surgeThreshold: 5 },
      new Date(),
    )
    expect(result.surging).toBe(false)
    expect(result.errorCount).toBe(3)
    expect(result.causes).toEqual(['broker_5xx'])
  })

  it('returns surging=true at threshold with deduped sorted causes', async () => {
    const rows = [
      { cause: 'broker_5xx' },
      { cause: 'broker_5xx' },
      { cause: 'broker_429' },
      { cause: 'broker_4xx' },
      { cause: 'broker_5xx' },
    ]
    const { db } = fakeSelectChain(rows)
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)
    const result = await detectBrokerErrorSurge(
      fakeD1,
      { ...DEFAULT_BROKER_SURGE_CONFIG, surgeThreshold: 5 },
      new Date(),
    )
    expect(result.surging).toBe(true)
    expect(result.errorCount).toBe(5)
    expect(result.causes).toEqual(['broker_429', 'broker_4xx', 'broker_5xx'])
  })

  it('returns safe defaults on D1 throw', async () => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(async () => {
        throw new Error('db down')
      }),
    }
    vi.mocked(createDb).mockReturnValue({
      select: vi.fn(() => query),
    } as unknown as ReturnType<typeof createDb>)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await detectBrokerErrorSurge(fakeD1, DEFAULT_BROKER_SURGE_CONFIG, new Date())
    expect(result.surging).toBe(false)
    expect(result.errorCount).toBe(0)
    warnSpy.mockRestore()
  })

  it('exports a non-empty BROKER_ERROR_CAUSES taxonomy including legacy', () => {
    expect(BROKER_ERROR_CAUSES.length).toBeGreaterThan(0)
    expect(BROKER_ERROR_CAUSES).toContain('broker_4xx')
    expect(BROKER_ERROR_CAUSES).toContain('broker_5xx')
    expect(BROKER_ERROR_CAUSES).toContain('broker_429')
    // legacy from older notify call sites
    expect(BROKER_ERROR_CAUSES).toContain('broker submit')
  })
})

describe('notifyBrokerErrorSurgeIfChanged', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits STATE_CHANGE critical when first crossing threshold (no prev snapshot)', async () => {
    const errorRows = Array.from({ length: 6 }, () => ({ cause: 'broker_5xx' }))
    // 1st select: broker errors. 2nd select: snapshot row (empty = first run).
    const ordered: Array<unknown[]> = [errorRows, []]
    const where = vi.fn(async () => ordered.shift() ?? [])
    const query = {
      from: vi.fn(() => query),
      where,
    }
    const deleteChain = { where: vi.fn(async () => undefined) }
    const insertChain = {
      values: vi.fn(async (_row: { value?: string; key?: string; snapshotAt?: string }) => undefined),
    }
    vi.mocked(createDb).mockReturnValue({
      select: vi.fn(() => query),
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => insertChain),
    } as unknown as ReturnType<typeof createDb>)

    const events: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(e) {
        events.push(e)
      },
    }
    const result = await notifyBrokerErrorSurgeIfChanged({
      db: fakeD1,
      notifier,
      requestId: 'req-A',
    })
    expect(result.emitted).toBe(true)
    expect(result.surging).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'STATE_CHANGE',
      field: 'broker_error_surge',
      from: false,
      to: true,
      severity: 'critical',
      note: 'requestId=req-A',
    })
    // snapshot persist must run (delete then insert, exactly once)
    expect(deleteChain.where).toHaveBeenCalledTimes(1)
    expect(insertChain.values).toHaveBeenCalledTimes(1)
    const insertedRow = insertChain.values.mock.calls[0]![0]
    expect(insertedRow.value).toBe(JSON.stringify(true))
  })

  it('does NOT emit when previous=false and current=false (no surge)', async () => {
    const ordered: Array<unknown[]> = [[], [{ value: JSON.stringify(false) }]]
    const where = vi.fn(async () => ordered.shift() ?? [])
    const query = {
      from: vi.fn(() => query),
      where,
    }
    const deleteChain = { where: vi.fn(async () => undefined) }
    const insertChain = {
      values: vi.fn(async (_row: { value?: string; key?: string; snapshotAt?: string }) => undefined),
    }
    vi.mocked(createDb).mockReturnValue({
      select: vi.fn(() => query),
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => insertChain),
    } as unknown as ReturnType<typeof createDb>)

    const events: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(e) {
        events.push(e)
      },
    }
    const result = await notifyBrokerErrorSurgeIfChanged({ db: fakeD1, notifier })
    expect(result.emitted).toBe(false)
    expect(result.surging).toBe(false)
    expect(events).toHaveLength(0)
    // snapshot still re-persisted (idempotent — keeps snapshot_at fresh)
    expect(insertChain.values).toHaveBeenCalledTimes(1)
  })

  it('does NOT emit on continuous surge (true → true)', async () => {
    const errorRows = Array.from({ length: 7 }, () => ({ cause: 'broker_429' }))
    const ordered: Array<unknown[]> = [errorRows, [{ value: JSON.stringify(true) }]]
    const where = vi.fn(async () => ordered.shift() ?? [])
    const query = {
      from: vi.fn(() => query),
      where,
    }
    const deleteChain = { where: vi.fn(async () => undefined) }
    const insertChain = {
      values: vi.fn(async (_row: { value?: string; key?: string; snapshotAt?: string }) => undefined),
    }
    vi.mocked(createDb).mockReturnValue({
      select: vi.fn(() => query),
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => insertChain),
    } as unknown as ReturnType<typeof createDb>)

    const events: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(e) {
        events.push(e)
      },
    }
    const result = await notifyBrokerErrorSurgeIfChanged({ db: fakeD1, notifier })
    expect(result.emitted).toBe(false)
    expect(result.surging).toBe(true)
    expect(events).toHaveLength(0)
  })

  it('emits STATE_CHANGE info on resolve (true → false)', async () => {
    const ordered: Array<unknown[]> = [[], [{ value: JSON.stringify(true) }]]
    const where = vi.fn(async () => ordered.shift() ?? [])
    const query = {
      from: vi.fn(() => query),
      where,
    }
    const deleteChain = { where: vi.fn(async () => undefined) }
    const insertChain = {
      values: vi.fn(async (_row: { value?: string; key?: string; snapshotAt?: string }) => undefined),
    }
    vi.mocked(createDb).mockReturnValue({
      select: vi.fn(() => query),
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => insertChain),
    } as unknown as ReturnType<typeof createDb>)

    const events: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(e) {
        events.push(e)
      },
    }
    const result = await notifyBrokerErrorSurgeIfChanged({ db: fakeD1, notifier })
    expect(result.emitted).toBe(true)
    expect(result.surging).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'STATE_CHANGE',
      field: 'broker_error_surge',
      from: true,
      to: false,
      severity: 'info',
    })
    const insertedRow = insertChain.values.mock.calls[0]![0]
    expect(insertedRow.value).toBe(JSON.stringify(false))
  })

  it('persists snapshot even when notifier.notify() throws', async () => {
    // first surge, prev=false, notifier blows up
    const errorRows = Array.from({ length: 6 }, () => ({ cause: 'broker_5xx' }))
    const ordered: Array<unknown[]> = [errorRows, []]
    const where = vi.fn(async () => ordered.shift() ?? [])
    const query = {
      from: vi.fn(() => query),
      where,
    }
    const deleteChain = { where: vi.fn(async () => undefined) }
    const insertChain = {
      values: vi.fn(async (_row: { value?: string; key?: string; snapshotAt?: string }) => undefined),
    }
    vi.mocked(createDb).mockReturnValue({
      select: vi.fn(() => query),
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => insertChain),
    } as unknown as ReturnType<typeof createDb>)

    const notifier: Notifier = {
      async notify() {
        throw new Error('webhook down')
      },
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await notifyBrokerErrorSurgeIfChanged({ db: fakeD1, notifier })
    // notify rejected → emitted stays false, but snapshot still updated
    expect(result.emitted).toBe(false)
    expect(result.surging).toBe(true)
    expect(insertChain.values).toHaveBeenCalledTimes(1)
    const insertedRow = insertChain.values.mock.calls[0]![0]
    expect(insertedRow.value).toBe(JSON.stringify(true))
    warnSpy.mockRestore()
  })
})
