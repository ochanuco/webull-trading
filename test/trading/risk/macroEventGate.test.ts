import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MACRO_GATE_CONFIG,
  evaluateMacroEventGate,
  type MacroEventGateConfig,
} from '../../../src/trading/risk/macroEventGate'
import type {
  MacroEventCalendarRepo,
  MacroEventCalendarSeedInput,
} from '../../../src/infrastructure/calendar/macroEventCalendarRepo'
import type { MacroEventCalendarRow } from '../../../src/infrastructure/db/schema'

/**
 * Tests for the macro event gate (#196 2/3)。
 *
 * 観点:
 *   - event_time 指定: 発表前 1h / 発表後 6h 内 reject、外 approve (default)
 *   - event_time NULL: 当日全日 reject (default)
 *   - 範囲外 → approve
 *   - DB 失敗 → fail-closed reject
 *   - SELL は常に approve (撤退路を妨げない)
 *   - 不正 timestamp → fail-closed reject
 *   - 不正 event_time row → fail-closed reject (silent fail-open 防止)
 */

const baseConfig: MacroEventGateConfig = { ...DEFAULT_MACRO_GATE_CONFIG }

function row(
  type: string,
  date: string,
  time: string | null,
  id = 1,
): MacroEventCalendarRow {
  return {
    id,
    eventType: type.toUpperCase(),
    eventDate: date,
    eventTime: time,
    notes: null,
    createdAt: '2026-04-21T00:00:00.000Z',
  }
}

function fakeRepo(rows: MacroEventCalendarRow[]): MacroEventCalendarRepo & {
  calls: Array<{ from: string; to: string; type?: string }>
} {
  const calls: Array<{ from: string; to: string; type?: string }> = []
  return {
    calls,
    async fetchByDateRange(from, to, type) {
      calls.push(type !== undefined ? { from, to, type } : { from, to })
      return rows.filter((r) => {
        if (type !== undefined && r.eventType !== type.toUpperCase()) return false
        return r.eventDate >= from && r.eventDate <= to
      })
    },
    async fetchAll() {
      return rows
    },
    async bulkUpsert(_records: MacroEventCalendarSeedInput[]) {
      return { inserted: 0, skipped: 0 }
    },
    async deleteById(_id: number) {
      return false
    },
  }
}

