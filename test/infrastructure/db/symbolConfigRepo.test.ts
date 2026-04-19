import { describe, expect, it, vi } from 'vitest'
import {
  loadInversePairs,
  loadSymbolConfig,
} from '../../../src/infrastructure/db/symbolConfigRepo'

function fakeDb(rows: unknown[]) {
  return {
    select() {
      return {
        from() {
          return {
            where: vi.fn().mockResolvedValue(rows),
          }
        },
      }
    },
  } as unknown as Parameters<typeof loadSymbolConfig>[0]
}

function fakeDbAll(rows: unknown[]) {
  return {
    select() {
      return {
        from: vi.fn().mockResolvedValue(rows),
      }
    },
  } as unknown as Parameters<typeof loadInversePairs>[0]
}

describe('loadSymbolConfig', () => {
  it('returns upper-cased allowed symbols and max notional map', async () => {
    const rows = [
      { symbol: 'soxl', market: 'US', active: true, maxNotional: 50000, notes: null, updatedAt: '' },
      { symbol: '7203', market: 'JP', active: true, maxNotional: null, notes: null, updatedAt: '' },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.allowedSymbols).toEqual(['SOXL', '7203'])
    expect(result.symbolMaxNotional).toEqual({ SOXL: 50000 })
  })

  it('drops non-positive or non-finite maxNotional', async () => {
    const rows = [
      { symbol: 'A', market: 'US', active: true, maxNotional: 0, notes: null, updatedAt: '' },
      { symbol: 'B', market: 'US', active: true, maxNotional: -5, notes: null, updatedAt: '' },
      { symbol: 'C', market: 'US', active: true, maxNotional: 100, notes: null, updatedAt: '' },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolMaxNotional).toEqual({ C: 100 })
  })
})

describe('loadInversePairs', () => {
  it('expands a one-sided row into a bidirectional map', async () => {
    const rows = [{ symbol: 'SOXL', inverse: 'SOXS', updatedAt: '' }]
    expect(await loadInversePairs(fakeDbAll(rows))).toEqual({ SOXL: 'SOXS', SOXS: 'SOXL' })
  })

  it('uppercases both sides and drops self-pairs', async () => {
    const rows = [
      { symbol: 'soxl', inverse: 'soxs', updatedAt: '' },
      { symbol: 'XX', inverse: 'XX', updatedAt: '' },
    ]
    expect(await loadInversePairs(fakeDbAll(rows))).toEqual({ SOXL: 'SOXS', SOXS: 'SOXL' })
  })
})
