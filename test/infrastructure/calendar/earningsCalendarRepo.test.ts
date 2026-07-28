import { describe, expect, it, vi } from 'vitest'
import {
  createEarningsCalendarRepo,
  type EarningsCalendarDb,
  type EarningsCalendarSeedInput,
} from '../../../src/infrastructure/calendar/earningsCalendarRepo'

/**
 * `bulkUpsert` の chunk insert 動作テスト (CodeRabbit #196 review)。
 *
 * 過去仕様は 1 row につき 1 INSERT 文を発行 (records.length 回 await) → 1000 行
 * で D1 subrequest 制限に達する。修正後は 33 行 chunk で multi-row VALUES に
 * まとめる (drizzle `.values([...])`)。`.onConflictDoNothing()` の挙動 (UNIQUE
 * 違反 row だけ skip)、`.returning()` の戻り行数による inserted/skipped カウントも
 * 維持する。
 */

/** `earnings_calendar` の列数 (symbol, earningsDate, notes)。 */
const COLUMNS = 3

function makeFakeDb(opts: {
  /** chunk index → returning rows (id) */
  insertedPerChunk: Array<Array<{ id: number }>>
}) {
  const calls: Array<{ values: Array<EarningsCalendarSeedInput & { symbol: string }> }> = []
  let chunkIdx = 0
  const builder = {
    values(values: Array<EarningsCalendarSeedInput & { symbol: string }>) {
      calls.push({ values })
      return {
        onConflictDoNothing(_args: unknown) {
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
    insert: vi.fn(() => builder),
  } as unknown as EarningsCalendarDb
  return { db, calls }
}

describe('createEarningsCalendarRepo.bulkUpsert', () => {
  it('returns inserted=0 / skipped=0 when records is empty', async () => {
    const { db } = makeFakeDb({ insertedPerChunk: [] })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert([])
    expect(result).toEqual({ inserted: 0, skipped: 0 })
  })

  it('chunks 33 rows per multi-row INSERT (single subrequest per chunk)', async () => {
    // 40 = CHUNK(33) + 端数(7) — チャンク境界をまたぐ件数を維持する。
    const records: EarningsCalendarSeedInput[] = Array.from({ length: 40 }, (_, i) => ({
      symbol: `S${i}`,
      earningsDate: '2026-04-30',
      notes: null,
    }))
    // chunk 0 (33 rows): all inserted, chunk 1 (7 rows): 1 conflict skipped.
    const insertedPerChunk = [
      Array.from({ length: 33 }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: 6 }, (_, i) => ({ id: 33 + i + 1 })),
    ]
    const { db, calls } = makeFakeDb({ insertedPerChunk })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    // 2 chunks → 2 INSERT statements。1 行あたり 1 INSERT ではないことを保証。
    expect(calls).toHaveLength(2)
    expect(calls[0]!.values).toHaveLength(33)
    expect(calls[1]!.values).toHaveLength(7)
    // inserted は returning() の合計、skipped は chunk size との差分。
    expect(result).toEqual({ inserted: 33 + 6, skipped: 1 })
    // D1 の bound parameter 上限は 1 クエリあたり 100 個。multi-row INSERT の bind
    // 数は `列数 × チャンクの行数` なので、これを超えないことを再発防止ガードとして
    // 各チャンクで検証する (CHUNK=50 のままだと 3 列 × 50 行 = 150 bind で超過していた)。
    for (const call of calls) {
      expect(call.values.length * COLUMNS).toBeLessThanOrEqual(100)
    }
  })

  it('upper-cases symbol and applies notes ?? null per row', async () => {
    const records: EarningsCalendarSeedInput[] = [
      { symbol: 'aapl', earningsDate: '2026-04-30', notes: 'Q2' },
      { symbol: 'msft', earningsDate: '2026-04-29' }, // notes omitted
    ]
    const { db, calls } = makeFakeDb({
      insertedPerChunk: [[{ id: 1 }, { id: 2 }]],
    })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toEqual([
      { symbol: 'AAPL', earningsDate: '2026-04-30', notes: 'Q2' },
      { symbol: 'MSFT', earningsDate: '2026-04-29', notes: null },
    ])
    expect(result).toEqual({ inserted: 2, skipped: 0 })
  })

  it('attributes UNIQUE-violation skips correctly within a single chunk', async () => {
    const records: EarningsCalendarSeedInput[] = [
      { symbol: 'AAPL', earningsDate: '2026-04-30' },
      { symbol: 'AAPL', earningsDate: '2026-04-30' }, // duplicate
      { symbol: 'MSFT', earningsDate: '2026-04-29' },
    ]
    // returning() returns only the 2 actually-inserted rows (1 was a conflict).
    const { db } = makeFakeDb({ insertedPerChunk: [[{ id: 1 }, { id: 2 }]] })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(result).toEqual({ inserted: 2, skipped: 1 })
  })
})
