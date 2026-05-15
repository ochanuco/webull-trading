import { describe, expect, it } from 'vitest'
import { escapeHtml, formatSymbolDisplay } from '../../src/shared/format'

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

describe('escapeHtml (#284)', () => {
  it('returns empty string for null / undefined', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  it('escapes the 5 baseline metacharacters', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;')
  })

  it('escapes a <script> payload so the tag is inert', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
  })

  it('escapes an attribute-break payload (`" onerror=…`)', () => {
    expect(escapeHtml('" onerror="alert(1)')).toBe('&quot; onerror=&quot;alert(1)')
  })

  it('coerces numbers / booleans to strings without throwing', () => {
    expect(escapeHtml(0)).toBe('0')
    expect(escapeHtml(false)).toBe('false')
    expect(escapeHtml(42)).toBe('42')
  })

  it('escapes ampersand FIRST so existing entities are not double-broken into literals', () => {
    // 入力 `&lt;` は文字列 4 文字。出力では `&` だけが先頭 escape され
    // 残りは literal で保つ (`&amp;lt;`)。これにより `&lt;` の literal 表示
    // と「あとから `<` が湧いて出る」誤解釈を区別できる。
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
})
