import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internal, reconcileFills } from '../../../src/trading/reconciliation/reconcileFills'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'
import { createWebullHttpClient } from '../../../src/infrastructure/webull/WebullHttpClient'

vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))
vi.mock('../../../src/infrastructure/webull/WebullHttpClient', () => ({
  createWebullHttpClient: vi.fn(),
}))

describe('reconcileFills internals', () => {
  it('TERMINAL_STATUSES covers the expected Webull statuses', () => {
    expect([...(_internal.TERMINAL_STATUSES as Set<string>)].sort()).toEqual(
      ['CANCELED', 'CANCELLED', 'EXPIRED', 'FILLED', 'REJECTED'],
    )
  })

  it('pickFilledPrice averages item fill prices when present', () => {
    const price = _internal.pickFilledPrice({
      items: [
        { filled_price: '30.10' } as never,
        { filled_price: '30.20' } as never,
      ],
      limit_price: '99',
    })
    expect(price).toBeCloseTo(30.15)
  })

  it('pickFilledPrice falls back to limit_price when no item fill prices', () => {
    const price = _internal.pickFilledPrice({ limit_price: '12.50' })
    expect(price).toBe(12.5)
  })

  it('pickFilledPrice returns null when neither items nor limit_price is usable', () => {
    expect(_internal.pickFilledPrice({})).toBeNull()
    expect(_internal.pickFilledPrice({ limit_price: 'n/a' })).toBeNull()
  })

  it('pickFilledPrice ignores zero-priced items', () => {
    const price = _internal.pickFilledPrice({
      items: [
        { filled_price: '0' } as never,
        { filled_price: '25.00' } as never,
      ],
      limit_price: '99',
    })
    expect(price).toBeCloseTo(25)
  })

  // The guard that sits between pickFilledPrice and the DB write.
  it('resolveFilledPrice returns null when filledQty is zero / null / negative', () => {
    const detail = { limit_price: '30' }
    expect(_internal.resolveFilledPrice(0, detail)).toBeNull()
    expect(_internal.resolveFilledPrice(null, detail)).toBeNull()
    expect(_internal.resolveFilledPrice(-1, detail)).toBeNull()
  })

  it('resolveFilledPrice returns the candidate price when filledQty > 0 and price is finite + positive', () => {
    const detail = { limit_price: '30' }
    expect(_internal.resolveFilledPrice(1, detail)).toBe(30)
  })

  it('resolveFilledPrice returns null when the candidate price is non-positive / non-finite', () => {
    expect(_internal.resolveFilledPrice(1, { limit_price: '0' })).toBeNull()
    expect(_internal.resolveFilledPrice(1, { limit_price: '-5' })).toBeNull()
    expect(_internal.resolveFilledPrice(1, { limit_price: 'NaN' })).toBeNull()
    expect(_internal.resolveFilledPrice(1, {})).toBeNull()
  })

  // ratio sanity guardrail (issue: 6971 ping-pong from filled_price=10 stub)
  describe('resolveFilledPrice ratio sanity', () => {
    beforeEach(() => {
      // Quiet the JSON warn log so test output stays readable.
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('rejects a JP-style stub fill (filled=10 vs limit=2683)', () => {
      const detail = {
        items: [{ filled_price: '10' }],
        limit_price: '2683',
      }
      expect(_internal.resolveFilledPrice(1, detail)).toBeNull()
    })

    it('accepts a US fill with realistic limit/fill spread (215 vs 215.42)', () => {
      const detail = {
        items: [{ filled_price: '215' }],
        limit_price: '215.42',
      }
      expect(_internal.resolveFilledPrice(1, detail)).toBe(215)
    })

    it('accepts a 1.07x slippage fill (120.43 vs 112.77) inside the 0.5–2x band', () => {
      const detail = {
        items: [{ filled_price: '120.43' }],
        limit_price: '112.77',
      }
      expect(_internal.resolveFilledPrice(1, detail)).toBeCloseTo(120.43)
    })

    it('accepts a JP fill close to the signed limit (2680 vs 2683)', () => {
      const detail = {
        items: [{ filled_price: '2680' }],
        limit_price: '2683',
      }
      expect(_internal.resolveFilledPrice(1, detail)).toBe(2680)
    })

    it('skips the ratio check when limit_price is missing (candidate kept as-is)', () => {
      const detail = {
        items: [{ filled_price: '10' }],
      }
      expect(_internal.resolveFilledPrice(1, detail)).toBe(10)
    })

    it('rejects a 3x overshoot (candidate above the 2x ceiling)', () => {
      const detail = {
        items: [{ filled_price: '300' }],
        limit_price: '100',
      }
      expect(_internal.resolveFilledPrice(1, detail)).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// state-apply marker behaviour (issue #142)
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: number
  clientOrderId: string | null
  symbol: string | null
  side: string | null
  preSubmitSide?: string | null
  brokerStatus: string | null
  filledQty: number | null
  filledPrice: number | null
  realizedPnl: number | null
  stateAppliedAt: string | null
  stateApplyAttempts: number
}

interface UpdateCall {
  rowId: number
  set: Record<string, unknown>
}

/**
 * Build a fake drizzle DB that:
 *   - returns the supplied rows from the SELECT chain,
 *   - records every UPDATE into `updates` so tests can assert on which
 *     columns moved (especially `stateAppliedAt` / `stateApplyError` /
 *     `stateApplyAttempts`).
 *
 * The fake matches the call sequence reconcileFills uses
 * (.update(table).set(values).where(rowEq)) — it doesn't actually parse
 * the `where` predicate but we capture the row id from the most recent
 * `.set` call that was followed by `.where`.
 */
function makeFakeDb(rows: CandidateRow[], options: { failStateAppliedAtOnce?: boolean } = {}): {
  db: ReturnType<typeof createDb>
  updates: UpdateCall[]
} {
  const updates: UpdateCall[] = []
  let failStateAppliedAtOnce = options.failStateAppliedAtOnce ?? false

  const selectChain = {
    from: () => selectChain,
    leftJoin: () => selectChain,
    where: () => selectChain,
    groupBy: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => rows,
    // Drizzle's chain is also thenable; not exercised here but kept for
    // safety against future refactors.
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
  }

  let pendingSet: Record<string, unknown> | null = null

  const db = {
    select: () => selectChain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        pendingSet = values
        return {
          where: (predicate: { queryChunks?: unknown[] }) => {
            // Pull the row id out of the eq() predicate. drizzle-orm's
            // `eq(col, value)` creates an SQL chunk where the bound value
            // is in `queryChunks`. We don't care about the schema; just
            // grep the chunks for a finite number — there's only one row
            // id in any UPDATE we issue.
            const rowId = extractRowId(predicate)
            updates.push({ rowId, set: pendingSet ?? {} })
            const shouldFail = failStateAppliedAtOnce && pendingSet?.stateAppliedAt !== undefined
            pendingSet = null
            if (shouldFail) {
              failStateAppliedAtOnce = false
              return Promise.reject(new Error('marker update unavailable'))
            }
            return Promise.resolve()
          },
        }
      },
    }),
  }
  return { db: db as unknown as ReturnType<typeof createDb>, updates }
}

function extractRowId(predicate: unknown): number {
  // Walk arbitrarily nested objects/arrays/symbols looking for the first
  // finite number — that's the bound value passed to `eq(tradeJournal.id, n)`.
  const seen = new Set<unknown>()
  function walk(node: unknown): number | null {
    if (typeof node === 'number' && Number.isFinite(node)) return node
    if (node === null || typeof node !== 'object') return null
    if (seen.has(node)) return null
    seen.add(node)
    for (const value of Object.values(node)) {
      const found = walk(value)
      if (found !== null) return found
    }
    return null
  }
  const found = walk(predicate)
  if (found === null) throw new Error('extractRowId: no row id in predicate')
  return found
}

interface SymbolStateStub {
  recordFill: ReturnType<typeof vi.fn>
  recordFillOnce: ReturnType<typeof vi.fn>
  setCooldown: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
  clearPendingOrder: ReturnType<typeof vi.fn>
}

function makeSymbolStateNamespace(stub: SymbolStateStub): unknown {
  return {
    idFromName: (_n: string) => 'id',
    get: () => stub,
  }
}

interface PortfolioStateStub {
  applyRealizedPnl: ReturnType<typeof vi.fn>
  applyRealizedPnlOnce: ReturnType<typeof vi.fn>
}

function makePortfolioNamespace(stub: PortfolioStateStub): unknown {
  return {
    idFromName: () => 'id',
    get: () => stub,
  }
}

function makeWebullStub(detailByCoid: Record<string, unknown>) {
  return {
    findOrderByClientId: vi.fn(async (coid: string) => detailByCoid[coid]),
  }
}

function emptySymbolStateStub(): SymbolStateStub {
  return {
    recordFill: vi.fn(async () => ({})),
    recordFillOnce: vi.fn(async () => ({ state: {}, applied: true })),
    setCooldown: vi.fn(async () => ({})),
    getState: vi.fn(async () => ({
      symbol: 'SOXL',
      position: null,
      appliedClientOrderIds: [],
      pendingOrder: null,
      lastSignalAt: null,
      cooldownUntil: null,
      settledCash: 0,
      pendingSettlement: [],
      lastExecutedPrice: null,
      lastQuote: null,
      updatedAt: '2026-04-25T00:00:00.000Z',
    })),
    clearPendingOrder: vi.fn(async () => ({})),
  }
}

const FAKE_DB_BINDING = { __isFakeD1: true } as unknown as D1Database

describe('reconcileFills state-apply marker (issue #142)', () => {
  beforeEach(() => {
    // Quiet the JSON event log so test output stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })

  it('stamps state_applied_at after a successful BUY fill apply', async () => {
    const row: CandidateRow = {
      id: 7,
      clientOrderId: 'coid-buy-1',
      symbol: 'SOXL',
      side: 'BUY',
      brokerStatus: null,
      filledQty: null,
      filledPrice: null,
      realizedPnl: null,
      stateAppliedAt: null,
      stateApplyAttempts: 0,
    }
    const { db, updates } = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValue(db)
    vi.mocked(createWebullHttpClient).mockReturnValue(
      makeWebullStub({
        'coid-buy-1': {
          status: 'FILLED',
          filled_quantity: '10',
          limit_price: '50',
          side: 'BUY',
          symbol: 'SOXL',
        },
      }) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    expect(summary.inspected).toBe(1)
    expect(summary.updated).toEqual([{ clientOrderId: 'coid-buy-1', status: 'FILLED' }])
    expect(summary.stateApplied).toBe(1)
    expect(summary.stateApplyFailed).toBe(0)
    expect(summary.repaired).toBe(0)
    expect(symbolStub.recordFillOnce).toHaveBeenCalledWith('SOXL', 'coid-buy-1', {
      side: 'BUY',
      qty: 10,
      price: 50,
    })
    // Two UPDATEs: (1) journal fill columns, (2) state_applied_at marker.
    expect(updates).toHaveLength(2)
    expect(updates[1]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
    expect(updates[1]!.set.stateApplyError).toBeNull()
    // attempts uses sql`... + 1` — assert the column is being updated, not
    // the literal value.
    expect(updates[1]!.set.stateApplyAttempts).toBeDefined()
  })

  it('records state_apply_error and leaves marker NULL when DO recordFill throws', async () => {
    const row: CandidateRow = {
      id: 9,
      clientOrderId: 'coid-broken-1',
      symbol: 'SOXL',
      side: 'BUY',
      brokerStatus: null,
      filledQty: null,
      filledPrice: null,
      realizedPnl: null,
      stateAppliedAt: null,
      stateApplyAttempts: 0,
    }
    const { db, updates } = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValue(db)
    vi.mocked(createWebullHttpClient).mockReturnValue(
      makeWebullStub({
        'coid-broken-1': {
          status: 'FILLED',
          filled_quantity: '5',
          limit_price: '20',
          side: 'BUY',
          symbol: 'SOXL',
        },
      }) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()
    symbolStub.recordFillOnce.mockRejectedValueOnce(new Error('DO unavailable'))

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    expect(summary.stateApplied).toBe(0)
    expect(summary.stateApplyFailed).toBe(1)
    expect(summary.errors).toEqual([
      { clientOrderId: 'coid-broken-1', message: expect.stringContaining('state_apply_failed') },
    ])
    // UPDATEs: (1) journal fill columns, (2) failure marker (error +
    // attempts++). state_applied_at must NOT be set on either UPDATE.
    expect(updates).toHaveLength(2)
    expect(updates[0]!.set.stateAppliedAt).toBeUndefined()
    expect(updates[1]!.set.stateApplyError).toBe('DO unavailable')
    expect(updates[1]!.set.stateAppliedAt).toBeUndefined()
  })

  it('repair cohort: re-applies state for FILLED rows missing state_applied_at without re-polling Webull', async () => {
    const row: CandidateRow = {
      id: 11,
      clientOrderId: 'coid-repair-1',
      symbol: 'SOXL',
      side: 'BUY',
      brokerStatus: 'FILLED',
      filledQty: 3,
      filledPrice: 40,
      realizedPnl: null,
      stateAppliedAt: null,
      stateApplyAttempts: 1,
    }
    const { db, updates } = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValue(db)
    const webullStub = makeWebullStub({})
    vi.mocked(createWebullHttpClient).mockReturnValue(
      webullStub as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
      retryStateApply: true,
    })

    // Repair-mode rows must NOT trigger a fresh Webull poll — the canonical
    // status/qty/price are already on the row.
    expect(webullStub.findOrderByClientId).not.toHaveBeenCalled()
    expect(symbolStub.recordFillOnce).toHaveBeenCalledWith('SOXL', 'coid-repair-1', {
      side: 'BUY',
      qty: 3,
      price: 40,
    })
    expect(summary.stateApplied).toBe(1)
    expect(summary.repaired).toBe(1)
    // Only one UPDATE on the repair path: the marker stamp.
    expect(updates).toHaveLength(1)
    expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
    expect(updates[0]!.set.stateApplyError).toBeNull()
  })

  it('repair cohort: resolves side from matching pre_submit when post_submit side is NULL', async () => {
    const row: CandidateRow = {
      id: 12,
      clientOrderId: 'coid-repair-pre-side',
      symbol: 'SOXL',
      side: null,
      preSubmitSide: 'BUY',
      brokerStatus: 'FILLED',
      filledQty: 4,
      filledPrice: 124.95,
      realizedPnl: null,
      stateAppliedAt: null,
      stateApplyAttempts: 33,
    }
    const { db, updates } = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValue(db)
    const webullStub = makeWebullStub({})
    vi.mocked(createWebullHttpClient).mockReturnValue(
      webullStub as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
      retryStateApply: true,
    })

    expect(webullStub.findOrderByClientId).not.toHaveBeenCalled()
    expect(symbolStub.recordFillOnce).toHaveBeenCalledWith('SOXL', 'coid-repair-pre-side', {
      side: 'BUY',
      qty: 4,
      price: 124.95,
    })
    expect(summary.errors).toEqual([])
    expect(summary.stateApplied).toBe(1)
    expect(summary.stateApplyFailed).toBe(0)
    expect(summary.repaired).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
    expect(updates[0]!.set.stateApplyError).toBeNull()
  })

  it('repair cohort: processes duplicate joined pre_submit rows at most once', async () => {
    const duplicateRows: CandidateRow[] = [
      {
        id: 12,
        clientOrderId: 'coid-repair-duplicate-pre-side',
        symbol: 'SOXL',
        side: null,
        preSubmitSide: null,
        brokerStatus: 'FILLED',
        filledQty: 4,
        filledPrice: 124.95,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 33,
      },
      {
        id: 12,
        clientOrderId: 'coid-repair-duplicate-pre-side',
        symbol: 'SOXL',
        side: null,
        preSubmitSide: 'BUY',
        brokerStatus: 'FILLED',
        filledQty: 4,
        filledPrice: 124.95,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 33,
      },
    ]
    const { db, updates } = makeFakeDb(duplicateRows)
    vi.mocked(createDb).mockReturnValue(db)
    vi.mocked(createWebullHttpClient).mockReturnValue(
      makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
      retryStateApply: true,
    })

    expect(summary.inspected).toBe(1)
    expect(summary.errors).toEqual([])
    expect(summary.stateApplied).toBe(1)
    expect(symbolStub.recordFillOnce).toHaveBeenCalledTimes(1)
    expect(symbolStub.recordFillOnce).toHaveBeenCalledWith('SOXL', 'coid-repair-duplicate-pre-side', {
      side: 'BUY',
      qty: 4,
      price: 124.95,
    })
    expect(updates).toHaveLength(1)
  })

  it('repair cohort with no apply prerequisites: records error and skips DO call', async () => {
    const row: CandidateRow = {
      id: 13,
      clientOrderId: 'coid-bad-repair',
      symbol: 'SOXL',
      side: 'BUY',
      brokerStatus: 'FILLED',
      filledQty: 0, // invalid — should be > 0 for an applyable fill
      filledPrice: 40,
      realizedPnl: null,
      stateAppliedAt: null,
      stateApplyAttempts: 5,
    }
    const { db, updates } = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValue(db)
    vi.mocked(createWebullHttpClient).mockReturnValue(
      makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
      retryStateApply: true,
    })

    expect(symbolStub.recordFillOnce).not.toHaveBeenCalled()
    expect(summary.stateApplyFailed).toBe(1)
    expect(summary.repaired).toBe(0)
    expect(summary.errors).toEqual([
      { clientOrderId: 'coid-bad-repair', message: expect.stringContaining('repair_skipped_invalid_row') },
    ])
    // Only the failure-marker UPDATE.
    expect(updates).toHaveLength(1)
    expect(updates[0]!.set.stateApplyError).toMatch(/repair_skipped_invalid_row/)
    expect(updates[0]!.set.stateAppliedAt).toBeUndefined()
  })

  it('SELL fill: applies portfolio realized PnL and stamps marker', async () => {
    const row: CandidateRow = {
      id: 15,
      clientOrderId: 'coid-sell-1',
      symbol: 'SOXL',
      side: 'SELL',
      brokerStatus: null,
      filledQty: null,
      filledPrice: null,
      realizedPnl: null,
      stateAppliedAt: null,
      stateApplyAttempts: 0,
    }
    const { db, updates } = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValue(db)
    vi.mocked(createWebullHttpClient).mockReturnValue(
      makeWebullStub({
        'coid-sell-1': {
          status: 'FILLED',
          filled_quantity: '4',
          limit_price: '60',
          side: 'SELL',
          symbol: 'SOXL',
        },
      }) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()
    symbolStub.getState.mockResolvedValueOnce({
      symbol: 'SOXL',
      position: { qty: 4, avgPrice: 50, openedAt: '2026-04-20T00:00:00.000Z' },
      appliedClientOrderIds: [],
      pendingOrder: null,
      lastSignalAt: null,
      cooldownUntil: null,
      settledCash: 0,
      pendingSettlement: [],
      lastExecutedPrice: null,
      lastQuote: null,
      updatedAt: '2026-04-25T00:00:00.000Z',
    })
    const portfolioStub: PortfolioStateStub = {
      applyRealizedPnl: vi.fn(async () => ({})),
      applyRealizedPnlOnce: vi.fn(async () => ({ state: {}, applied: true })),
    }

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
        PORTFOLIO_STATE: makePortfolioNamespace(portfolioStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    // (60 - 50) * 4 = 40 realized.
    expect(summary.updated).toEqual([
      { clientOrderId: 'coid-sell-1', status: 'FILLED', realizedPnl: 40 },
    ])
    expect(portfolioStub.applyRealizedPnlOnce).toHaveBeenCalledWith('coid-sell-1', 40)
    expect(summary.stateApplied).toBe(1)
    expect(updates.at(-1)!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
  })

  it('repair retry after marker update failure does not double-apply DO state', async () => {
    const row: CandidateRow = {
      id: 17,
      clientOrderId: 'coid-marker-race',
      symbol: 'SOXL',
      side: 'SELL',
      brokerStatus: 'FILLED',
      filledQty: 4,
      filledPrice: 40,
      realizedPnl: -20,
      stateAppliedAt: null,
      stateApplyAttempts: 1,
    }
    const first = makeFakeDb([row], { failStateAppliedAtOnce: true })
    const second = makeFakeDb([row])
    vi.mocked(createDb).mockReturnValueOnce(first.db).mockReturnValueOnce(second.db)
    vi.mocked(createWebullHttpClient).mockReturnValue(
      makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    const symbolStub = emptySymbolStateStub()
    symbolStub.recordFillOnce
      .mockResolvedValueOnce({ state: {}, applied: true })
      .mockResolvedValueOnce({ state: {}, applied: false })
    const portfolioStub: PortfolioStateStub = {
      applyRealizedPnl: vi.fn(async () => ({})),
      applyRealizedPnlOnce: vi.fn()
        .mockResolvedValueOnce({ state: {}, applied: true })
        .mockResolvedValueOnce({ state: {}, applied: false }),
    }

    const env = {
      DB: FAKE_DB_BINDING,
      SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      PORTFOLIO_STATE: makePortfolioNamespace(portfolioStub) as never,
    } as never
    const firstSummary = await reconcileFills({
      env,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
      retryStateApply: true,
    })
    const secondSummary = await reconcileFills({
      env,
      now: () => new Date('2026-04-25T12:05:00.000Z'),
      retryStateApply: true,
    })

    expect(firstSummary.stateApplied).toBe(0)
    expect(firstSummary.stateApplyFailed).toBe(1)
    expect(secondSummary.stateApplied).toBe(1)
    expect(secondSummary.stateApplyFailed).toBe(0)
    expect(symbolStub.recordFillOnce).toHaveBeenCalledTimes(2)
    expect(portfolioStub.applyRealizedPnlOnce).toHaveBeenCalledTimes(2)
    expect(symbolStub.setCooldown).toHaveBeenCalledTimes(1)
    expect(second.updates.at(-1)!.set.stateAppliedAt).toBe('2026-04-25T12:05:00.000Z')
  })

  it('throws when env.DB binding is missing', async () => {
    await expect(reconcileFills({ env: {} as never })).rejects.toThrow(/env\.DB/)
  })
})
