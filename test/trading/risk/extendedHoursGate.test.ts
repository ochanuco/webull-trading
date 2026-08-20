import { describe, expect, it } from 'vitest'
import {
  extendedHoursStatusToDecision,
  GATE_VALID_MINUTES_AFTER_OPEN,
  isWithinExtendedHoursGateWindow,
} from '../../../src/trading/risk/extendedHoursGate'

describe('extendedHoursStatusToDecision', () => {
  it('returns null for NORMAL (no-op, not included in the decision map)', () => {
    expect(extendedHoursStatusToDecision('NORMAL')).toBeNull()
  })

  it('returns null for UNKNOWN (fail-open, not included in the decision map)', () => {
    expect(extendedHoursStatusToDecision('UNKNOWN')).toBeNull()
  })

  it('returns reduce_entry (0.5x) for WARNING', () => {
    const decision = extendedHoursStatusToDecision('WARNING')
    expect(decision).toEqual({
      action: 'reduce_entry',
      multiplier: 0.5,
      reason: 'extended_hours: WARNING (premarket gap/stop proximity)',
    })
  })

  it('returns block_entry (0x) for STOP_AT_OPEN_CANDIDATE', () => {
    const decision = extendedHoursStatusToDecision('STOP_AT_OPEN_CANDIDATE')
    expect(decision).toEqual({
      action: 'block_entry',
      multiplier: 0,
      reason: 'extended_hours: STOP_AT_OPEN_CANDIDATE (premarket below effective stop)',
    })
  })

  it('returns null for an unrecognized status (defensive fail-open)', () => {
    expect(extendedHoursStatusToDecision('bogus')).toBeNull()
  })
})

describe('isWithinExtendedHoursGateWindow', () => {
  // 2026-04-20 (Mon) は US 休場日ではない (Good Friday は 2026-04-03)。EDT (UTC-4)
  // 期間なので ET = UTC - 4h。開場 09:30 ET = 13:30 UTC。
  it('is valid 30 minutes after US open (10:00 ET)', () => {
    const now = new Date('2026-04-20T14:00:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(true)
  })

  it('is valid exactly at US open (09:30 ET)', () => {
    const now = new Date('2026-04-20T13:30:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(true)
  })

  it(`is empty ${GATE_VALID_MINUTES_AFTER_OPEN} minutes after open or later (11:30 ET boundary)`, () => {
    const now = new Date('2026-04-20T15:30:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(false)
  })

  it('is empty 3 hours after open (12:30 ET, afternoon should not carry the morning warning)', () => {
    const now = new Date('2026-04-20T16:30:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(false)
  })

  it('is empty during pre-market (08:00 ET, before the regular open)', () => {
    const now = new Date('2026-04-20T12:00:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(false)
  })

  it('is empty on a weekend (Saturday 10:00 ET) even within the clock window', () => {
    const now = new Date('2026-04-18T14:00:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(false)
  })

  it('is empty on a US market holiday (2026-04-03 Good Friday, 10:00 ET)', () => {
    const now = new Date('2026-04-03T14:00:00.000Z')
    expect(isWithinExtendedHoursGateWindow(now)).toBe(false)
  })
})
