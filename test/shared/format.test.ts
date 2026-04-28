import { describe, expect, it } from 'vitest'
import { formatSymbolDisplay } from '../../src/shared/format'

describe('formatSymbolDisplay', () => {
  it('returns `${symbol}-${name}` for JP symbols with a non-empty name', () => {
    expect(formatSymbolDisplay({ symbol: '7974', name: '任天堂', market: 'JP' })).toBe(
      '7974-任天堂',
    )
    expect(formatSymbolDisplay({ symbol: '6971', name: '京セラ', market: 'JP' })).toBe(
      '6971-京セラ',
    )
  })

  it('trims whitespace around JP names before concatenation', () => {
    expect(formatSymbolDisplay({ symbol: '7203', name: '  トヨタ自動車  ', market: 'JP' })).toBe(
      '7203-トヨタ自動車',
    )
  })

  it('falls back to symbol when JP name is null / undefined / empty / whitespace', () => {
    expect(formatSymbolDisplay({ symbol: '7974', name: null, market: 'JP' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974', market: 'JP' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974', name: '', market: 'JP' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974', name: '   ', market: 'JP' })).toBe('7974')
  })

  it('returns symbol unchanged for US symbols even when name is set', () => {
    expect(formatSymbolDisplay({ symbol: 'AAPL', name: 'Apple Inc.', market: 'US' })).toBe('AAPL')
    expect(formatSymbolDisplay({ symbol: 'SOXL', name: 'Direxion Semiconductor Bull 3X', market: 'US' })).toBe(
      'SOXL',
    )
  })

  it('returns symbol unchanged when market is unknown / null / undefined', () => {
    expect(formatSymbolDisplay({ symbol: '7974', name: '任天堂', market: null })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974', name: '任天堂' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: 'XYZ', name: 'Unknown Market', market: 'HK' })).toBe(
      'XYZ',
    )
  })
})
