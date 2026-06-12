import { describe, expect, it, vi } from 'vitest'
import {
  loadTradableAllowlist,
  lookupTradableStatus,
  refreshTradableInstruments,
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
 * select は existing rows を返し、insert/update の呼び出しを記録する fake。
 * refreshTradableInstruments が使う chain だけを実装する。
 */
function fakeDb(existing: unknown[]) {
  const inserts: unknown[] = []
  const updates: { set: unknown; where: unknown }[] = []
  const db = {
    select: () => ({ from: vi.fn().mockResolvedValue(existing) }),
    insert: () => ({
      values: vi.fn(async (v: unknown) => {
        inserts.push(v)
      }),
    }),
    update: () => ({
      set: (s: unknown) => ({
        where: vi.fn(async (w: unknown) => {
          updates.push({ set: s, where: w })
        }),
      }),
    }),
  } as unknown as TradableDb
  return { db, inserts, updates }
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
    // 未登録は unknown。
    expect(lookupTradableStatus(map, 'vug')).toBe('unknown')
    // 大文字小文字を無視して引ける。
    expect(lookupTradableStatus(map, 'soxl')).toBe('tradable')
  })
})

describe('refreshTradableInstruments', () => {
  it('新規は insert、既存は update (tradable=true)', async () => {
    const { db, inserts, updates } = fakeDb([
      { symbol: 'SOXL', instrumentId: '1', name: 'a', currency: 'USD', currentlyTradable: true, firstSeenAt: 'old', lastSeenAt: 'old', updatedAt: 'old' },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL'), entry('TQQQ')], {
      complete: true,
      nowIso: 'now',
    })
    expect(result.upserted).toBe(2)
    // TQQQ は新規 insert。
    expect(inserts).toHaveLength(1)
    expect((inserts[0] as { symbol: string }).symbol).toBe('TQQQ')
    expect((inserts[0] as { firstSeenAt: string }).firstSeenAt).toBe('now')
    // SOXL は update (firstSeenAt は触らない)。
    const soxlUpdate = updates.find((u) => (u.set as { currentlyTradable?: boolean }).currentlyTradable === true)
    expect(soxlUpdate).toBeDefined()
  })

  it('complete=true: 今回消えた既存 tradable を false に倒す (物理削除しない)', async () => {
    const { db, inserts, updates } = fakeDb([
      { symbol: 'SOXL', instrumentId: '1', name: 'a', currency: 'USD', currentlyTradable: true, firstSeenAt: 'o', lastSeenAt: 'o', updatedAt: 'o' },
      { symbol: 'USMV', instrumentId: '2', name: 'b', currency: 'USD', currentlyTradable: true, firstSeenAt: 'o', lastSeenAt: 'o', updatedAt: 'o' },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL')], {
      complete: true,
      nowIso: 'now',
    })
    expect(result.disappeared).toBe(1)
    expect(result.disappearedSymbols).toEqual(['USMV'])
    expect(inserts).toHaveLength(0)
    // 消失 update が currentlyTradable=false で発行された。
    const disappearUpdate = updates.find(
      (u) => (u.set as { currentlyTradable?: boolean }).currentlyTradable === false,
    )
    expect(disappearUpdate).toBeDefined()
  })

  it('complete=false (部分結果): 消失判定をスキップ (誤検知防止)', async () => {
    const { db } = fakeDb([
      { symbol: 'SOXL', instrumentId: '1', name: 'a', currency: 'USD', currentlyTradable: true, firstSeenAt: 'o', lastSeenAt: 'o', updatedAt: 'o' },
      { symbol: 'USMV', instrumentId: '2', name: 'b', currency: 'USD', currentlyTradable: true, firstSeenAt: 'o', lastSeenAt: 'o', updatedAt: 'o' },
    ])
    const result = await refreshTradableInstruments(db, [entry('SOXL')], {
      complete: false,
      nowIso: 'now',
    })
    expect(result.disappeared).toBe(0)
    expect(result.appliedDisappearance).toBe(false)
  })
})
