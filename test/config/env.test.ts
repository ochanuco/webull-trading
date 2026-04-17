import { describe, expect, it } from 'vitest'
import { parseBooleanEnv, parseCsvEnv, parseNumberEnv, parseSymbolNotionalMap } from '../../src/config/env'

describe('parseBooleanEnv', () => {
  describe('fail-closed defaults', () => {
    it('returns defaultValue=false when env var is undefined (TRADING_ENABLED unset → disabled)', () => {
      expect(parseBooleanEnv(undefined, false)).toBe(false)
    })

    it('returns defaultValue=true when env var is undefined (DRY_RUN unset → dry run active)', () => {
      expect(parseBooleanEnv(undefined, true)).toBe(true)
    })
  })

  describe('explicit values', () => {
    it('returns true for the exact string "true"', () => {
      expect(parseBooleanEnv('true', false)).toBe(true)
    })

    it('returns false for "false"', () => {
      expect(parseBooleanEnv('false', true)).toBe(false)
    })

    it('returns false for "1" (only "true" is accepted)', () => {
      expect(parseBooleanEnv('1', true)).toBe(false)
    })

    it('returns false for an empty string', () => {
      expect(parseBooleanEnv('', true)).toBe(false)
    })

    it('returns false for "TRUE" (case-sensitive)', () => {
      expect(parseBooleanEnv('TRUE', true)).toBe(false)
    })
  })
})

describe('parseCsvEnv', () => {
  it('returns an empty array for undefined', () => {
    expect(parseCsvEnv(undefined)).toEqual([])
  })

  it('parses a comma-separated list and trims whitespace', () => {
    expect(parseCsvEnv('SOXL, SOXS , TQQQ')).toEqual(['SOXL', 'SOXS', 'TQQQ'])
  })

  it('filters out empty entries', () => {
    expect(parseCsvEnv('SOXL,,SOXS')).toEqual(['SOXL', 'SOXS'])
  })
})

describe('parseNumberEnv', () => {
  it('throws when the value is undefined', () => {
    expect(() => parseNumberEnv(undefined, 'MAX_ORDER_NOTIONAL')).toThrow("'MAX_ORDER_NOTIONAL'")
  })

  it('parses a valid numeric string', () => {
    expect(parseNumberEnv('100')).toBe(100)
  })

  it('throws for a non-numeric string', () => {
    expect(() => parseNumberEnv('abc', 'MAX_ORDER_NOTIONAL')).toThrow('invalid number value')
  })
})

describe('parseSymbolNotionalMap', () => {
  it('returns an empty map for undefined', () => {
    expect(parseSymbolNotionalMap(undefined)).toEqual({})
  })

  it('parses JSON object entries and uppercases keys', () => {
    expect(parseSymbolNotionalMap('{"soxl":200,"SOXS":150}')).toEqual({
      SOXL: 200,
      SOXS: 150,
    })
  })

  it('returns an empty map for malformed input', () => {
    expect(parseSymbolNotionalMap('{"SOXL":"bad"}')).toEqual({})
  })
})
