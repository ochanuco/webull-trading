import { describe, expect, it } from 'vitest'
import { isBridgeActive } from '../../../src/trading/bridge/schedule'

describe('isBridgeActive', () => {
  it('returns true Mon-Fri UTC', () => {
    expect(isBridgeActive(new Date('2026-04-20T12:00:00.000Z'))).toBe(true) // Mon
    expect(isBridgeActive(new Date('2026-04-21T12:00:00.000Z'))).toBe(true) // Tue
    expect(isBridgeActive(new Date('2026-04-24T23:00:00.000Z'))).toBe(true) // Fri
  })

  it('returns false on Saturday and Sunday UTC', () => {
    expect(isBridgeActive(new Date('2026-04-25T12:00:00.000Z'))).toBe(false) // Sat
    expect(isBridgeActive(new Date('2026-04-26T12:00:00.000Z'))).toBe(false) // Sun
  })
})
