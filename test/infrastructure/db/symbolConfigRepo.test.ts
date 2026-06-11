import { describe, expect, it, vi } from 'vitest'
import {
  deactivateSymbolForBrokerDeny,
  loadInversePairs,
  loadPairRegimeConfigs,
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

  it('accepts only sign/range-valid stop/TP overrides, drops the rest (fail-closed, CodeRabbit #432)', async () => {
    const rows = [
      { symbol: 'OK', market: 'US', active: true, maxNotional: null, stopPctOverride: -0.1, takeProfitPctOverride: 0.06 },
      { symbol: 'Z', market: 'US', active: true, maxNotional: null, stopPctOverride: 0, takeProfitPctOverride: null },
      { symbol: 'P', market: 'US', active: true, maxNotional: null, stopPctOverride: 0.08, takeProfitPctOverride: null },
      { symbol: 'LO', market: 'US', active: true, maxNotional: null, stopPctOverride: -1.5, takeProfitPctOverride: null },
      { symbol: 'TPZ', market: 'US', active: true, maxNotional: null, stopPctOverride: null, takeProfitPctOverride: 0 },
      { symbol: 'TPN', market: 'US', active: true, maxNotional: null, stopPctOverride: null, takeProfitPctOverride: -0.05 },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolStopPctOverride).toEqual({ OK: -0.1 })
    expect(result.symbolTakeProfitPctOverride).toEqual({ OK: 0.06 })
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
  updateBudgetAllocPct,
  type SymbolConfigWriteInput,
} from '../../../src/infrastructure/db/symbolConfigRepo'

describe('updateBudgetAllocPct', () => {
  // findSymbolConfig は select().from().where().limit()。update().set().where() の
  // 呼び出し有無を記録する最小 mock。
  function fakeDb2(current: number | null) {
    let updates = 0
    const sel = () => ({
      from: () => sel(),
      where: () => sel(),
      limit: async () => [{ symbol: 'SOXL', budgetAllocPct: current }],
    })
    const db = {
      select: () => sel(),
      update: () => ({ set: () => ({ where: async () => { updates += 1 } }) }),
    }
    return { db: db as unknown as Parameters<typeof updateBudgetAllocPct>[0], updates: () => updates }
  }

  it('skips UPDATE when value is unchanged (no updatedAt bump, CodeRabbit #405)', async () => {
    const f = fakeDb2(0.4)
    await updateBudgetAllocPct(f.db, 'SOXL', 0.4, 't')
    expect(f.updates()).toBe(0)
  })

  it('issues UPDATE when value changes', async () => {
    const f = fakeDb2(0.4)
    await updateBudgetAllocPct(f.db, 'SOXL', 0.5, 't')
    expect(f.updates()).toBe(1)
  })

  it('null↔null is a no-op', async () => {
    const f = fakeDb2(null)
    await updateBudgetAllocPct(f.db, 'SOXL', null, 't')
    expect(f.updates()).toBe(0)
  })
})

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
  notes: null,
  timeStopDaysOverride: null,
  kAtrOverride: null,
  budgetAllocPct: null,
  lotSize: 1,
  stopPctOverride: null,
  takeProfitPctOverride: null,
  intradayOnly: false,
  role: null,
  pullbackMaxOverride: null,
  pullbackMinOverride: null,
  minReturn50dOverride: null,
  maxAtrRatioOverride: null,
  maxSma50DeviationPctOverride: null,
  requireAboveSma50Override: null,
  alternatives: null,
  entryRequired: false,
  alwaysActive: false,
  cashFallbackSymbol: null,
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

describe('loadSymbolConfig role / entry overrides / alternatives (#452)', () => {
  it('maps valid roles and normalizes unknown DB values to "unknown" (not NULL fallback)', async () => {
    const rows = [
      { symbol: 'sgov', market: 'US', active: true, maxNotional: null, role: 'cash_parking' },
      { symbol: 'qqq', market: 'US', active: true, maxNotional: null, role: 'core_trend' },
      { symbol: 'tqqq', market: 'US', active: true, maxNotional: null, role: 'leveraged_trend' },
      // typo した role は 'unknown' に正規化 (= downstream が entry 抑止)。
      // NULL 扱いに倒すと既定 gate で発注され得るため fail-closed 側に倒す。
      { symbol: 'oops', market: 'US', active: true, maxNotional: null, role: 'cash_praking' },
      { symbol: 'soxl', market: 'US', active: true, maxNotional: null, role: null },
      { symbol: 'blank', market: 'US', active: true, maxNotional: null, role: '  ' },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolRole).toEqual({
      SGOV: 'cash_parking',
      QQQ: 'core_trend',
      TQQQ: 'leveraged_trend',
      OOPS: 'unknown',
    })
  })

  it('validates entry override ranges and drops invalid values (fall-through to defaults)', async () => {
    const rows = [
      {
        symbol: 'qqq',
        market: 'US',
        active: true,
        maxNotional: null,
        pullbackMaxOverride: -0.015,
        pullbackMinOverride: -0.05,
        minReturn50dOverride: 0.03,
        maxAtrRatioOverride: 1.8,
        maxSma50DeviationPctOverride: 0.2,
        requireAboveSma50Override: false,
      },
      {
        symbol: 'bad',
        market: 'US',
        active: true,
        maxNotional: null,
        pullbackMaxOverride: 0.5, // 正値は不正 (押し目は負 fraction)
        pullbackMinOverride: -1.5, // 範囲外
        minReturn50dOverride: Number.NaN,
        maxAtrRatioOverride: 0, // > 0 必須
        maxSma50DeviationPctOverride: -0.2, // > 0 必須
        requireAboveSma50Override: null,
      },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    expect(result.symbolPullbackMaxOverride).toEqual({ QQQ: -0.015 })
    expect(result.symbolPullbackMinOverride).toEqual({ QQQ: -0.05 })
    expect(result.symbolMinReturn50dOverride).toEqual({ QQQ: 0.03 })
    expect(result.symbolMaxAtrRatioOverride).toEqual({ QQQ: 1.8 })
    expect(result.symbolMaxSma50DeviationPctOverride).toEqual({ QQQ: 0.2 })
    expect(result.symbolRequireAboveSma50Override).toEqual({ QQQ: false })
  })

  it('parses alternatives JSON, uppercases, dedupes, drops self-reference and bad JSON', async () => {
    const rows = [
      { symbol: 'soxl', market: 'US', active: true, maxNotional: null, alternatives: '["soxx","SMH","soxx","SOXL"]' },
      { symbol: 'tqqq', market: 'US', active: true, maxNotional: null, alternatives: 'not-json' },
      { symbol: 'qqq', market: 'US', active: true, maxNotional: null, alternatives: '["BAD SYMBOL!"]' },
      { symbol: 'voo', market: 'US', active: true, maxNotional: null, alternatives: '[]' },
      { symbol: 'spy', market: 'US', active: true, maxNotional: null, alternatives: null },
    ]
    const result = await loadSymbolConfig(fakeDb(rows))
    // self (SOXL) と重複は除去。不正 JSON / 不正 ticker / 空配列 / NULL は map 不在。
    expect(result.symbolAlternatives).toEqual({ SOXL: ['SOXX', 'SMH'] })
  })
})

describe('deactivateSymbolForBrokerDeny (#460)', () => {
  // select (findSymbolConfig) と update を備えた最小 fake。update の set 内容を
  // in-memory rows に反映し、呼び出し回数も記録する。
  function fakeRwDb(rows: Array<Record<string, unknown>>) {
    const updates: Array<Record<string, unknown>> = []
    const db = {
      select() {
        return {
          from() {
            return {
              where: () => ({
                limit: async () => rows,
              }),
            }
          },
        }
      },
      update() {
        return {
          set(values: Record<string, unknown>) {
            return {
              where: async () => {
                updates.push(values)
                Object.assign(rows[0]!, values)
              },
            }
          },
        }
      },
    }
    return { db: db as unknown as Parameters<typeof deactivateSymbolForBrokerDeny>[0], updates }
  }

  it('deactivates and appends the reason to existing notes (既存メモ保持)', async () => {
    const { db, updates } = fakeRwDb([
      { symbol: 'USMV', active: true, notes: '手動メモ' },
    ])
    const result = await deactivateSymbolForBrokerDeny(db, 'usmv', 'TICKER_IS_DENY により自動停止', 't1')
    expect(result?.before.active).toBe(true)
    expect(updates[0]).toMatchObject({ active: false, updatedAt: 't1' })
    expect(updates[0]!.notes).toBe('手動メモ / TICKER_IS_DENY により自動停止')
  })

  it('no-ops when the symbol is already inactive (冪等、notes 重複追記なし)', async () => {
    const { db, updates } = fakeRwDb([
      { symbol: 'USMV', active: false, notes: 'x' },
    ])
    const result = await deactivateSymbolForBrokerDeny(db, 'USMV', 'reason', 't1')
    expect(result).toBeNull()
    expect(updates).toHaveLength(0)
  })

  it('no-ops when the symbol does not exist', async () => {
    const { db, updates } = fakeRwDb([])
    expect(await deactivateSymbolForBrokerDeny(db, 'NOPE', 'reason', 't1')).toBeNull()
    expect(updates).toHaveLength(0)
  })
})

describe('loadPairRegimeConfigs (#472)', () => {
  it('regime_enabled=1 の行だけを bull/bear/proxy に正規化して返す', async () => {
    const rows = [
      { symbol: 'soxl', inverse: 'soxs', regimeEnabled: true, regimeProxySymbol: 'soxx', regimeBullSymbol: 'soxl' },
      { symbol: 'TQQQ', inverse: 'SQQQ', regimeEnabled: false, regimeProxySymbol: 'QQQ', regimeBullSymbol: 'TQQQ' },
    ]
    const result = await loadPairRegimeConfigs(fakeDbAll(rows) as never)
    expect(result).toEqual([
      { bullSymbol: 'SOXL', bearSymbol: 'SOXS', proxySymbol: 'SOXX', invalidConfig: null },
    ])
  })

  it('proxy 欠落 / bull がペア員でない misconfig は skip せず invalidConfig 付きで返す (fail-closed)', async () => {
    const rows = [
      { symbol: 'SOXL', inverse: 'SOXS', regimeEnabled: true, regimeProxySymbol: null, regimeBullSymbol: 'SOXL' },
      { symbol: 'TQQQ', inverse: 'SQQQ', regimeEnabled: true, regimeProxySymbol: 'QQQ', regimeBullSymbol: 'SPXL' },
    ]
    const result = await loadPairRegimeConfigs(fakeDbAll(rows) as never)
    expect(result).toHaveLength(2)
    expect(result[0]!.invalidConfig).toContain('regime_proxy_symbol')
    expect(result[1]!.invalidConfig).toContain('regime_bull_symbol')
  })
})

describe('loadPairRegimeConfigs self-pair (#473 review)', () => {
  it('自己参照ペアは invalidConfig (黙って有効扱いしない)', async () => {
    const rows = [
      { symbol: 'SOXL', inverse: 'SOXL', regimeEnabled: true, regimeProxySymbol: 'SOXX', regimeBullSymbol: 'SOXL' },
    ]
    const result = await loadPairRegimeConfigs(fakeDbAll(rows) as never)
    expect(result[0]!.invalidConfig).toContain('distinct symbols')
  })
})
