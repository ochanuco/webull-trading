import { describe, expect, it, vi } from 'vitest'
import { isBridgeActive, parseBridgeRunMode } from '../../../src/trading/bridge/schedule'

const weekday = new Date('2026-04-20T12:00:00.000Z') // Mon
const weekend = new Date('2026-04-25T12:00:00.000Z') // Sat

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
  it('auto: weekday UTC → true, weekend → false', () => {
    expect(isBridgeActive(weekday, 'auto')).toBe(true)
    expect(isBridgeActive(weekend, 'auto')).toBe(false)
  })

  it('always-on: true regardless of day', () => {
    expect(isBridgeActive(weekday, 'always-on')).toBe(true)
    expect(isBridgeActive(weekend, 'always-on')).toBe(true)
  })

  it('disabled: false regardless of day', () => {
    expect(isBridgeActive(weekday, 'disabled')).toBe(false)
    expect(isBridgeActive(weekend, 'disabled')).toBe(false)
  })

  it('defaults the mode to auto when omitted', () => {
    expect(isBridgeActive(weekday)).toBe(true)
    expect(isBridgeActive(weekend)).toBe(false)
  })
})
