import { type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { describe, expect, it, vi } from 'vitest'
import {
  createAttentionObservationRepo,
  type AttentionObservationDb,
  type AttentionObservationRecord,
} from '../../../src/infrastructure/db/attentionObservationRepo'

/**
 * `bulkInsertIgnore` の chunk insert 動作テスト。
 * `macroEventCalendarRepo.test.ts` と同じ fake drizzle builder パターンで
 * chunk 14 / multi-row VALUES / `.onConflictDoNothing()` の挙動 + inserted/skipped
 * カウントを担保する。
 */

/** `attention_observation` の列数 (source, probeKey, metric, bucketAt, value, fetchedAt, requestId)。 */
const COLUMNS = 7

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

  it('chunks 14 rows per multi-row INSERT (single subrequest per chunk)', async () => {
    // 20 = CHUNK(14) + 端数(6) — チャンク境界をまたぐ件数を維持する。
    const records: AttentionObservationRecord[] = Array.from({ length: 20 }, (_, i) =>
      record({ bucketAt: `2026-07-24T${String(i % 24).padStart(2, '0')}:00:00.000Z` }),
    )
    const insertedPerChunk = [
      Array.from({ length: 14 }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: 6 }, (_, i) => ({ id: 14 + i + 1 })),
    ]
    const { db, insertCalls } = makeFakeInsertDb({ insertedPerChunk })
    const repo = createAttentionObservationRepo(db)
    const result = await repo.bulkInsertIgnore(records)
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]!.values).toHaveLength(14)
    expect(insertCalls[1]!.values).toHaveLength(6)
    expect(result).toEqual({ inserted: 20, skipped: 0 })
    // D1 の bound parameter 上限は 1 クエリあたり 100 個。multi-row INSERT の bind
    // 数は `列数 × チャンクの行数` なので、これを超えないことを再発防止ガードとして
    // 各チャンクで検証する (CHUNK=50 のままだと 7 列 × 50 行 = 350 bind で超過していた)。
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
    // CodeRabbit: 呼び出し回数だけでなく、実際に where/orderBy へ渡された
    // drizzle SQL fragment の中身 (filter / ordering) を軽く検証する。
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
