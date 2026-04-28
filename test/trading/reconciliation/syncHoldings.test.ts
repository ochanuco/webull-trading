import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internal, syncHoldings } from '../../../src/trading/reconciliation/syncHoldings'
import type { WebullPositionDto } from '../../../src/infrastructure/webull/dto'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import type { SymbolState, PositionState } from '../../../src/trading/state/types'

/**
 * Build a minimal `SymbolState` for a given `position`. Other fields are
 * defaulted so the test only has to specify what it cares about (qty / avg).
 */
function stateWith(symbol: string, position: PositionState | null, updatedAt = '2026-04-25T00:00:00.000Z'): SymbolState {
  return {
    symbol,
    position,
    appliedClientOrderIds: [],
    pendingOrder: null,
    lastSignalAt: null,
    cooldownUntil: null,
    settledCash: 0,
    pendingSettlement: [],
    lastExecutedPrice: null,
    lastQuote: null,
    updatedAt,
  }
}

interface OverrideCall {
  symbol: string
  args: Parameters<PositionStore['overridePosition']>[1]
}

/**
 * In-memory PositionStore stub that records every override call and lets
 * each test seed `getState` results per symbol. Returns the post-override
 * state shaped after the args (mirrors what the real DO would do).
 */
function createFakeStore(initial: Record<string, PositionState | null>): {
  store: Pick<PositionStore, 'getState' | 'overridePosition'>
  overrides: OverrideCall[]
} {
  const overrides: OverrideCall[] = []
  const map = new Map<string, PositionState | null>(Object.entries(initial))
  const store: Pick<PositionStore, 'getState' | 'overridePosition'> = {
    async getState(symbol: string) {
      return stateWith(symbol, map.get(symbol) ?? null)
    },
    async overridePosition(symbol, args) {
      overrides.push({ symbol, args })
      const next = args.qty > 0
        ? {
            qty: args.qty,
            avgPrice: args.avgPrice,
            openedAt: args.openedAt ?? '2026-04-25T00:00:00.000Z',
          }
        : null
      map.set(symbol, next)
      return stateWith(symbol, next)
    },
  }
  return { store, overrides }
}

describe('syncHoldings internals', () => {
  it('pickAvgPrice prefers broker avg over DO avg', () => {
    expect(_internal.pickAvgPrice(124.95, 100)).toBe(124.95)
  })

  it('pickAvgPrice falls back to DO avg when broker avg is missing/zero/non-finite', () => {
    expect(_internal.pickAvgPrice(null, 100)).toBe(100)
    expect(_internal.pickAvgPrice(0, 100)).toBe(100)
    expect(_internal.pickAvgPrice(Number.NaN, 100)).toBe(100)
  })

  it('pickAvgPrice returns null when neither source is usable', () => {
    expect(_internal.pickAvgPrice(null, null)).toBeNull()
    expect(_internal.pickAvgPrice(0, 0)).toBeNull()
  })

  it('parseBrokerQty handles the Webull DTO conventions', () => {
    expect(_internal.parseBrokerQty(undefined)).toBeNull()
    expect(_internal.parseBrokerQty({ available_quantity: '' })).toBeNull()
    expect(_internal.parseBrokerQty({ available_quantity: '4' })).toBe(4)
    expect(_internal.parseBrokerQty({ available_quantity: '0' })).toBe(0)
    expect(_internal.parseBrokerQty({ available_quantity: 'banana' })).toBeNull()
  })

  it('computePlannedAfter returns null when broker qty is zero', () => {
    expect(
      _internal.computePlannedAfter({ brokerQty: 0, brokerAvg: 100, before: null }),
    ).toBeNull()
  })

  it('computePlannedAfter prefers broker avg when available', () => {
    expect(
      _internal.computePlannedAfter({
        brokerQty: 4,
        brokerAvg: 124.95,
        before: { qty: 8, avgPrice: 100, openedAt: '2026-04-20T00:00:00.000Z' },
      }),
    ).toEqual({
      qty: 4,
      avgPrice: 124.95,
      openedAt: '2026-04-20T00:00:00.000Z',
    })
  })
})

