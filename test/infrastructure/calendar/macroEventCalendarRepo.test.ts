import { describe, expect, it, vi } from 'vitest'
import {
  createMacroEventCalendarRepo,
  type MacroEventCalendarDb,
  type MacroEventCalendarSeedInput,
} from '../../../src/infrastructure/calendar/macroEventCalendarRepo'

/** `macro_event_calendar` の列数 (eventType, eventDate, eventTime, notes)。 */
const COLUMNS = 4
const CHUNK_SIZE = 25
const REMAINDER = 5

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

describe('createMacroEventCalendarRepo.bulkUpsert (#196 2/3: chunked multi-row insert, same pattern as earningsCalendarRepo)', () => {
  it('returns inserted=0 / skipped=0 when records is empty', async () => {
    const { db } = makeFakeDb({ insertedPerChunk: [] })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert([])
    expect(result).toEqual({ inserted: 0, skipped: 0 })
  })

  it('chunks 25 rows per multi-row INSERT (single subrequest per chunk), crossing the chunk boundary at a 5-row remainder', async () => {
    // Spans multiple years so all 30 event_date values stay unique under
    // (event_type, event_date) — cycling months alone would collide from row 13 on.
    const records: MacroEventCalendarSeedInput[] = Array.from({ length: CHUNK_SIZE + REMAINDER }, (_, i) => ({
      eventType: 'CPI',
      eventDate: `${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-15`,
      eventTime: '08:30',
      notes: null,
    }))
    const insertedPerChunk = [
      Array.from({ length: CHUNK_SIZE }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: REMAINDER - 1 }, (_, i) => ({ id: CHUNK_SIZE + i + 1 })),
    ]
    const { db, calls } = makeFakeDb({ insertedPerChunk })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.values).toHaveLength(CHUNK_SIZE)
    expect(calls[1]!.values).toHaveLength(REMAINDER)
    expect(result).toEqual({ inserted: CHUNK_SIZE + (REMAINDER - 1), skipped: 1 })
    // Bind count = columns × chunk rows must stay <= D1's 100-param limit
    // (CHUNK=50 previously exceeded it: 4 cols x 50 rows = 200).
    for (const call of calls) {
      expect(call.values.length * COLUMNS).toBeLessThanOrEqual(100)
    }
  })

  it('upper-cases event_type, applies notes/event_time ?? null per row', async () => {
    const records: MacroEventCalendarSeedInput[] = [
      { eventType: 'fomc', eventDate: '2026-06-17', eventTime: '14:00', notes: 'June FOMC' },
      { eventType: 'gdp', eventDate: '2026-07-01', eventTime: null },
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
      { eventType: 'FOMC', eventDate: '2026-06-17', eventTime: '14:00' },
      { eventType: 'CPI', eventDate: '2026-06-12', eventTime: '08:30' },
    ]
    const { db } = makeFakeDb({ insertedPerChunk: [[{ id: 1 }, { id: 2 }]] })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(result).toEqual({ inserted: 2, skipped: 1 })
  })
})
