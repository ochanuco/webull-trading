import { describe, expect, it, vi } from 'vitest'
import {
  createMacroEventCalendarRepo,
  type MacroEventCalendarDb,
  type MacroEventCalendarSeedInput,
} from '../../../src/infrastructure/calendar/macroEventCalendarRepo'

/**
 * `bulkUpsert` の chunk insert 動作テスト (issue #196 2/3、CodeRabbit 同型)。
 * `earningsCalendarRepo.test.ts` と同パターンで chunk 25 / multi-row VALUES /
 * `.onConflictDoNothing()` の挙動 + inserted/skipped カウントを担保する。
 */

/** `macro_event_calendar` の列数 (eventType, eventDate, eventTime, notes)。 */
const COLUMNS = 4

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

  it('chunks 25 rows per multi-row INSERT (single subrequest per chunk)', async () => {
    // 30 = CHUNK(25) + 端数(5) — チャンク境界をまたぐ件数を維持する。
    const records: MacroEventCalendarSeedInput[] = Array.from({ length: 30 }, (_, i) => ({
      eventType: 'CPI',
      eventDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
      eventTime: '08:30',
      notes: null,
    }))
    const insertedPerChunk = [
      Array.from({ length: 25 }, (_, i) => ({ id: i + 1 })),
      Array.from({ length: 4 }, (_, i) => ({ id: 25 + i + 1 })),
    ]
    const { db, calls } = makeFakeDb({ insertedPerChunk })
    const repo = createMacroEventCalendarRepo(db)
    const result = await repo.bulkUpsert(records)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.values).toHaveLength(25)
    expect(calls[1]!.values).toHaveLength(5)
    expect(result).toEqual({ inserted: 25 + 4, skipped: 1 })
    // D1 の bound parameter 上限は 1 クエリあたり 100 個。multi-row INSERT の bind
    // 数は `列数 × チャンクの行数` なので、これを超えないことを再発防止ガードとして
    // 各チャンクで検証する (CHUNK=50 のままだと 4 列 × 50 行 = 200 bind で超過していた)。
    for (const call of calls) {
      expect(call.values.length * COLUMNS).toBeLessThanOrEqual(100)
    }
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
