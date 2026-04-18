import { describe, expect, it, vi } from 'vitest'
import { isBridgeActive, parseBridgeRunMode } from '../../../src/trading/bridge/schedule'

const monJstNoon = new Date('2026-04-20T03:00:00.000Z') // Mon 12:00 JST
const satJstMidnight = new Date('2026-04-24T15:00:00.000Z') // Sat 00:00 JST (= Fri 15:00 UTC)
const monJstMidnight = new Date('2026-04-26T15:00:00.000Z') // Mon 00:00 JST (= Sun 15:00 UTC)

describe('parseBridgeRunMode', () => {
  it('defaults to auto when undefined / empty', () => {
    expect(parseBridgeRunMode(undefined)).toBe('auto')
    expect(parseBridgeRunMode('')).toBe('auto')
  })

  it('accepts the three enum values as-is', () => {
    expect(parseBridgeRunMode('always-on')).toBe('always-on')
    expect(parseBridgeRunMode('disabled')).toBe('disabled')
    expect(parseBridgeRunMode('auto')).toBe('auto')
  })

  it('falls back to auto on an unknown value (typo-safe)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseBridgeRunMode('yes')).toBe('auto')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('isBridgeActive', () => {
  it('auto: weekday JST → true', () => {
    expect(isBridgeActive(monJstNoon, 'auto')).toBe(true)
  })

  it('auto: crosses the day boundary in JST — Saturday 00:00 JST is weekend', () => {
    expect(isBridgeActive(satJstMidnight, 'auto')).toBe(false)
  })

  it('auto: crosses the day boundary in JST — Monday 00:00 JST is weekday', () => {
    expect(isBridgeActive(monJstMidnight, 'auto')).toBe(true)
  })

  it('auto: mid-Saturday JST → false', () => {
    expect(isBridgeActive(new Date('2026-04-25T03:00:00.000Z'), 'auto')).toBe(false) // Sat 12:00 JST
  })

  it('always-on: true regardless of day', () => {
    expect(isBridgeActive(satJstMidnight, 'always-on')).toBe(true)
  })

  it('disabled: false regardless of day', () => {
    expect(isBridgeActive(monJstNoon, 'disabled')).toBe(false)
  })

  it('defaults the mode to auto when omitted', () => {
    expect(isBridgeActive(monJstNoon)).toBe(true)
    expect(isBridgeActive(satJstMidnight)).toBe(false)
  })
})
