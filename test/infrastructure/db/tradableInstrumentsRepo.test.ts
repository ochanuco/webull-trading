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

interface Row {
  symbol: string
  currentlyTradable: boolean
  firstSeenAt?: string
  lastSeenAt?: string
  [k: string]: unknown
}

/**
 * 動作する in-memory fake。upsert (batch 経由) は store を実際に更新し、
 * select は store を読む。これで watermark の mark-and-sweep を実検証できる。
 * update().set().where() は記録のみ (消失判定の戻り値で検証する)。
 */
function memDb(initial: Row[]) {
  const store = new Map<string, Row>(initial.map((r) => [r.symbol.toUpperCase(), { ...r }]))
  const updateCalls: unknown[] = []
  let batchGroups = 0
  const db = {
    select: (_cols?: unknown) => ({ from: vi.fn(async () => [...store.values()]) }),
    insert: () => ({
      values: (chunk: Row[]) => ({
        onConflictDoUpdate: (_cfg: unknown) => ({
          __apply: () => {
            for (const row of chunk) {
              const k = row.symbol.toUpperCase()
              const prev = store.get(k)
              if (prev) store.set(k, { ...prev, ...row, firstSeenAt: prev.firstSeenAt })
              else store.set(k, { ...row })
            }
          },
        }),
      }),
    }),
    batch: vi.fn(async (stmts: { __apply: () => void }[]) => {
      batchGroups += 1
      for (const s of stmts) s.__apply()
      return []
    }),
    update: () => ({
      set: (s: unknown) => ({
        where: vi.fn(async (w: unknown) => {
          updateCalls.push({ set: s, where: w })
        }),
      }),
    }),
  } as unknown as TradableDb
  return { db, store, updateCalls, batchGroupsRef: () => batchGroups }
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
  it('chunk 化して store に upsert する (firstSeenAt は保持)', async () => {
    const { db, store } = memDb([
      { symbol: 'SOXL', currentlyTradable: true, firstSeenAt: 'old', lastSeenAt: 'old' },
    ])
    const entries = Array.from({ length: 12 }, (_, i) => entry(`S${i}`)).concat(entry('SOXL'))
    const n = await upsertTradablePage(db, entries, 'wm')
    expect(n).toBe(13)
    // 既存 SOXL は firstSeenAt 保持、lastSeenAt は watermark に更新。
    expect(store.get('SOXL')?.firstSeenAt).toBe('old')
    expect(store.get('SOXL')?.lastSeenAt).toBe('wm')
    // 新規は firstSeenAt=watermark。
    expect(store.get('S0')?.firstSeenAt).toBe('wm')
  })

  it('空配列は no-op', async () => {
    const { db, batchGroupsRef } = memDb([])
    expect(await upsertTradablePage(db, [], 'wm')).toBe(0)
    expect(batchGroupsRef()).toBe(0)
  })

  it('同一ページ内の重複 symbol は除去する', async () => {
    const { db, store } = memDb([])
    const n = await upsertTradablePage(db, [entry('SOXL'), entry('SOXL'), entry('VUG')], 'wm')
    expect(n).toBe(2)
    expect(store.size).toBe(2)
  })
})

describe('finalizeTradableDisappearance (watermark mark-and-sweep)', () => {
  it('watermark 未満の lastSeenAt を持つ tradable 行を消失とする', async () => {
    const { db, updateCalls } = memDb([
      { symbol: 'SOXL', currentlyTradable: true, lastSeenAt: 'wm2' }, // 今回 sweep で更新済み
      { symbol: 'USMV', currentlyTradable: true, lastSeenAt: 'wm1' }, // 前回まで。今回未到達
      { symbol: 'OLD', currentlyTradable: false, lastSeenAt: 'wm1' }, // 既に false
    ])
    const disappeared = await finalizeTradableDisappearance(db, 'wm2', 'now')
    expect(disappeared).toEqual(['USMV'])
    expect(updateCalls).toHaveLength(1)
    // set 内容まで検証 (誤った set 値の回帰を拾う)。
    expect((updateCalls[0] as { set: Record<string, unknown> }).set).toMatchObject({
      currentlyTradable: false,
      updatedAt: 'now',
    })
  })

  it('消失ゼロなら update を発行しない', async () => {
    const { db, updateCalls } = memDb([{ symbol: 'SOXL', currentlyTradable: true, lastSeenAt: 'wm2' }])
    expect(await finalizeTradableDisappearance(db, 'wm2', 'now')).toEqual([])
    expect(updateCalls).toHaveLength(0)
  })
})

describe('refreshTradableInstruments (一括 helper)', () => {
  // watermark は単調増加の ISO 文字列で比較される (lex 順)。前回 < 今回 になる値を使う。
  const PREV = '2026-01-01T00:00:00Z'
  const NOW = '2026-06-12T00:00:00Z'

  it('complete=true: seen は維持、未 seen の既存 tradable を消失', async () => {
    const { db } = memDb([
      { symbol: 'SOXL', currentlyTradable: true, firstSeenAt: PREV, lastSeenAt: PREV },
      { symbol: 'USMV', currentlyTradable: true, firstSeenAt: PREV, lastSeenAt: PREV },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL'), entry('TQQQ')], {
      complete: true,
      nowIso: NOW,
    })
    expect(result.upserted).toBe(2)
    // SOXL は今回 seen (lastSeenAt=NOW)、USMV は未 seen (PREV < NOW) → 消失。
    expect(result.disappearedSymbols).toEqual(['USMV'])
    expect(result.appliedDisappearance).toBe(true)
  })

  it('complete=false: 消失判定をスキップ', async () => {
    const { db } = memDb([
      { symbol: 'SOXL', currentlyTradable: true, firstSeenAt: PREV, lastSeenAt: PREV },
      { symbol: 'USMV', currentlyTradable: true, firstSeenAt: PREV, lastSeenAt: PREV },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL')], {
      complete: false,
      nowIso: NOW,
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
    const db = { select: () => ({ from: vi.fn().mockResolvedValue(rows) }) } as unknown as TradableDb
    const status = await getTradableAllowlistStatus(db)
    expect(status.total).toBe(3)
    expect(status.tradableCount).toBe(2)
    expect(status.lastSync).toBe('2026-06-12T22:00:00Z')
  })
})
