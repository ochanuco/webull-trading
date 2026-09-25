import { describe, expect, it, vi } from 'vitest'
import {
  createEarningsCalendarRepo,
  type EarningsCalendarDb,
  type EarningsCalendarSeedInput,
} from '../../../src/infrastructure/calendar/earningsCalendarRepo'

/** `earnings_calendar` の列数 (symbol, earningsDate, notes)。 */
const COLUMNS = 3
const CHUNK_SIZE = 33
const REMAINDER = 7

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

describe('createEarningsCalendarRepo.bulkUpsert (#196: chunked multi-row insert, not 1 INSERT per row)', () => {
  it('returns inserted=0 / skipped=0 when records is empty', async () => {
    const { db } = makeFakeDb({ insertedPerChunk: [] })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert([])
    expect(result).toEqual({ inserted: 0, skipped: 0 })
  })

  it('chunks 33 rows per multi-row INSERT (single subrequest per chunk), crossing the chunk boundary at a 7-row remainder', async () => {
    const records: EarningsCalendarSeedInput[] = Array.from({ length: CHUNK_SIZE + REMAINDER }, (_, i) => ({
      symbol: `S${i}`,
      earningsDate: '2026-04-30',
      notes: null,
    }))
    const insertedPerChunk = [
      Array.from({ length: CHUNK_SIZE }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: REMAINDER - 1 }, (_, i) => ({ id: CHUNK_SIZE + i + 1 })),
    ]
    const { db, calls } = makeFakeDb({ insertedPerChunk })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.values).toHaveLength(CHUNK_SIZE)
    expect(calls[1]!.values).toHaveLength(REMAINDER)
    expect(result).toEqual({ inserted: CHUNK_SIZE + (REMAINDER - 1), skipped: 1 })
    // Bind count = columns × chunk rows must stay <= D1's 100-param limit
    // (CHUNK=50 previously exceeded it: 3 cols x 50 rows = 150).
    for (const call of calls) {
      expect(call.values.length * COLUMNS).toBeLessThanOrEqual(100)
    }
  })

  it('upper-cases symbol and applies notes ?? null per row', async () => {
    const records: EarningsCalendarSeedInput[] = [
      { symbol: 'aapl', earningsDate: '2026-04-30', notes: 'Q2' },
      { symbol: 'msft', earningsDate: '2026-04-29' },
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
      { symbol: 'AAPL', earningsDate: '2026-04-30' },
      { symbol: 'MSFT', earningsDate: '2026-04-29' },
    ]
    const { db } = makeFakeDb({ insertedPerChunk: [[{ id: 1 }, { id: 2 }]] })
    const repo = createEarningsCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(result).toEqual({ inserted: 2, skipped: 1 })
  })
})
