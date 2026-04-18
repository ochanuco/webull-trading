import { describe, expect, it } from 'vitest'
import { parseSymbolRulesMap } from '../../src/config/env'

describe('parseSymbolRulesMap', () => {
  it('returns empty on undefined', () => {
    expect(parseSymbolRulesMap(undefined)).toEqual({})
  })

  it('parses valid JSON and uppercases keys', () => {
    const out = parseSymbolRulesMap('{"soxl":{"stopPct":-0.03,"timeStopDays":5}}')
    expect(out).toEqual({ SOXL: { stopPct: -0.03, timeStopDays: 5 } })
  })

  it('returns {} on malformed JSON', () => {
    expect(parseSymbolRulesMap('not-json')).toEqual({})
  })

  it('returns {} when a field value is non-numeric', () => {
    expect(parseSymbolRulesMap('{"SOXL":{"stopPct":"tight"}}')).toEqual({})
  })

  it('silently drops unknown keys', () => {
    const out = parseSymbolRulesMap('{"SOXL":{"stopPct":-0.03,"foo":"bar"}}')
    expect(out).toEqual({ SOXL: { stopPct: -0.03 } })
  })
})
