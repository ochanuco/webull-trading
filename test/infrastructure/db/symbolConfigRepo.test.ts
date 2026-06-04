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

import {
  setInversePair,
  deleteInversePairsForSymbol,
  createSymbolPair,
  type SymbolConfigWriteInput,
} from '../../../src/infrastructure/db/symbolConfigRepo'

// setInversePair / deleteInversePairsForSymbol / createSymbolPair 用の最小 mock。
// insert().values() / delete().where() は即実行で Promise を返し、batch は待つだけ。
// select は findSymbolConfig 用に「存在する symbol」集合でフィルタ返却する。
function fakeWriteDb(existingSymbols: string[] = []) {
  const present = new Set(existingSymbols.map((s) => s.toUpperCase()))
  const ops: string[] = []
  const extract = (cond: unknown): string | null => {
    const seen = new WeakSet<object>()
    const visit = (n: unknown): string | null => {
      if (n === null || typeof n !== 'object') return null
      if (seen.has(n)) return null
      seen.add(n)
      const o = n as Record<string, unknown>
      if ('value' in o && typeof o.value === 'string' && ('encoder' in o || 'brand' in o)) return o.value
      for (const k of Object.keys(o)) {
        const c = visit(o[k])
        if (c !== null) return c
      }
      return null
    }
    return visit(cond)
  }
  const selectChain = (sym: string | null) => ({
    from: () => selectChain(sym),
    where: (cond: unknown) => selectChain(extract(cond)),
    limit: (_n: number) =>
      Promise.resolve(sym !== null && present.has(sym.toUpperCase()) ? [{ symbol: sym }] : []),
    then: (r: (v: unknown[]) => unknown) => Promise.resolve([]).then(r),
  })
  const db = {
    select: () => selectChain(null),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        const sym = String(v.symbol ?? '')
        if (v.inverse !== undefined) ops.push(`insert:pair:${sym}->${v.inverse}`)
        else {
          if (present.has(sym.toUpperCase())) throw new Error('UNIQUE constraint failed: symbol_config.symbol')
          present.add(sym.toUpperCase())
          ops.push(`insert:symbol:${sym}`)
        }
      },
    }),
    delete: () => ({ where: async () => void ops.push('delete:pairs') }),
    batch: (stmts: Promise<unknown>[]) => Promise.all(stmts),
  }
  return { db: db as unknown as Parameters<typeof setInversePair>[0], ops }
}

const writeInput = (symbol: string): SymbolConfigWriteInput => ({
  symbol,
  name: null,
  market: 'US',
  currency: 'USD',
  active: true,
  maxNotional: 500,
  bucket: 'tech_3x',
  notes: null,
  timeStopDaysOverride: null,
  kAtrOverride: null,
})

describe('setInversePair', () => {
  it('throws on self-pair', async () => {
    const { db } = fakeWriteDb()
    await expect(setInversePair(db, 'SOXL', 'SOXL', 't')).rejects.toThrow(/self-referential/)
  })
  it('throws on empty symbol', async () => {
    const { db } = fakeWriteDb()
    await expect(setInversePair(db, 'SOXL', '', 't')).rejects.toThrow()
  })
  it('deletes touching links then inserts one canonical row', async () => {
    const { db, ops } = fakeWriteDb()
    await setInversePair(db, 'soxl', 'soxs', 't')
    expect(ops).toEqual(['delete:pairs', 'insert:pair:SOXL->SOXS'])
  })
})

describe('deleteInversePairsForSymbol', () => {
  it('issues a delete for the symbol links', async () => {
    const { db, ops } = fakeWriteDb()
    await deleteInversePairsForSymbol(db, 'SOXL')
    expect(ops).toEqual(['delete:pairs'])
  })
})

describe('createSymbolPair', () => {
  it('returns duplicate when primary already exists (no counterpart/link)', async () => {
    const { db, ops } = fakeWriteDb(['SOXL'])
    const res = await createSymbolPair(db, writeInput('SOXL'), 'SOXS', 't')
    expect(res).toEqual({ primary: 'duplicate', counterpartCreated: false })
    expect(ops.some((o) => o.startsWith('insert:pair'))).toBe(false)
  })
  it('creates counterpart when missing (counterpartCreated true)', async () => {
    const { db, ops } = fakeWriteDb()
    const res = await createSymbolPair(db, writeInput('SOXL'), 'SOXS', 't')
    expect(res).toEqual({ primary: 'created', counterpartCreated: true })
    expect(ops).toContain('insert:symbol:SOXL')
    expect(ops).toContain('insert:symbol:SOXS')
    expect(ops.some((o) => o === 'insert:pair:SOXL->SOXS')).toBe(true)
  })
  it('does not recreate an existing counterpart (counterpartCreated false)', async () => {
    const { db, ops } = fakeWriteDb(['SOXS'])
    const res = await createSymbolPair(db, writeInput('SOXL'), 'SOXS', 't')
    expect(res).toEqual({ primary: 'created', counterpartCreated: false })
    // counterpart SOXS は既存なので再作成しない
    expect(ops).not.toContain('insert:symbol:SOXS')
    expect(ops.some((o) => o === 'insert:pair:SOXL->SOXS')).toBe(true)
  })
  it('throws on self-pair', async () => {
    const { db } = fakeWriteDb()
    await expect(createSymbolPair(db, writeInput('SOXL'), 'SOXL', 't')).rejects.toThrow(/self-referential/)
  })
})