describe('evaluateMacroEventGate — base behaviour', () => {
  it('approves when no rows are returned', async () => {
    const repo = fakeRepo([])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-17T18:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(repo.calls).toHaveLength(1)
  })

  it('always approves SELL regardless of nearby events', async () => {
    // FOMC at 2026-06-17 14:00 ET = 18:00 UTC (EDT)。同瞬間に SELL を評価。
    const repo = fakeRepo([row('FOMC', '2026-06-17', '14:00')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-17T18:00:00.000Z', side: 'SELL' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
    expect(repo.calls).toHaveLength(0)
  })
})

describe('evaluateMacroEventGate — event_time specified', () => {
  it('rejects when eval is exactly at the event time (FOMC 14:00 ET)', async () => {
    // 2026-06-17 14:00 ET (EDT, UTC-4) = 18:00 UTC
    const repo = fakeRepo([row('FOMC', '2026-06-17', '14:00')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-17T18:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('macro_event_gate: FOMC 2026-06-17 14:00ET')
    expect(decision.triggeringEvent).toEqual({
      type: 'FOMC',
      date: '2026-06-17',
      time: '14:00',
    })
  })

  it('rejects 30min before event (within freezeHoursBefore=1)', async () => {
    // CPI 08:30 ET (EDT) = 12:30 UTC、30 分前 = 12:00 UTC。
    const repo = fakeRepo([row('CPI', '2026-06-12', '08:30')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-12T12:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('CPI 2026-06-12 08:30ET')
  })

  it('rejects 30min after event (within freezeHoursAfter=6 default)', async () => {
    const repo = fakeRepo([row('NFP', '2026-06-05', '08:30')])
    // 09:00 ET (EDT) = 13:00 UTC
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-05T13:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('NFP 2026-06-05 08:30ET')
  })

  it('rejects 5h after event with default freezeHoursAfter=6', async () => {
    // CPI 08:30 ET (EDT) = 12:30 UTC、5h 後 = 17:30 UTC は default 6h 内で reject。
    const repo = fakeRepo([row('CPI', '2026-06-12', '08:30')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-12T17:30:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('CPI 2026-06-12 08:30ET')
  })

  it('approves >6h after event (outside default freezeHoursAfter=6)', async () => {
    // NFP 08:30 ET (EDT) = 12:30 UTC、6h+1min 後 = 18:31 UTC は default 6h を
    // 超えるので approve。
    const repo = fakeRepo([row('NFP', '2026-06-05', '08:30')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-05T18:31:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('approves 90min before event (outside ±1h window)', async () => {
    // CPI 08:30 ET、90 分前 = 07:00 ET = 11:00 UTC (EDT)
    const repo = fakeRepo([row('CPI', '2026-06-12', '08:30')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-12T11:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('approves 90min after event when freezeHoursAfter=1 override', async () => {
    // default は 6h だが、explicit 1h override で 90 分後は window 外。
    const repo = fakeRepo([row('NFP', '2026-06-05', '08:30')])
    // 10:00 ET (EDT) = 14:00 UTC
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-05T14:00:00.000Z', side: 'BUY' },
      repo,
      { freezeHoursBefore: 1, freezeHoursAfter: 1, freezeFullDayWhenTimeUnknown: true },
    )
    expect(decision.approved).toBe(true)
  })

  it('respects freezeHoursBefore/After overrides', async () => {
    // 2h 幅 → 90 分前なら reject されるはず
    const repo = fakeRepo([row('CPI', '2026-06-12', '08:30')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-12T11:00:00.000Z', side: 'BUY' },
      repo,
      { freezeHoursBefore: 2, freezeHoursAfter: 2, freezeFullDayWhenTimeUnknown: true },
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('CPI')
  })

  it('handles winter ET (EST = UTC-5) correctly', async () => {
    // FOMC 2026-12-16 14:00 EST = 19:00 UTC
    const repo = fakeRepo([row('FOMC', '2026-12-16', '14:00')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-12-16T19:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('FOMC 2026-12-16 14:00ET')
  })
})

describe('evaluateMacroEventGate — event_time NULL (full-day fallback)', () => {
  it('rejects on the event day when event_time is NULL and freezeFullDay=true', async () => {
    // ET の評価日が event_date と一致 → 全日凍結
    // 2026-07-01 12:00 UTC = 2026-07-01 08:00 EDT
    const repo = fakeRepo([row('GDP', '2026-07-01', null)])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-07-01T12:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toBe('macro_event_gate: GDP 2026-07-01 (full-day)')
    expect(decision.triggeringEvent).toEqual({
      type: 'GDP',
      date: '2026-07-01',
      time: null,
    })
  })

  it('approves NULL-time event one ET day before', async () => {
    // 2026-06-30 23:00 ET ≠ 2026-07-01。ET YMD で別日扱い。
    // 2026-07-01 02:59:59 UTC = 2026-06-30 22:59:59 EDT
    const repo = fakeRepo([row('GDP', '2026-07-01', null)])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-07-01T02:59:59.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(true)
  })

  it('skips NULL-time events when freezeFullDayWhenTimeUnknown=false', async () => {
    const repo = fakeRepo([row('GDP', '2026-07-01', null)])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-07-01T12:00:00.000Z', side: 'BUY' },
      repo,
      {
        freezeHoursBefore: 1,
        freezeHoursAfter: 1,
        freezeFullDayWhenTimeUnknown: false,
      },
    )
    expect(decision.approved).toBe(true)
  })
})

describe('evaluateMacroEventGate — fail-closed paths', () => {
  it('rejects when D1 read throws (fail-closed)', async () => {
    const repo: MacroEventCalendarRepo = {
      async fetchByDateRange() {
        throw new Error('d1 connection lost')
      },
      async fetchAll() {
        return []
      },
      async bulkUpsert() {
        return { inserted: 0, skipped: 0 }
      },
      async deleteById() {
        return false
      },
    }
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-17T18:00:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('macro_event_gate_fetch_failed')
    expect(decision.reason).toContain('d1 connection lost')
  })

  it('rejects on invalid evalTimestamp', async () => {
    const repo = fakeRepo([])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: 'not-a-timestamp', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('macro_event_gate_invalid_eval_timestamp')
  })

  it('rejects when calendar row has invalid event_time (silent fail-open prevention)', async () => {
    // event_time が `HH:MM` 規格を満たさない row は parse できない。
    // continue (silent skip) すると当該 event だけ BUY 素通り = fail-open に
    // なるため、fail-closed で reject させる。
    const repo = fakeRepo([row('CPI', '2026-06-12', 'invalid-time')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-12T12:30:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('macro_event_gate_invalid_calendar_row')
    expect(decision.reason).toContain('CPI 2026-06-12 invalid-time')
    expect(decision.triggeringEvent).toEqual({
      type: 'CPI',
      date: '2026-06-12',
      time: 'invalid-time',
    })
  })

  it('rejects when calendar row has malformed event_time like "8:30" (silent fail-open prevention)', async () => {
    // 規格は `HH:MM` (2 桁:2 桁)。`8:30` のような 1 桁時間は弾く。
    const repo = fakeRepo([row('NFP', '2026-06-05', '8:30')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-05T12:30:00.000Z', side: 'BUY' },
      repo,
      baseConfig,
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('macro_event_gate_invalid_calendar_row')
  })
})

describe('evaluateMacroEventGate — config sanitisation', () => {
  it('clamps negative freezeHoursBefore/After to default (1h each)', async () => {
    // negative → default 1h。FOMC 14:00 ET ±1h で 13:30 ET (= 17:30 UTC) は
    // window 内で reject されるはず。
    const repo = fakeRepo([row('FOMC', '2026-06-17', '14:00')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-17T17:30:00.000Z', side: 'BUY' },
      repo,
      { freezeHoursBefore: -3, freezeHoursAfter: -3, freezeFullDayWhenTimeUnknown: true },
    )
    expect(decision.approved).toBe(false)
  })

  it('clamps absurdly large freezeHours to 6h', async () => {
    // FOMC 14:00 ET、5h 後 = 19:00 ET = 23:00 UTC は cap=6 なら reject。
    const repo = fakeRepo([row('FOMC', '2026-06-17', '14:00')])
    const decision = await evaluateMacroEventGate(
      { evalTimestamp: '2026-06-17T23:00:00.000Z', side: 'BUY' },
      repo,
      { freezeHoursBefore: 9999, freezeHoursAfter: 9999, freezeFullDayWhenTimeUnknown: true },
    )
    expect(decision.approved).toBe(false)
    expect(decision.reason).toContain('FOMC')
  })
})
