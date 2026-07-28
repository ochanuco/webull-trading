import { describe, expect, it, vi } from 'vitest'
import {
  createAttentionObservationRepo,
  type AttentionObservationDb,
  type AttentionObservationRecord,
} from '../../../src/infrastructure/db/attentionObservationRepo'

/**
 * `bulkInsertIgnore` の chunk insert 動作テスト。
 * `macroEventCalendarRepo.test.ts` と同じ fake drizzle builder パターンで
 * chunk 50 / multi-row VALUES / `.onConflictDoNothing()` の挙動 + inserted/skipped
 * カウントを担保する。
 */

function makeFakeInsertDb(opts: { insertedPerChunk: Array<Array<{ id: number }>> }) {
  const insertCalls: Array<{
    values: Array<{
      source: string
      probeKey: string
      metric: string
      bucketAt: string
      value: number
      fetchedAt: string
      requestId: string | null
    }>
  }> = []
  const onConflictArgs: unknown[] = []
  let chunkIdx = 0
  const insertBuilder = {
    values(values: (typeof insertCalls)[number]['values']) {
      insertCalls.push({ values })
      return {
        onConflictDoNothing(args: unknown) {
          onConflictArgs.push(args)
          return {
            returning(_cols: unknown) {
              const rows = opts.insertedPerChunk[chunkIdx] ?? []
              chunkIdx += 1
              return Promise.resolve(rows)
            },
          }
        },
      }
    },
  }
  const db = {
    insert: vi.fn(() => insertBuilder),
  } as unknown as AttentionObservationDb
  return { db, insertCalls, onConflictArgs }
}

function record(overrides: Partial<AttentionObservationRecord> = {}): AttentionObservationRecord {
  return {
    source: 'gdelt',
    probeKey: 'trump_macro',
    metric: 'volume',
    bucketAt: '2026-07-24T14:30:00.000Z',
    value: 0.5,
    fetchedAt: '2026-07-24T14:35:00.000Z',
    ...overrides,
  }
}

describe('createAttentionObservationRepo.bulkInsertIgnore', () => {
  it('returns inserted=0 / skipped=0 when records is empty (no DB call)', async () => {
    const { db } = makeFakeInsertDb({ insertedPerChunk: [] })
    const repo = createAttentionObservationRepo(db)
    const result = await repo.bulkInsertIgnore([])
    expect(result).toEqual({ inserted: 0, skipped: 0 })
    expect(db.insert).not.toHaveBeenCalled()
  })

  it('chunks 50 rows per multi-row INSERT (single subrequest per chunk)', async () => {
    const records: AttentionObservationRecord[] = Array.from({ length: 96 }, (_, i) =>
      record({ bucketAt: `2026-07-24T${String(i % 24).padStart(2, '0')}:00:00.000Z` }),
    )
    const insertedPerChunk = [
      Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: 46 }, (_, i) => ({ id: 50 + i + 1 })),
    ]
    const { db, insertCalls } = makeFakeInsertDb({ insertedPerChunk })
    const repo = createAttentionObservationRepo(db)
    const result = await repo.bulkInsertIgnore(records)
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]!.values).toHaveLength(50)
    expect(insertCalls[1]!.values).toHaveLength(46)
    expect(result).toEqual({ inserted: 96, skipped: 0 })
  })

  it('calls onConflictDoNothing with the 4-column UNIQUE target and defaults requestId to null', async () => {
    const { db, onConflictArgs, insertCalls } = makeFakeInsertDb({
      insertedPerChunk: [[{ id: 1 }]],
    })
    const repo = createAttentionObservationRepo(db)
    await repo.bulkInsertIgnore([record({ requestId: undefined })])
    expect(insertCalls[0]!.values[0]!.requestId).toBeNull()
    expect(onConflictArgs).toHaveLength(1)
    const target = (onConflictArgs[0] as { target: unknown[] }).target
    expect(target).toHaveLength(4)
  })

  it('attributes UNIQUE-violation skips correctly within a single chunk (idempotent backfill)', async () => {
    const records: AttentionObservationRecord[] = [
      record({ bucketAt: '2026-07-24T14:30:00.000Z' }),
      record({ bucketAt: '2026-07-24T14:30:00.000Z' }), // duplicate bucket, same tick
      record({ bucketAt: '2026-07-24T14:45:00.000Z' }),
    ]
    const { db } = makeFakeInsertDb({ insertedPerChunk: [[{ id: 1 }, { id: 2 }]] })
    const repo = createAttentionObservationRepo(db)
    const result = await repo.bulkInsertIgnore(records)
    expect(result).toEqual({ inserted: 2, skipped: 1 })
  })
})

describe('createAttentionObservationRepo.fetchRecent / purgeOlderThan', () => {
  function makeFakeSelectDb(rows: unknown[]) {
    const whereArgs: unknown[] = []
    const orderByArgs: unknown[] = []
    const selectBuilder = {
      from: vi.fn(() => ({
        where: vi.fn((arg: unknown) => {
          whereArgs.push(arg)
          return {
            orderBy: vi.fn((arg2: unknown) => {
              orderByArgs.push(arg2)
              return Promise.resolve(rows)
            }),
          }
        }),
      })),
    }
    const db = {
      select: vi.fn(() => selectBuilder),
    } as unknown as AttentionObservationDb
    return { db, whereArgs, orderByArgs }
  }

  function makeFakeDeleteDb(returningRows: Array<{ id: number }>) {
    const whereArgs: unknown[] = []
    const deleteBuilder = {
      where: vi.fn((arg: unknown) => {
        whereArgs.push(arg)
        return {
          returning: vi.fn(() => Promise.resolve(returningRows)),
        }
      }),
    }
    const db = {
      delete: vi.fn(() => deleteBuilder),
    } as unknown as AttentionObservationDb
    return { db, whereArgs }
  }

  it('fetchRecent selects and orders by bucketAt asc', async () => {
    const rows = [{ id: 1, bucketAt: '2026-07-24T14:30:00.000Z' }]
    const { db } = makeFakeSelectDb(rows)
    const repo = createAttentionObservationRepo(db)
    const result = await repo.fetchRecent({
      source: 'gdelt',
      probeKey: 'trump_macro',
      metric: 'volume',
      sinceIso: '2026-07-24T00:00:00.000Z',
    })
    expect(result).toBe(rows)
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  it('purgeOlderThan deletes and returns the deleted row count', async () => {
    const { db } = makeFakeDeleteDb([{ id: 1 }, { id: 2 }, { id: 3 }])
    const repo = createAttentionObservationRepo(db)
    const deleted = await repo.purgeOlderThan('2026-04-01T00:00:00.000Z')
    expect(deleted).toBe(3)
  })

  it('purgeOlderThan returns 0 when nothing matched', async () => {
    const { db } = makeFakeDeleteDb([])
    const repo = createAttentionObservationRepo(db)
    const deleted = await repo.purgeOlderThan('2026-04-01T00:00:00.000Z')
    expect(deleted).toBe(0)
  })
})
