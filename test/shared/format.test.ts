import { describe, expect, it } from 'vitest'
import { formatSymbolDisplay } from '../../src/shared/format'

describe('formatSymbolDisplay', () => {
  it('returns `${symbol}-${name}` for JP symbols with a non-empty name', () => {
    expect(formatSymbolDisplay({ symbol: '7974', name: '任天堂' })).toBe('7974-任天堂')
    expect(formatSymbolDisplay({ symbol: '6971', name: '京セラ' })).toBe('6971-京セラ')
  })

  it('returns `${symbol}-${name}` for US symbols with a non-empty name', () => {
    expect(formatSymbolDisplay({ symbol: 'AAPL', name: 'Apple Inc.' })).toBe('AAPL-Apple Inc.')
    expect(formatSymbolDisplay({ symbol: 'SOXL', name: 'Direxion Semiconductor Bull 3X' })).toBe(
      'SOXL-Direxion Semiconductor Bull 3X',
    )
  })

  it('trims whitespace around names before concatenation', () => {
    expect(formatSymbolDisplay({ symbol: '7203', name: '  トヨタ自動車  ' })).toBe(
      '7203-トヨタ自動車',
    )
    expect(formatSymbolDisplay({ symbol: 'AAPL', name: '  Apple Inc.  ' })).toBe('AAPL-Apple Inc.')
  })

  it('falls back to symbol when name is null / undefined / empty / whitespace', () => {
    expect(formatSymbolDisplay({ symbol: '7974', name: null })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974', name: '' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: '7974', name: '   ' })).toBe('7974')
    expect(formatSymbolDisplay({ symbol: 'AAPL', name: null })).toBe('AAPL')
    expect(formatSymbolDisplay({ symbol: 'AAPL' })).toBe('AAPL')
  })
})
