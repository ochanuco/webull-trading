import { describe, expect, it, vi } from 'vitest'
import { insertJournalRecord } from '../../../src/infrastructure/db/tradeJournalRepo'
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
