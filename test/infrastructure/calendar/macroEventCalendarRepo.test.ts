import { describe, expect, it, vi } from 'vitest'
import {
  createMacroEventCalendarRepo,
  type MacroEventCalendarDb,
  type MacroEventCalendarSeedInput,
} from '../../../src/infrastructure/calendar/macroEventCalendarRepo'

/**
 * `bulkUpsert` の chunk insert 動作テスト (issue #196 2/3、CodeRabbit 同型)。
 * `earningsCalendarRepo.test.ts` と同パターンで chunk 50 / multi-row VALUES /
 * `.onConflictDoNothing()` の挙動 + inserted/skipped カウントを担保する。
 */

function makeFakeDb(opts: {
  insertedPerChunk: Array<Array<{ id: number }>>
}) {
  const calls: Array<{
    values: Array<{
      eventType: string
      eventDate: string
      eventTime: string | null
      notes: string | null
    }>
  }> = []
  let chunkIdx = 0
  const builder = {
    values(values: Array<{
      eventType: string
      eventDate: string
      eventTime: string | null
      notes: string | null
    }>) {
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
  } as unknown as MacroEventCalendarDb
  return { db, calls }
}

describe('createMacroEventCalendarRepo.bulkUpsert', () => {
  it('returns inserted=0 / skipped=0 when records is empty', async () => {
    const { db } = makeFakeDb({ insertedPerChunk: [] })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert([])
    expect(result).toEqual({ inserted: 0, skipped: 0 })
  })

  it('chunks 50 rows per multi-row INSERT (single subrequest per chunk)', async () => {
    const records: MacroEventCalendarSeedInput[] = Array.from({ length: 120 }, (_, i) => ({
      eventType: 'CPI',
      eventDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
      eventTime: '08:30',
      notes: null,
    }))
    const insertedPerChunk = [
      Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: 49 }, (_, i) => ({ id: 50 + i + 1 })),
      Array.from({ length: 20 }, (_, i) => ({ id: 100 + i + 1 })),
    ]
    const { db, calls } = makeFakeDb({ insertedPerChunk })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(calls).toHaveLength(3)
    expect(calls[0]!.values).toHaveLength(50)
    expect(calls[1]!.values).toHaveLength(50)
    expect(calls[2]!.values).toHaveLength(20)
    expect(result).toEqual({ inserted: 50 + 49 + 20, skipped: 1 })
  })

  it('upper-cases event_type, applies notes/event_time ?? null per row', async () => {
    const records: MacroEventCalendarSeedInput[] = [
      { eventType: 'fomc', eventDate: '2026-06-17', eventTime: '14:00', notes: 'June FOMC' },
      { eventType: 'gdp', eventDate: '2026-07-01', eventTime: null }, // notes omitted
    ]
    const { db, calls } = makeFakeDb({
      insertedPerChunk: [[{ id: 1 }, { id: 2 }]],
    })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.values).toEqual([
      { eventType: 'FOMC', eventDate: '2026-06-17', eventTime: '14:00', notes: 'June FOMC' },
      { eventType: 'GDP', eventDate: '2026-07-01', eventTime: null, notes: null },
    ])
    expect(result).toEqual({ inserted: 2, skipped: 0 })
  })

  it('attributes UNIQUE-violation skips correctly within a single chunk', async () => {
    const records: MacroEventCalendarSeedInput[] = [
      { eventType: 'FOMC', eventDate: '2026-06-17', eventTime: '14:00' },
      { eventType: 'FOMC', eventDate: '2026-06-17', eventTime: '14:00' }, // duplicate
      { eventType: 'CPI', eventDate: '2026-06-12', eventTime: '08:30' },
    ]
    const { db } = makeFakeDb({ insertedPerChunk: [[{ id: 1 }, { id: 2 }]] })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(result).toEqual({ inserted: 2, skipped: 1 })
  })
})