describe('syncHoldings', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  function brokerPosition(
    symbol: string,
    available: string,
    avgCost?: string,
  ): WebullPositionDto {
    return {
      symbol,
      available_quantity: available,
      ...(avgCost !== undefined ? { avg_cost: avgCost } : {}),
    }
  }

  it('all-symbols mode: mixes drift / no-drift / not-held / errors', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      AAPL: null,
      MSFT: { qty: 5, avgPrice: 410, openedAt: '2026-04-21T00:00:00.000Z' },
      NVDA: { qty: 2, avgPrice: 900, openedAt: '2026-04-22T00:00:00.000Z' },
    })
    // Wrap NVDA's getState to throw — exercises the per-symbol error path.
    const realGetState = store.getState
    store.getState = async (symbol: string) => {
      if (symbol === 'NVDA') throw new Error('DO unreachable')
      return realGetState.call(store, symbol)
    }
    const result = await syncHoldings(
      { dryRun: false, requestId: 'req-1' },
      {
        allowedSymbols: ['SOXL', 'AAPL', 'MSFT', 'NVDA'],
        fetchPositions: async () => [
          brokerPosition('SOXL', '4', '125.50'),
          brokerPosition('MSFT', '5', '410'),
          // AAPL omitted = not held on broker; DO already null → no_drift
          // NVDA throws via getState wrapper above
        ],
        positionStore: store,
      },
    )

    // SOXL: drift 8 → 4 — write happens, broker avg used
    const soxl = result.synced.find((r) => r.symbol === 'SOXL')!
    expect(soxl.before).toEqual({ qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' })
    expect(soxl.after).toEqual({ qty: 4, avgPrice: 125.5, openedAt: '2026-04-20T00:00:00.000Z' })
    expect(soxl.broker_qty).toBe(4)
    expect(soxl.broker_avg).toBe(125.5)
    expect(soxl.skipped).toBeUndefined()

    // AAPL: not held, DO null → no_drift
    const aapl = result.synced.find((r) => r.symbol === 'AAPL')!
    expect(aapl.skipped).toBe('no_drift')
    expect(aapl.broker_qty).toBeNull()

    // MSFT: equal qty → no_drift
    const msft = result.synced.find((r) => r.symbol === 'MSFT')!
    expect(msft.skipped).toBe('no_drift')

    // NVDA: error
    expect(result.errors).toEqual([{ symbol: 'NVDA', error: 'DO unreachable' }])

    // Summary
    expect(result.summary).toEqual({ total: 4, synced: 1, no_drift: 2, errors: 1 })
    expect(result.dryRun).toBe(false)

    // Only SOXL was written; AAPL/MSFT untouched.
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.symbol).toBe('SOXL')
    expect(overrides[0]!.args.qty).toBe(4)
    expect(overrides[0]!.args.avgPrice).toBe(125.5)
    expect(overrides[0]!.args.requestId).toBe('req-1')
    expect(overrides[0]!.args.reason).toContain('8')
    expect(overrides[0]!.args.reason).toContain('4')

    // Audit log emitted once for the actual sync (NVDA error path doesn't log).
    const syncLogs = logSpy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? safeParse(c[0]) : null))
      .filter((p): p is { event: string } => p !== null && p.event === 'holdings_sync_applied')
    expect(syncLogs).toHaveLength(1)
  })

  it('single-symbol mode: only the requested ticker is synced', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      AAPL: { qty: 10, avgPrice: 200, openedAt: '2026-04-21T00:00:00.000Z' },
    })
    const result = await syncHoldings(
      { symbol: 'SOXL', dryRun: false, requestId: 'req-2' },
      {
        // allowedSymbols irrelevant when symbol is set; pass [] to prove it.
        allowedSymbols: [],
        fetchPositions: async () => [
          brokerPosition('SOXL', '4', '125.50'),
          brokerPosition('AAPL', '10', '200'),
        ],
        positionStore: store,
      },
    )
    expect(result.synced.map((r) => r.symbol)).toEqual(['SOXL'])
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.symbol).toBe('SOXL')
  })

  it('dryRun=true: drift detected but no overrides written', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
    })
    const result = await syncHoldings(
      { dryRun: true, requestId: 'req-3' },
      {
        allowedSymbols: ['SOXL'],
        fetchPositions: async () => [brokerPosition('SOXL', '4', '125.50')],
        positionStore: store,
      },
    )
    const soxl = result.synced[0]!
    expect(soxl.skipped).toBe('dry_run')
    expect(soxl.before?.qty).toBe(8)
    expect(soxl.after?.qty).toBe(4)
    expect(soxl.after?.avgPrice).toBe(125.5)
    expect(overrides).toEqual([])
    expect(result.dryRun).toBe(true)
  })

  it('broker not held (qty=0) → DO position is closed (null) [force=true required]', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 4, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
    })
    // PR #222 follow-up: this destructive zero-out now requires force=true.
    // The bare-call equivalent is covered by the safe-fail guard tests above.
    const result = await syncHoldings(
      { dryRun: false, force: true, requestId: 'req-4' },
      {
        allowedSymbols: ['SOXL'],
        // Webull omits zero-qty rows entirely.
        fetchPositions: async () => [],
        positionStore: store,
      },
    )
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.args.qty).toBe(0)
    expect(result.synced[0]!.after).toBeNull()
    expect(result.synced[0]!.broker_qty).toBeNull()
  })

  it('broker has shares but DO is empty → DO position is created from broker truth', async () => {
    const { store, overrides } = createFakeStore({ SOXL: null })
    const result = await syncHoldings(
      { dryRun: false, requestId: 'req-5' },
      {
        allowedSymbols: ['SOXL'],
        fetchPositions: async () => [brokerPosition('SOXL', '3', '120')],
        positionStore: store,
      },
    )
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.args).toMatchObject({
      qty: 3,
      avgPrice: 120,
      openedAt: null,
    })
    expect(result.synced[0]!.after).toMatchObject({ qty: 3, avgPrice: 120 })
  })

  it('DO has shares but broker reports none → DO position is closed [force=true required]', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 4, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
    })
    // Broker explicitly reports qty=0 (vs. omitting the row). Either way the
    // safe-fail guard sees "no usable broker qty + DO has positions" and
    // requires force=true to proceed with the destructive zero-out.
    const result = await syncHoldings(
      { dryRun: false, force: true, requestId: 'req-6' },
      {
        allowedSymbols: ['SOXL'],
        fetchPositions: async () => [brokerPosition('SOXL', '0', '0')],
        positionStore: store,
      },
    )
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.args.qty).toBe(0)
    expect(result.synced[0]!.after).toBeNull()
  })

  it('broker fetch failure → every symbol surfaces the same error, no overrides', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 4, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
    })
    const result = await syncHoldings(
      { dryRun: false, requestId: 'req-7' },
      {
        allowedSymbols: ['SOXL', 'AAPL'],
        fetchPositions: async () => {
          throw new Error('broker auth failed')
        },
        positionStore: store,
      },
    )
    expect(result.synced).toEqual([])
    expect(result.errors).toEqual([
      { symbol: 'SOXL', error: 'broker positions fetch failed: broker auth failed' },
      { symbol: 'AAPL', error: 'broker positions fetch failed: broker auth failed' },
    ])
    expect(overrides).toEqual([])
  })

  it('falls back to DO avgPrice when broker avg_cost is missing', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
    })
    const result = await syncHoldings(
      { dryRun: false, requestId: 'req-8' },
      {
        allowedSymbols: ['SOXL'],
        // No avg_cost on the broker row — fallback to DO 124.95.
        fetchPositions: async () => [brokerPosition('SOXL', '4')],
        positionStore: store,
      },
    )
    expect(overrides[0]!.args.avgPrice).toBe(124.95)
    expect(result.synced[0]!.after?.avgPrice).toBe(124.95)
  })

  it('errors when broker has shares but no avg available from any source', async () => {
    // DO row missing AND broker avg_cost missing → cannot synthesize avg
    const { store, overrides } = createFakeStore({ SOXL: null })
    const result = await syncHoldings(
      { dryRun: false, requestId: 'req-9' },
      {
        allowedSymbols: ['SOXL'],
        fetchPositions: async () => [brokerPosition('SOXL', '3')],
        positionStore: store,
      },
    )
    expect(overrides).toEqual([])
    expect(result.synced).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.symbol).toBe('SOXL')
    expect(result.errors[0]!.error).toMatch(/cannot determine avgPrice/)
  })

  /**
   * Safe-fail guard: PR #222 follow-up. The bug being defended against was
   * a broker getPositions response that returned all 14 universe symbols
   * with `available_quantity: null` (UAT auth glitch), which sync-holdings
   * happily interpreted as "broker has nothing → zero out the DO". That
   * destroyed real DO rows (SOXL qty=8, AAPL qty=1). The guard refuses the
   * write when broker has zero usable rows AND DO has any qty>0 row;
   * `force=true` is the operator escape hatch for genuine liquidations.
   */
  describe('safe-fail guard (broker empty + DO non-empty)', () => {
    it('aborts with safe-fail error when broker returns no qty and DO has positions (force=false, dryRun=false)', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
        AAPL: { qty: 1, avgPrice: 200, openedAt: '2026-04-21T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { dryRun: false, requestId: 'req-safe-1' },
        {
          allowedSymbols: ['SOXL', 'AAPL'],
          // Broker returns nothing — the bug pattern.
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      expect(overrides).toEqual([])
      expect(result.synced).toEqual([])
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.symbol).toBe('*')
      expect(result.errors[0]!.error).toMatch(/broker_returned_empty_but_do_has_positions/)
      expect(result.errors[0]!.error).toMatch(/force=true/)
      expect(result.summary).toEqual({ total: 1, synced: 0, no_drift: 0, errors: 1 })
      expect(result.dryRun).toBe(false)
      expect(result.warnings).toBeUndefined()
    })

    it('also triggers when broker returns rows but every available_quantity is null', async () => {
      // Mirrors the actual incident: 14 symbols returned but `available_quantity: null`
      // on every row. The guard treats that the same as "no rows".
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { dryRun: false, requestId: 'req-safe-1b' },
        {
          allowedSymbols: ['SOXL'],
          fetchPositions: async () => [
            // null/empty available_quantity → parseBrokerQty returns null
            { symbol: 'SOXL', available_quantity: null as unknown as string },
          ],
          positionStore: store,
        },
      )
      expect(overrides).toEqual([])
      expect(result.errors[0]!.error).toMatch(/broker_returned_empty_but_do_has_positions/)
    })

    it('force=true bypasses the guard and applies the destructive zero-out', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
        AAPL: { qty: 1, avgPrice: 200, openedAt: '2026-04-21T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { dryRun: false, force: true, requestId: 'req-safe-2' },
        {
          allowedSymbols: ['SOXL', 'AAPL'],
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      // Both DO rows zeroed out (intentional liquidation cleanup).
      expect(overrides).toHaveLength(2)
      expect(overrides.map((o) => o.symbol).sort()).toEqual(['AAPL', 'SOXL'])
      for (const o of overrides) {
        expect(o.args.qty).toBe(0)
      }
      expect(result.synced).toHaveLength(2)
      for (const r of result.synced) {
        expect(r.after).toBeNull()
      }
      expect(result.errors).toEqual([])
    })

    it('broker empty + DO empty → no-op (no positions anywhere, nothing destructive)', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: null,
        AAPL: null,
      })
      const result = await syncHoldings(
        { dryRun: false, requestId: 'req-safe-3' },
        {
          allowedSymbols: ['SOXL', 'AAPL'],
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      // Guard does NOT trigger — no DO position to protect.
      expect(overrides).toEqual([])
      expect(result.errors).toEqual([])
      expect(result.synced.every((r) => r.skipped === 'no_drift')).toBe(true)
      expect(result.summary).toEqual({ total: 2, synced: 0, no_drift: 2, errors: 0 })
    })

    it('mixed broker (some null, some qty>0) does NOT trigger guard — partial API works', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
        AAPL: { qty: 1, avgPrice: 200, openedAt: '2026-04-21T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { dryRun: false, requestId: 'req-safe-4' },
        {
          allowedSymbols: ['SOXL', 'AAPL'],
          // SOXL has qty (broker partly works), AAPL omitted (zero-out is real).
          fetchPositions: async () => [brokerPosition('SOXL', '4', '125.50')],
          positionStore: store,
        },
      )
      // Guard does NOT trigger because broker reported at least one qty>0.
      // SOXL drifts 8 → 4 (write), AAPL DO 1 → 0 (write).
      expect(overrides).toHaveLength(2)
      const byName = new Map(overrides.map((o) => [o.symbol, o]))
      expect(byName.get('SOXL')!.args.qty).toBe(4)
      expect(byName.get('AAPL')!.args.qty).toBe(0)
      expect(result.errors).toEqual([])
    })

    it('dryRun=true + safe-fail-would-trigger: shows diff and surfaces warning', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { dryRun: true, requestId: 'req-safe-5' },
        {
          allowedSymbols: ['SOXL'],
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      // dryRun is non-destructive, so we still emit the diff for inspection.
      expect(overrides).toEqual([])
      expect(result.synced).toHaveLength(1)
      expect(result.synced[0]!.skipped).toBe('dry_run')
      expect(result.synced[0]!.before?.qty).toBe(8)
      expect(result.synced[0]!.after).toBeNull()
      // Warning communicates "the live call would refuse this".
      expect(result.warnings).toEqual(['broker_returned_empty_diff_suspicious'])
      expect(result.errors).toEqual([])
      expect(result.dryRun).toBe(true)
    })

    it('single-symbol mode: same guard applies (broker null + DO has qty)', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { symbol: 'SOXL', dryRun: false, requestId: 'req-safe-6' },
        {
          allowedSymbols: [],
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      expect(overrides).toEqual([])
      expect(result.errors[0]!.error).toMatch(/broker_returned_empty_but_do_has_positions/)
    })

    it('single-symbol mode + force=true: bypasses guard for one ticker', async () => {
      const { store, overrides } = createFakeStore({
        SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { symbol: 'SOXL', dryRun: false, force: true, requestId: 'req-safe-7' },
        {
          allowedSymbols: [],
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      expect(overrides).toHaveLength(1)
      expect(overrides[0]!.args.qty).toBe(0)
      expect(result.synced[0]!.after).toBeNull()
    })

    it('stale {qty:0} DO row does NOT count as "DO has positions" (guard not triggered)', async () => {
      const { store, overrides } = createFakeStore({
        // Edge case: DO has a position record but qty=0 (already closed).
        // Zeroing it again is a no-op, not destructive — guard should let it through.
        SOXL: { qty: 0, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
      })
      const result = await syncHoldings(
        { dryRun: false, requestId: 'req-safe-8' },
        {
          allowedSymbols: ['SOXL'],
          fetchPositions: async () => [],
          positionStore: store,
        },
      )
      // No safe-fail error; symbol is just no-drift (DO=0, broker=0).
      expect(overrides).toEqual([])
      expect(result.errors).toEqual([])
      expect(result.synced[0]!.skipped).toBe('no_drift')
    })
  })

  it('matches symbols case-insensitively against broker payload', async () => {
    const { store, overrides } = createFakeStore({
      SOXL: { qty: 8, avgPrice: 124.95, openedAt: '2026-04-20T00:00:00.000Z' },
    })
    await syncHoldings(
      { dryRun: false, requestId: 'req-10' },
      {
        allowedSymbols: ['SOXL'],
        // Lowercase broker symbol — should still match SOXL.
        fetchPositions: async () => [brokerPosition('soxl', '4', '125')],
        positionStore: store,
      },
    )
    expect(overrides).toHaveLength(1)
    expect(overrides[0]!.symbol).toBe('SOXL')
    expect(overrides[0]!.args.qty).toBe(4)
  })
})

function safeParse(s: string): { event: string } | null {
  try {
    return JSON.parse(s) as { event: string }
  } catch {
    return null
  }
}
