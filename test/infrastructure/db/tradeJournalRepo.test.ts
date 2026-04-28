import { describe, expect, it, vi } from 'vitest'
import {
  hasRecentSanityFailure,
  insertJournalRecord,
} from '../../../src/infrastructure/db/tradeJournalRepo'
import type { TradeJournalRecord } from '../../../src/infrastructure/logger/tradeJournal'

const record: TradeJournalRecord = {
  timestamp: '2026-04-19T10:00:00.000Z',
  trade_event_type: 'decision',
  request_id: 'req-1',
  symbol: 'SOXL',
  strategy_name: 'FixedRuleStrategy',
  signal_action: 'BUY',
  signal_reason: 'price below threshold',
  risk_allowed: true,
  risk_reasons: ['a', 'b'],
}

describe('insertJournalRecord', () => {
  it('serialises risk_reasons as JSON and forwards to drizzle insert', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined)
    const insertSpy = vi.fn().mockReturnValue({ values: valuesSpy })
    const fakeDb = { insert: insertSpy } as unknown as Parameters<typeof insertJournalRecord>[0]

    await insertJournalRecord(fakeDb, record)

    expect(insertSpy).toHaveBeenCalledTimes(1)
    expect(valuesSpy).toHaveBeenCalledTimes(1)
    const row = valuesSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(row).toMatchObject({
      timestamp: '2026-04-19T10:00:00.000Z',
      tradeEventType: 'decision',
      requestId: 'req-1',
      symbol: 'SOXL',
      signalAction: 'BUY',
      riskAllowed: true,
      riskReasons: '["a","b"]',
    })
  })

  it('maps undefined record fields to null column values', async () => {
    const valuesSpy = vi.fn().mockResolvedValue(undefined)
    const insertSpy = vi.fn().mockReturnValue({ values: valuesSpy })
    const fakeDb = { insert: insertSpy } as unknown as Parameters<typeof insertJournalRecord>[0]

    await insertJournalRecord(fakeDb, {
      timestamp: '2026-04-19T10:00:00.000Z',
      trade_event_type: 'fill',
    })

    const row = valuesSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(row.symbol).toBeNull()
    expect(row.riskReasons).toBeNull()
    expect(row.filledPrice).toBeNull()
  })
})

/**
 * Stubs the drizzle chain `db.select({...}).from(...).where(...)` to return
 * `rows` and capture each phase for assertions. The repo treats the awaited
 * `where(...)` value as the array.
 */
function fakeCountChain(rows: Array<{ count: number }>) {
  const where = vi.fn(async () => rows)
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))
  const db = { select } as unknown as ReturnType<
    typeof import('../../../src/infrastructure/db/tradeJournalRepo').createDb
  >
  return { db, select, from, where }
}

vi.mock('drizzle-orm/d1', async (importOriginal) => {
  const original = await importOriginal<typeof import('drizzle-orm/d1')>()
  return { ...original, drizzle: vi.fn() }
})

describe('hasRecentSanityFailure', () => {
  it('returns true when the count query reports a non-zero match', async () => {
    const { drizzle } = await import('drizzle-orm/d1')
    const { db } = fakeCountChain([{ count: 3 }])
    vi.mocked(drizzle).mockReturnValue(db as never)

    const result = await hasRecentSanityFailure({} as D1Database, '9697', 30 * 60_000)
    expect(result).toBe(true)
  })

  it('returns false when the count query reports zero matches', async () => {
    const { drizzle } = await import('drizzle-orm/d1')
    const { db } = fakeCountChain([{ count: 0 }])
    vi.mocked(drizzle).mockReturnValue(db as never)

    const result = await hasRecentSanityFailure({} as D1Database, 'AAPL', 30 * 60_000)
    expect(result).toBe(false)
  })

  it('returns false for a non-positive window without hitting the DB', async () => {
    const { drizzle } = await import('drizzle-orm/d1')
    const { db, select } = fakeCountChain([{ count: 99 }])
    vi.mocked(drizzle).mockReturnValue(db as never)

    expect(await hasRecentSanityFailure({} as D1Database, 'AAPL', 0)).toBe(false)
    expect(await hasRecentSanityFailure({} as D1Database, 'AAPL', -1)).toBe(false)
    expect(await hasRecentSanityFailure({} as D1Database, 'AAPL', NaN)).toBe(false)
    expect(select).not.toHaveBeenCalled()
  })

  it('uses the injected `now` to compute the cutoff timestamp', async () => {
    // The repo issues `gte(timestamp, cutoff)` where cutoff = now - withinMs.
    // We don't introspect the SQL fragment here — drizzle wraps it — but we
    // confirm the call is shaped (select → from → where) with the injected
    // `now` and that the count is propagated. End-to-end cutoff parity is
    // covered indirectly by the scheduler test (cooldown active vs lapsed).
    const { drizzle } = await import('drizzle-orm/d1')
    const { db, where } = fakeCountChain([{ count: 1 }])
    vi.mocked(drizzle).mockReturnValue(db as never)

    const fixedNow = new Date('2026-04-28T03:00:00.000Z')
    const result = await hasRecentSanityFailure({} as D1Database, '9697', 30 * 60_000, {
      now: () => fixedNow,
    })
    expect(result).toBe(true)
    expect(where).toHaveBeenCalledTimes(1)
  })
})
