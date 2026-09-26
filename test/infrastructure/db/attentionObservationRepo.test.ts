import { type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'
import {
  createAttentionObservationRepo,
  type AttentionObservationDb,
  type AttentionObservationRecord,
} from '../../../src/infrastructure/db/attentionObservationRepo'

/** `attention_observation` の列数 (source, probeKey, metric, bucketAt, value, fetchedAt, requestId)。 */
const COLUMNS = 7
const CHUNK_SIZE = 14
const REMAINDER = 6

/** SQL fragment (`whereArgs`/`orderByArgs` に積まれる drizzle `SQL` オブジェクト) を検証用に文字列化する。 */
const dialect = new SQLiteSyncDialect()

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

  it('chunks 14 rows per multi-row INSERT (single subrequest per chunk), crossing the chunk boundary at a 6-row remainder', async () => {
    const records: AttentionObservationRecord[] = Array.from({ length: CHUNK_SIZE + REMAINDER }, (_, i) =>
      record({ bucketAt: `2026-07-24T${String(i % 24).padStart(2, '0')}:00:00.000Z` }),
    )
    const insertedPerChunk = [
      Array.from({ length: CHUNK_SIZE }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: REMAINDER }, (_, i) => ({ id: CHUNK_SIZE + i + 1 })),
    ]
    const { db, insertCalls } = makeFakeInsertDb({ insertedPerChunk })
    const repo = createAttentionObservationRepo(db)
    const result = await repo.bulkInsertIgnore(records)
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]!.values).toHaveLength(CHUNK_SIZE)
    expect(insertCalls[1]!.values).toHaveLength(REMAINDER)
    expect(result).toEqual({ inserted: CHUNK_SIZE + REMAINDER, skipped: 0 })
    // Bind count = columns × chunk rows must stay <= D1's 100-param limit
    // (CHUNK=50 previously exceeded it: 7 cols x 50 rows = 350).
    for (const call of insertCalls) {
      expect(call.values.length * COLUMNS).toBeLessThanOrEqual(100)
    }
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
      record({ bucketAt: '2026-07-24T14:30:00.000Z' }),
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

  it('fetchRecent selects and orders by bucketAt asc, with the actual where/orderBy SQL fragments (not just call counts) checked', async () => {
    const rows = [{ id: 1, bucketAt: '2026-07-24T14:30:00.000Z' }]
    const { db, whereArgs, orderByArgs } = makeFakeSelectDb(rows)
    const repo = createAttentionObservationRepo(db)
    const result = await repo.fetchRecent({
      source: 'gdelt',
      probeKey: 'trump_macro',
      metric: 'volume',
      sinceIso: '2026-07-24T00:00:00.000Z',
    })
    expect(result).toBe(rows)
    expect(db.select).toHaveBeenCalledTimes(1)
    expect(whereArgs).toHaveLength(1)
    const where = dialect.sqlToQuery(whereArgs[0] as SQL)
    expect(where.sql).toContain('"bucket_at" >= ?')
    expect(where.params).toEqual(['gdelt', 'trump_macro', 'volume', '2026-07-24T00:00:00.000Z'])
    expect(orderByArgs).toHaveLength(1)
    expect(dialect.sqlToQuery(orderByArgs[0] as SQL).sql).toBe('"attention_observation"."bucket_at" asc')
  })

  it('purgeOlderThan deletes and returns the deleted row count', async () => {
    const { db, whereArgs } = makeFakeDeleteDb([{ id: 1 }, { id: 2 }, { id: 3 }])
    const repo = createAttentionObservationRepo(db)
    const deleted = await repo.purgeOlderThan('2026-04-01T00:00:00.000Z')
    expect(deleted).toBe(3)
    expect(whereArgs).toHaveLength(1)
    const where = dialect.sqlToQuery(whereArgs[0] as SQL)
    expect(where.sql).toContain('"bucket_at" < ?')
    expect(where.params).toEqual(['2026-04-01T00:00:00.000Z'])
  })

  it('purgeOlderThan returns 0 when nothing matched', async () => {
    const { db, whereArgs } = makeFakeDeleteDb([])
    const repo = createAttentionObservationRepo(db)
    const deleted = await repo.purgeOlderThan('2026-04-01T00:00:00.000Z')
    expect(deleted).toBe(0)
    expect(whereArgs).toHaveLength(1)
    expect(dialect.sqlToQuery(whereArgs[0] as SQL).params).toEqual(['2026-04-01T00:00:00.000Z'])
  })
})
