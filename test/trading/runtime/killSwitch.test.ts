import { describe, expect, it } from 'vitest'
import { resolveTradingEnabled } from '../../../src/trading/runtime/killSwitch'

describe('resolveTradingEnabled', () => {
  it('returns DB value when env is undefined', () => {
    expect(resolveTradingEnabled(true, undefined)).toBe(true)
    expect(resolveTradingEnabled(false, undefined)).toBe(false)
  })

  it("respects DB when env is the string 'true'", () => {
    expect(resolveTradingEnabled(true, 'true')).toBe(true)
    expect(resolveTradingEnabled(false, 'true')).toBe(false)
  })

  it("forces OFF when env is 'false' even if DB is true (#276)", () => {
    expect(resolveTradingEnabled(true, 'false')).toBe(false)
    expect(resolveTradingEnabled(false, 'false')).toBe(false)
  })

  it('fails closed (OFF) when env is a typo or empty string', () => {
    expect(resolveTradingEnabled(true, '')).toBe(false)
    expect(resolveTradingEnabled(true, 'TRUE')).toBe(false) // case-sensitive
    expect(resolveTradingEnabled(true, 'yes')).toBe(false)
    expect(resolveTradingEnabled(true, '1')).toBe(false)
  })
})
