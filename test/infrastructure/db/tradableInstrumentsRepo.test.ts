import { describe, expect, it, vi } from 'vitest'
import {
  finalizeTradableDisappearance,
  getTradableAllowlistStatus,
  loadTradableAllowlist,
  lookupTradableStatus,
  refreshTradableInstruments,
  upsertTradablePage,
  type TradableDb,
} from '../../../src/infrastructure/db/tradableInstrumentsRepo'
import type { TradableInstrumentEntry } from '../../../src/infrastructure/webull/tradableInstruments'

function entry(symbol: string): TradableInstrumentEntry {
  return {
    symbol,
    instrumentId: '111',
    name: `${symbol} Fund`,
    currency: 'USD',
    exchangeCode: 'XNAS',
  }
}

/**
 * upsertTradablePage は insert().values().onConflictDoUpdate() を chunk 化して
 * db.batch() で流す。finalize は select().from() + update().set().where()。
 * その chain を満たし、書き込みを記録する fake。
 */
function fakeDb(existing: unknown[]) {
  const upsertChunks: unknown[][] = []
  const disappearWheres: unknown[] = []
  const batched: unknown[][] = []
  const db = {
    select: () => ({ from: vi.fn().mockResolvedValue(existing) }),
    insert: () => ({
      values: (chunk: unknown[]) => ({
        onConflictDoUpdate: (_cfg: unknown) => {
          upsertChunks.push(chunk)
          return { __stmt: true, chunk }
        },
      }),
    }),
    batch: vi.fn(async (stmts: unknown[]) => {
      batched.push(stmts)
      return []
    }),
    update: () => ({
      set: (_s: unknown) => ({
        where: vi.fn(async (w: unknown) => {
          disappearWheres.push(w)
        }),
      }),
    }),
  } as unknown as TradableDb
  return { db, upsertChunks, disappearWheres, batched }
}

describe('loadTradableAllowlist / lookupTradableStatus', () => {
  it('row を map 化し currently_tradable で status を分ける', async () => {
    const rows = [
      { symbol: 'SOXL', instrumentId: '1', name: 'a', currency: 'USD', currentlyTradable: true, firstSeenAt: 't', lastSeenAt: 't', updatedAt: 't' },
      { symbol: 'USMV', instrumentId: '2', name: 'b', currency: 'USD', currentlyTradable: false, firstSeenAt: 't', lastSeenAt: 't', updatedAt: 't' },
    ]
    const db = { select: () => ({ from: vi.fn().mockResolvedValue(rows) }) } as unknown as TradableDb
    const map = await loadTradableAllowlist(db)
    expect(map.get('SOXL')?.status).toBe('tradable')
    expect(map.get('USMV')?.status).toBe('disappeared')
    expect(lookupTradableStatus(map, 'vug')).toBe('unknown')
    expect(lookupTradableStatus(map, 'soxl')).toBe('tradable')
  })
})

describe('upsertTradablePage', () => {
  it('chunk 化して onConflictDoUpdate を batch で流す', async () => {
    const { db, upsertChunks, batched } = fakeDb([])
    // UPSERT_CHUNK=10 を跨ぐ 12 件 → 2 chunk。
    const entries = Array.from({ length: 12 }, (_, i) => entry(`S${i}`))
    const n = await upsertTradablePage(db, entries, 'now')
    expect(n).toBe(12)
    expect(upsertChunks).toHaveLength(2)
    expect(upsertChunks[0]).toHaveLength(10)
    expect(upsertChunks[1]).toHaveLength(2)
    expect(batched.length).toBeGreaterThanOrEqual(1)
  })

  it('空配列は no-op', async () => {
    const { db, batched } = fakeDb([])
    expect(await upsertTradablePage(db, [], 'now')).toBe(0)
    expect(batched).toHaveLength(0)
  })

  it('同一ページ内の重複 symbol は除去する', async () => {
    const { db, upsertChunks } = fakeDb([])
    const n = await upsertTradablePage(db, [entry('SOXL'), entry('SOXL'), entry('VUG')], 'now')
    expect(n).toBe(2)
    expect(upsertChunks[0]).toHaveLength(2)
  })
})

describe('finalizeTradableDisappearance', () => {
  it('seen に無い既存 tradable を消失として返す (物理削除しない)', async () => {
    const { db, disappearWheres } = fakeDb([
      { symbol: 'SOXL', currentlyTradable: true },
      { symbol: 'USMV', currentlyTradable: true },
      { symbol: 'OLD', currentlyTradable: false },
    ])
    const disappeared = await finalizeTradableDisappearance(db, new Set(['SOXL']), 'now')
    // USMV は今回 seen に無い tradable → 消失。OLD は既に false なので対象外。
    expect(disappeared).toEqual(['USMV'])
    expect(disappearWheres).toHaveLength(1)
  })

  it('消失ゼロなら update を発行しない', async () => {
    const { db, disappearWheres } = fakeDb([{ symbol: 'SOXL', currentlyTradable: true }])
    const disappeared = await finalizeTradableDisappearance(db, new Set(['SOXL']), 'now')
    expect(disappeared).toEqual([])
    expect(disappearWheres).toHaveLength(0)
  })
})

describe('refreshTradableInstruments (一括 helper)', () => {
  it('complete=true: upsert + 消失判定', async () => {
    const { db } = fakeDb([
      { symbol: 'SOXL', currentlyTradable: true },
      { symbol: 'USMV', currentlyTradable: true },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL'), entry('TQQQ')], {
      complete: true,
      nowIso: 'now',
    })
    expect(result.upserted).toBe(2)
    expect(result.disappeared).toBe(1)
    expect(result.disappearedSymbols).toEqual(['USMV'])
    expect(result.appliedDisappearance).toBe(true)
  })

  it('complete=false: 消失判定をスキップ', async () => {
    const { db } = fakeDb([
      { symbol: 'SOXL', currentlyTradable: true },
      { symbol: 'USMV', currentlyTradable: true },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL')], {
      complete: false,
      nowIso: 'now',
    })
    expect(result.disappeared).toBe(0)
    expect(result.appliedDisappearance).toBe(false)
  })
})

describe('getTradableAllowlistStatus', () => {
  it('total / tradableCount / lastSync を集計する', async () => {
    const rows = [
      { currentlyTradable: true, lastSeenAt: '2026-06-12T00:00:00Z' },
      { currentlyTradable: true, lastSeenAt: '2026-06-12T22:00:00Z' },
      { currentlyTradable: false, lastSeenAt: '2026-06-10T00:00:00Z' },
    ]
    const db = {
      select: () => ({ from: vi.fn().mockResolvedValue(rows) }),
    } as unknown as TradableDb
    const status = await getTradableAllowlistStatus(db)
    expect(status.total).toBe(3)
    expect(status.tradableCount).toBe(2)
    expect(status.lastSync).toBe('2026-06-12T22:00:00Z')
  })
})
