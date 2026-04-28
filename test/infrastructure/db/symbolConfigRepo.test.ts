import { describe, expect, it, vi } from 'vitest'
import {
  loadInversePairs,
  loadSymbolConfig,
} from '../../../src/infrastructure/db/symbolConfigRepo'

function fakeDb(rows: unknown[]) {
  // loadSymbolConfig は WHERE active=... を外したので、`from` 直後で resolve する
  // (active=0 / 1 両方を読んで repo 側で振り分ける)。
  return {
    select() {
      return {
        from: vi.fn().mockResolvedValue(rows),
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

  it('exposes per-symbol market and name maps for dashboard display', async () => {
    const rows = [
      { symbol: 'aapl', name: 'Apple Inc.', market: 'US', active: true, maxNotional: null },
      { symbol: '7974', name: '任天堂', market: 'JP', active: true, maxNotional: null },
      { symbol: '6971', name: '  京セラ  ', market: 'JP', active: true, maxNotional: null },
      { symbol: 'NONAME', name: null, market: 'US', active: true, maxNotional: null },
      { symbol: 'EMPTY', name: '   ', market: 'JP', active: true, maxNotional: null },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolMarket).toEqual({
      AAPL: 'US',
      '7974': 'JP',
      '6971': 'JP',
      NONAME: 'US',
      EMPTY: 'JP',
    })
    // null / 空白だけの name は map に含めない (defensive、display 層が
    // formatSymbolDisplay で symbol そのままに fallback)。
    expect(result.symbolName).toEqual({
      AAPL: 'Apple Inc.',
      '7974': '任天堂',
      '6971': '京セラ',
    })
  })

  it('falls back unknown market values to US (defensive against bad rows)', async () => {
    const rows = [
      { symbol: 'X', name: null, market: 'HK', active: true, maxNotional: null },
      { symbol: 'Y', name: null, market: '', active: true, maxNotional: null },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolMarket).toEqual({ X: 'US', Y: 'US' })
  })

  // dashboard が disabled (active=0) を grayed-out で表示するために、active=0 の
  // symbol も読み込んで `inactiveSymbols` / `symbolNotes` に振り分ける。
  // cron / risk gate は引き続き `allowedSymbols` のみを参照する (= 評価対象は変えない)。
  it('partitions rows into allowedSymbols / inactiveSymbols by active flag', async () => {
    const rows = [
      { symbol: 'soxl', name: 'SOXL', market: 'US', active: true, maxNotional: 50000, notes: null },
      { symbol: 'soxs', name: 'SOXS', market: 'US', active: false, maxNotional: null, notes: 'pair removed 2026-04-20' },
      { symbol: '7203', name: 'トヨタ', market: 'JP', active: true, maxNotional: null, notes: null },
      { symbol: '9697', name: 'カプコン', market: 'JP', active: false, maxNotional: null, notes: 'liquidity dropped' },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.allowedSymbols).toEqual(['SOXL', '7203'])
    expect(result.inactiveSymbols).toEqual(['SOXS', '9697'])
    // notes は active=0 / 1 両方の銘柄分が含まれる (active=1 で notes 設定済の運用も想定)
    expect(result.symbolNotes).toEqual({
      SOXS: 'pair removed 2026-04-20',
      '9697': 'liquidity dropped',
    })
    // currency / market map は active=0 含めて全銘柄分
    expect(result.symbolMarket).toEqual({ SOXL: 'US', SOXS: 'US', '7203': 'JP', '9697': 'JP' })
  })

  it('skips empty / whitespace-only notes (defensive)', async () => {
    const rows = [
      { symbol: 'A', name: null, market: 'US', active: false, maxNotional: null, notes: '' },
      { symbol: 'B', name: null, market: 'US', active: false, maxNotional: null, notes: '   ' },
      { symbol: 'C', name: null, market: 'US', active: false, maxNotional: null, notes: '  reason  ' },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolNotes).toEqual({ C: 'reason' })
    expect(result.inactiveSymbols).toEqual(['A', 'B', 'C'])
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
