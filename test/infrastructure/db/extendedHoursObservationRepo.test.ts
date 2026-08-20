import { describe, expect, it, vi } from 'vitest'
import {
  createExtendedHoursObservationRepo,
  type ExtendedHoursObservationDb,
  type ExtendedHoursObservationRecord,
} from '../../../src/infrastructure/db/extendedHoursObservationRepo'

function record(overrides: Partial<ExtendedHoursObservationRecord> = {}): ExtendedHoursObservationRecord {
  return {
    symbol: 'SOXL',
    capturedAt: '2026-05-20T13:15:00.000Z',
    sessionYmd: '2026-05-20',
    status: 'NORMAL',
    ...overrides,
  }
}

describe('createExtendedHoursObservationRepo.insertMany', () => {
  it('returns inserted=0 when records is empty (no DB call)', async () => {
    const insert = vi.fn()
    const db = { insert } as unknown as ExtendedHoursObservationDb
    const repo = createExtendedHoursObservationRepo(db)
    const result = await repo.insertMany([])
    expect(result).toEqual({ inserted: 0 })
    expect(insert).not.toHaveBeenCalled()
  })

  it('chunks 7 rows per multi-row INSERT (D1 100-bound-param guard, 13 columns)', async () => {
    // 10 = CHUNK(7) + 端数(3) — チャンク境界をまたぐ件数を維持する。
    const records = Array.from({ length: 10 }, (_, i) => record({ symbol: `SYM${i}` }))
    const valuesCalls: unknown[][] = []
    const insert = vi.fn(() => ({
      values: vi.fn((v: unknown[]) => {
        valuesCalls.push(v)
        return Promise.resolve({ success: true })
      }),
    }))
    const db = { insert } as unknown as ExtendedHoursObservationDb
    const repo = createExtendedHoursObservationRepo(db)
    const result = await repo.insertMany(records)
    expect(valuesCalls).toHaveLength(2)
    expect(valuesCalls[0]).toHaveLength(7)
    expect(valuesCalls[1]).toHaveLength(3)
    expect(result).toEqual({ inserted: 10 })
    for (const call of valuesCalls) {
      expect(call.length * 13).toBeLessThanOrEqual(100)
    }
  })

  it('defaults optional nullable fields to null', async () => {
    let captured: Array<{ preMarketLast: number | null; requestId: string | null }> = []
    const insert = vi.fn(() => ({
      values: vi.fn((v: typeof captured) => {
        captured = v
        return Promise.resolve({ success: true })
      }),
    }))
    const db = { insert } as unknown as ExtendedHoursObservationDb
    const repo = createExtendedHoursObservationRepo(db)
    await repo.insertMany([record({ preMarketLast: undefined, requestId: undefined })])
    expect(captured[0]!.preMarketLast).toBeNull()
    expect(captured[0]!.requestId).toBeNull()
  })
})

describe('createExtendedHoursObservationRepo.latestPerSymbol / recent', () => {
  it('latestPerSymbol resolves MAX(id) per symbol then fetches those rows', async () => {
    const groupByResult = [{ maxId: 5 }, { maxId: 9 }]
    const rows = [{ id: 5, symbol: 'AAPL' }, { id: 9, symbol: 'SOXL' }]
    const whereArgs: unknown[] = []
    let selectCall = 0
    const select = vi.fn(() => {
      selectCall += 1
      if (selectCall === 1) {
        // first call: select({ maxId: max(id) }).from().where().groupBy()
        return {
          from: vi.fn(() => ({
            where: vi.fn((arg: unknown) => {
              whereArgs.push(arg)
              return { groupBy: vi.fn(() => Promise.resolve(groupByResult)) }
            }),
          })),
        }
      }
      // second call: select().from().where(inArray).orderBy()
      return {
        from: vi.fn(() => ({
          where: vi.fn((arg: unknown) => {
            whereArgs.push(arg)
            return { orderBy: vi.fn(() => Promise.resolve(rows)) }
          }),
        })),
      }
    })
    const db = { select } as unknown as ExtendedHoursObservationDb
    const repo = createExtendedHoursObservationRepo(db)
    const result = await repo.latestPerSymbol('2026-05-20')
    expect(result).toBe(rows)
    expect(select).toHaveBeenCalledTimes(2)
    expect(whereArgs).toHaveLength(2)
  })

  it('latestPerSymbol returns [] without a second query when no rows for the session', async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ groupBy: vi.fn(() => Promise.resolve([])) })),
      })),
    }))
    const db = { select } as unknown as ExtendedHoursObservationDb
    const repo = createExtendedHoursObservationRepo(db)
    const result = await repo.latestPerSymbol('2026-05-20')
    expect(result).toEqual([])
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('recent orders by id desc and applies limit', async () => {
    const rows = [{ id: 3 }, { id: 2 }, { id: 1 }]
    const limitFn = vi.fn(() => Promise.resolve(rows))
    const orderByFn = vi.fn(() => ({ limit: limitFn }))
    const select = vi.fn(() => ({ from: vi.fn(() => ({ orderBy: orderByFn })) }))
    const db = { select } as unknown as ExtendedHoursObservationDb
    const repo = createExtendedHoursObservationRepo(db)
    const result = await repo.recent(50)
    expect(result).toBe(rows)
    expect(limitFn).toHaveBeenCalledWith(50)
  })
})
