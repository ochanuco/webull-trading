import { describe, expect, it } from 'vitest'
import { parseInversePairs } from '../../src/config/env'

describe('parseInversePairs', () => {
  it('returns empty for undefined', () => {
    expect(parseInversePairs(undefined)).toEqual({})
  })

  it('expands a one-sided map to both directions', () => {
    expect(parseInversePairs('{"SOXL":"SOXS"}')).toEqual({ SOXL: 'SOXS', SOXS: 'SOXL' })
  })

  it('uppercases both sides', () => {
    expect(parseInversePairs('{"soxl":"soxs"}')).toEqual({ SOXL: 'SOXS', SOXS: 'SOXL' })
  })

  it('returns {} on malformed JSON', () => {
    expect(parseInversePairs('not-json')).toEqual({})
  })

  it('rejects a self-pair', () => {
    expect(parseInversePairs('{"SOXL":"SOXL"}')).toEqual({})
  })

  it('rejects a non-string value', () => {
    expect(parseInversePairs('{"SOXL":1}')).toEqual({})
  })
})
