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

  // ---------------------------------------------------------------------------
  // referenceLimitPrice (issue: 9697 ping-pong loop where broker echoes the
  // same stub for both filled_price and limit_price → ratio=1 silently
  // passes the PR #223 sanity guard and a $10 stub fills DO state.
  //
  // Fix: prefer the pre_submit row's limit_price (= our signed intent) over
  // detail.limit_price as the ratio reference.
  // ---------------------------------------------------------------------------
  describe('resolveFilledPrice with referenceLimitPrice (pre_submit intent)', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('rejects 9697-style stub (filled=10, broker.limit=10, pre_submit=3516)', () => {
      // The exact bug: broker echoes a stub limit_price that matches its
      // stub filled_price, so ratio = 10/10 = 1 and the prior implementation
      // accepted the bogus fill. With the pre_submit reference, ratio
      // = 10/3516 = 0.00284 → reject.
      const detail = {
        items: [{ filled_price: '10' }],
        limit_price: '10',
      }
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: 3516 }),
      ).toBeNull()
    })

    it('accepts a healthy fill against the pre_submit reference (215 vs 215.42)', () => {
      const detail = {
        items: [{ filled_price: '215' }],
        limit_price: '215.42',
      }
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: 215.42 }),
      ).toBe(215)
    })

    it('falls back to broker limit when referenceLimitPrice is null', () => {
      // No pre_submit reference (= legacy caller). Existing behaviour:
      // ratio uses broker limit. Stub-vs-stub still passes (ratio=1) — this
      // is the bug we are fixing for the new caller, but the fallback is
      // preserved to avoid regression for any non-reconcile call site.
      const detail = {
        items: [{ filled_price: '10' }],
        limit_price: '10',
      }
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: null }),
      ).toBe(10)
    })

    it('skips ratio check when both references are absent (defensive)', () => {
      const detail = {
        items: [{ filled_price: '10' }],
      }
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: null }),
      ).toBe(10)
    })

    it('treats non-positive referenceLimitPrice as missing (falls back to broker limit)', () => {
      // Defensive against malformed pre_submit rows. 0 / negative → ignore
      // and fall back to broker echo.
      const detail = {
        items: [{ filled_price: '10' }],
        limit_price: '2683',
      }
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: 0 }),
      ).toBeNull()
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: -1 }),
      ).toBeNull()
    })

    it('preferred: pre_submit accepts even if broker limit would reject', () => {
      // Pre-submit limit aligns with reality (3516); broker echoes a stub
      // 215.42 that would reject 3500. Trusting pre_submit lets the
      // healthy fill through.
      const detail = {
        items: [{ filled_price: '3500' }],
        limit_price: '215.42',
      }
      expect(
        _internal.resolveFilledPrice(1, detail, { referenceLimitPrice: 3516 }),
      ).toBe(3500)
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
  /**
   * pre_submit 行の limit_price (= 我々が intent で signed した値)。
   * sanity check の ratio reference として broker.limit_price より優先
   * 利用される。null の場合 (= MARKET order without limit) は broker
   * echo にフォールバック、それも無ければ ratio check skip。
   */
  preSubmitLimitPrice?: number | null
  brokerStatus: string | null
  filledQty: number | null
  filledPrice: number | null
  realizedPnl: number | null
  stateAppliedAt: string | null
  stateApplyAttempts: number
  /**
   * Last `state_apply_error` recorded on the journal row. Read by the
   * auto-abandon path (`isPermanentSanityFailure`) to decide whether
   * MAX_REPAIR_ATTEMPTS-exceeded rows should be force-stamped or left
   * to keep retrying (transient errors).
   */
  stateApplyError?: string | null
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

  // ---------------------------------------------------------------------------
  // sanity failure → repair cohort retention (PR #223 CodeRabbit Major)
  //
  // When `resolveFilledPrice()` rejects a fill price as a stub (ratio guard),
  // the row must be left WITHOUT `state_applied_at` so the next reconcile
  // tick re-selects it from the repair cohort and tries again with whatever
  // the broker now reports.
  // ---------------------------------------------------------------------------

  it('sanity failure: keeps state_applied_at NULL so next tick retries', async () => {
    // JP UAT 6971-style stub: filled_quantity > 0 but filled_price=10 vs
    // limit_price=2683 — sanity ratio guard rejects.
    const row: CandidateRow = {
      id: 31,
      clientOrderId: 'coid-jp-stub-1',
      symbol: '6971',
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
        'coid-jp-stub-1': {
          status: 'FILLED',
          filled_quantity: '1',
          limit_price: '2683',
          items: [{ filled_price: '10' }],
          side: 'BUY',
          symbol: '6971',
        },
      }) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    // Quiet sanity warn log.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    // DO state apply must NOT happen — the stub price would poison avgPrice.
    expect(symbolStub.recordFillOnce).not.toHaveBeenCalled()

    // Two UPDATEs:
    //   (1) journal fill columns (broker_status=FILLED, filled_qty=1,
    //       filled_price=null because sanity rejected)
    //   (2) failure marker (state_apply_error set, attempts++) — but
    //       crucially state_applied_at must NOT be stamped.
    expect(updates).toHaveLength(2)
    expect(updates[0]!.set.brokerStatus).toBe('FILLED')
    expect(updates[0]!.set.filledQty).toBe(1)
    expect(updates[0]!.set.filledPrice).toBeNull()
    expect(updates[0]!.set.stateAppliedAt).toBeUndefined()
    // Failure marker UPDATE: error recorded, marker NOT stamped → row
    // remains in repair cohort for next tick.
    expect(updates[1]!.set.stateAppliedAt).toBeUndefined()
    expect(updates[1]!.set.stateApplyError).toMatch(/sanity_failed/)
    expect(updates[1]!.set.stateApplyAttempts).toBeDefined()

    expect(summary.stateApplied).toBe(0)
    expect(summary.stateApplyFailed).toBe(1)
    expect(summary.repaired).toBe(0)
    expect(summary.errors).toEqual([
      { clientOrderId: 'coid-jp-stub-1', message: expect.stringContaining('sanity_failed') },
    ])
  })

  it('next reconcile tick: realistic broker price → DO apply succeeds, marker stamped', async () => {
    // Same row from the sanity failure — broker_status='FILLED' already
    // recorded but state_applied_at still NULL. retryStateApply=true sweeps
    // it back. This time the broker returns a realistic 2680 vs 2683 (within
    // the 0.5–2x band) — but note the repair branch uses the canonical
    // filled_price already on the row, NOT the broker's response. So we
    // simulate the row having been updated (e.g. by a prior cron tick that
    // saw a realistic broker price between #1 and #2 — equivalent to the row
    // gaining a usable price by some path).
    //
    // Practical model: imagine the prior cron tick observed the new healthy
    // price and the journal UPDATE wrote `filled_price=2680`, but the DO
    // apply still failed transiently. retryStateApply now picks it up.
    const row: CandidateRow = {
      id: 31,
      clientOrderId: 'coid-jp-stub-1',
      symbol: '6971',
      side: 'BUY',
      brokerStatus: 'FILLED',
      filledQty: 1,
      filledPrice: 2680,
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
      now: () => new Date('2026-04-25T12:05:00.000Z'),
      retryStateApply: true,
    })

    // Repair path doesn't re-poll Webull.
    expect(webullStub.findOrderByClientId).not.toHaveBeenCalled()
    // DO apply now runs with the healthy price.
    expect(symbolStub.recordFillOnce).toHaveBeenCalledWith('6971', 'coid-jp-stub-1', {
      side: 'BUY',
      qty: 1,
      price: 2680,
    })
    expect(summary.stateApplied).toBe(1)
    expect(summary.repaired).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:05:00.000Z')
    expect(updates[0]!.set.stateApplyError).toBeNull()
  })

  it('FILLED with filledQty=0 (genuine no-op): stamps marker — no retry forever', async () => {
    // Distinguishes (b) sanity failure from (a) genuine "FILLED but nothing
    // to apply". CANCELLED-then-FILLED shaped rows (filledQty=0) have no
    // recoverable state — stamp the marker so the row exits the repair
    // cohort.
    const row: CandidateRow = {
      id: 33,
      clientOrderId: 'coid-zero-qty',
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
        'coid-zero-qty': {
          status: 'FILLED',
          filled_quantity: '0',
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

    expect(symbolStub.recordFillOnce).not.toHaveBeenCalled()
    // Two UPDATEs: journal fill columns + state_applied_at marker (no-op
    // path — nothing to apply, stamp so we don't retry forever).
    expect(updates).toHaveLength(2)
    expect(updates[1]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
    expect(summary.stateApplied).toBe(0)
    expect(summary.stateApplyFailed).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // 9697 ping-pong scenario (this PR): broker echoes detail.limit_price=10 to
  // match its stub filled_price=10 → ratio=1 silently passes the PR #223
  // sanity check. Pre_submit limit_price (3516, our signed intent) is the
  // fix: ratio collapses to 10/3516 = 0.00284, sanity rejects, DO is spared.
  // ---------------------------------------------------------------------------
  it('JP 9697 stub: broker echoes limit=10 matching filled=10 — pre_submit limit catches it', async () => {
    const row: CandidateRow = {
      id: 92, // matches the post_submit row id from the bug report
      clientOrderId: 'coid-9697-stub',
      symbol: '9697',
      side: 'BUY',
      preSubmitSide: 'BUY',
      // Pre_submit row id 91 with limit_price=3516. JOIN attaches it here.
      preSubmitLimitPrice: 3516,
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
        'coid-9697-stub': {
          status: 'FILLED',
          filled_quantity: '1',
          // BUG: broker echoes the same stub for both fields. Without the
          // pre_submit reference, ratio = 10/10 = 1 and PR #223 sanity
          // wrongly accepts the fill.
          limit_price: '10',
          items: [{ filled_price: '10' }],
          side: 'BUY',
          symbol: '9697',
        },
      }) as unknown as ReturnType<typeof createWebullHttpClient>,
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const symbolStub = emptySymbolStateStub()

    const summary = await reconcileFills({
      env: {
        DB: FAKE_DB_BINDING,
        SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
      } as never,
      now: () => new Date('2026-04-25T12:00:00.000Z'),
    })

    // DO state must NOT be touched — that's the whole point. avgPrice=10
    // would have triggered a TP→SELL→re-fill ping-pong against a real
    // entry near 3516.
    expect(symbolStub.recordFillOnce).not.toHaveBeenCalled()

    // Two UPDATEs:
    //   (1) journal fill columns: broker_status=FILLED, filled_qty=1,
    //       filled_price=null (sanity rejected via pre_submit reference)
    //   (2) failure marker — state_applied_at must NOT be stamped so the
    //       row stays in the repair cohort for next tick.
    expect(updates).toHaveLength(2)
    expect(updates[0]!.set.brokerStatus).toBe('FILLED')
    expect(updates[0]!.set.filledQty).toBe(1)
    expect(updates[0]!.set.filledPrice).toBeNull()
    expect(updates[0]!.set.stateAppliedAt).toBeUndefined()
    expect(updates[1]!.set.stateAppliedAt).toBeUndefined()
    expect(updates[1]!.set.stateApplyError).toMatch(/sanity_failed/)

    expect(summary.stateApplied).toBe(0)
    expect(summary.stateApplyFailed).toBe(1)
    expect(summary.errors).toEqual([
      { clientOrderId: 'coid-9697-stub', message: expect.stringContaining('sanity_failed') },
    ])
  })

  it('shouldRetryStateApply: true only for FILLED + qty>0 + price=null', () => {
    const fn = _internal.shouldRetryStateApply as (
      qty: number | null,
      price: number | null,
      status: string | null,
    ) => boolean
    expect(fn(1, null, 'FILLED')).toBe(true) // sanity failure: retry
    expect(fn(0, null, 'FILLED')).toBe(false) // genuine no-op
    expect(fn(null, null, 'FILLED')).toBe(false) // missing qty
    expect(fn(1, 50, 'FILLED')).toBe(false) // healthy fill
    expect(fn(1, null, 'CANCELLED')).toBe(false) // not FILLED
    expect(fn(1, null, null)).toBe(false) // no status
  })

  // ---------------------------------------------------------------------------
  // auto-abandon (this PR): rows that have tripped a permanent sanity-class
  // error MAX_REPAIR_ATTEMPTS times should be force-stamped state_applied_at
  // so they fall out of the repair cohort and stop driving the
  // reconcile_fills_partial alarm forever. Transient errors (broker_5xx,
  // network) must keep retrying past 5 attempts.
  //
  // Real-world trigger: 9697 — 6 rows accumulated to attempts 12-24 with
  // `state_apply_error='sanity_failed: filled_price rejected by ratio guard'`,
  // and the operator received the same alert every 5-minute cron tick.
  // ---------------------------------------------------------------------------
  describe('auto-abandon for sanity-stuck repair rows', () => {
    it('attempts >= 5 + sanity_failed → force-stamps state_applied_at and bumps abandoned count', async () => {
      const row: CandidateRow = {
        id: 9697,
        clientOrderId: 'coid-stuck-sanity',
        symbol: '9697',
        side: 'BUY',
        brokerStatus: 'FILLED',
        // filled_price=null is the actual on-disk shape for sanity-rejected
        // rows (resolveFilledPrice returned null and the journal UPDATE
        // wrote NULL). Repair branch's invalid-row guard would normally
        // catch this, but we want the auto-abandon path to fire FIRST so
        // the row drops out of the cohort before consuming another
        // `repair_skipped_invalid_row` slot.
        filledQty: 1,
        filledPrice: null,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 5,
        stateApplyError: 'sanity_failed: filled_price rejected by ratio guard',
      }
      const { db, updates } = makeFakeDb([row])
      vi.mocked(createDb).mockReturnValue(db)
      vi.mocked(createWebullHttpClient).mockReturnValue(
        makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
      )
      // Quiet the audit-log warn so the test output stays readable.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const symbolStub = emptySymbolStateStub()

      const summary = await reconcileFills({
        env: {
          DB: FAKE_DB_BINDING,
          SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
        } as never,
        now: () => new Date('2026-04-25T12:00:00.000Z'),
        retryStateApply: true,
      })

      // No DO call — abandoned rows are not re-applied.
      expect(symbolStub.recordFillOnce).not.toHaveBeenCalled()
      // Single UPDATE: the auto-abandon stamp.
      expect(updates).toHaveLength(1)
      expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
      expect(updates[0]!.set.stateApplyError).toMatch(/^auto_abandoned_after_5_attempts:/)
      expect(updates[0]!.set.stateApplyError).toMatch(/sanity_failed/)
      expect(updates[0]!.set.stateApplyAttempts).toBeDefined()
      // Counts: abandoned bumps, errors stays empty (so notifier stays quiet).
      expect(summary.abandoned).toBe(1)
      expect(summary.stateApplied).toBe(0)
      expect(summary.stateApplyFailed).toBe(0)
      expect(summary.errors).toEqual([])
      // Audit log emitted so operator can see the abandon event.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"reconcile_auto_abandon"'),
      )
      const auditLog = JSON.parse(warnSpy.mock.calls[0]![0] as string)
      expect(auditLog).toMatchObject({
        event: 'reconcile_auto_abandon',
        rowId: 9697,
        clientOrderId: 'coid-stuck-sanity',
        symbol: '9697',
        attempts: 5,
        priorError: 'sanity_failed: filled_price rejected by ratio guard',
      })
    })

    it('attempts >= 5 + repair_skipped_invalid_row → also abandons', async () => {
      // Second permanent sanity class: repair branch detected a structurally
      // invalid FILLED row (qty<=0). Same outcome — keeps tripping the same
      // error, no recovery possible.
      const row: CandidateRow = {
        id: 100,
        clientOrderId: 'coid-stuck-invalid',
        symbol: 'SOXL',
        side: 'BUY',
        brokerStatus: 'FILLED',
        filledQty: 0,
        filledPrice: 40,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 8,
        stateApplyError: 'repair_skipped_invalid_row: symbol=SOXL side=BUY qty=0 price=40',
      }
      const { db, updates } = makeFakeDb([row])
      vi.mocked(createDb).mockReturnValue(db)
      vi.mocked(createWebullHttpClient).mockReturnValue(
        makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
      )
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const symbolStub = emptySymbolStateStub()

      const summary = await reconcileFills({
        env: {
          DB: FAKE_DB_BINDING,
          SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
        } as never,
        now: () => new Date('2026-04-25T12:00:00.000Z'),
        retryStateApply: true,
      })

      expect(updates).toHaveLength(1)
      expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
      expect(updates[0]!.set.stateApplyError).toMatch(/^auto_abandoned_after_8_attempts:/)
      expect(updates[0]!.set.stateApplyError).toMatch(/repair_skipped_invalid_row/)
      expect(summary.abandoned).toBe(1)
      expect(summary.errors).toEqual([])
    })

    it('attempts < 5 + sanity_failed → keeps retrying (existing behaviour)', async () => {
      // Below threshold: standard repair retry path. Because filledPrice is
      // null on this row the repair branch's invalid-row guard fires (this
      // is the existing `repair_skipped_invalid_row` path) — what we are
      // asserting is that auto-abandon does NOT fire prematurely.
      const row: CandidateRow = {
        id: 200,
        clientOrderId: 'coid-stuck-early',
        symbol: '9697',
        side: 'BUY',
        brokerStatus: 'FILLED',
        filledQty: 1,
        filledPrice: null,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 4,
        stateApplyError: 'sanity_failed: filled_price rejected by ratio guard',
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

      // Existing path: repair_skipped_invalid_row fires (filledPrice=null).
      // state_applied_at MUST NOT be stamped (= row stays in repair cohort).
      expect(symbolStub.recordFillOnce).not.toHaveBeenCalled()
      expect(updates).toHaveLength(1)
      expect(updates[0]!.set.stateAppliedAt).toBeUndefined()
      expect(updates[0]!.set.stateApplyError).toMatch(/repair_skipped_invalid_row/)
      // Crucially: NOT abandoned, error counted (so the operator alert can
      // still surface a fresh issue while it is recoverable).
      expect(summary.abandoned).toBe(0)
      expect(summary.stateApplyFailed).toBe(1)
      expect(summary.errors).toHaveLength(1)
    })

    it('attempts >= 5 + transient error (DO unavailable) → keeps retrying (NOT abandoned)', async () => {
      // Transient errors should never auto-abandon — the next tick may
      // succeed even after dozens of failures. Here `state_apply_error`
      // does NOT contain `sanity_failed` / `repair_skipped_invalid_row`,
      // so `isPermanentSanityFailure` returns false.
      //
      // We give the row a usable filled_price so the standard repair
      // path runs; the DO stub then throws to simulate a still-broken
      // underlying.
      const row: CandidateRow = {
        id: 300,
        clientOrderId: 'coid-stuck-transient',
        symbol: 'SOXL',
        side: 'BUY',
        brokerStatus: 'FILLED',
        filledQty: 3,
        filledPrice: 40,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 10, // way past the threshold
        stateApplyError: 'DO unavailable',
      }
      const { db, updates } = makeFakeDb([row])
      vi.mocked(createDb).mockReturnValue(db)
      vi.mocked(createWebullHttpClient).mockReturnValue(
        makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
      )
      const symbolStub = emptySymbolStateStub()
      symbolStub.recordFillOnce.mockRejectedValueOnce(new Error('DO still unavailable'))

      const summary = await reconcileFills({
        env: {
          DB: FAKE_DB_BINDING,
          SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
        } as never,
        now: () => new Date('2026-04-25T12:00:00.000Z'),
        retryStateApply: true,
      })

      // Repair path actually ran (= we did not auto-abandon).
      expect(symbolStub.recordFillOnce).toHaveBeenCalled()
      // Single UPDATE — the recordApplyFailure error stamp. state_applied_at
      // MUST NOT be set (= row remains in cohort for next tick).
      expect(updates).toHaveLength(1)
      expect(updates[0]!.set.stateAppliedAt).toBeUndefined()
      expect(updates[0]!.set.stateApplyError).toBe('DO still unavailable')
      expect(summary.abandoned).toBe(0)
      expect(summary.stateApplyFailed).toBe(1)
    })

    it('attempts >= 5 + null state_apply_error → keeps retrying (NOT abandoned)', async () => {
      // Defensive: a row could conceivably have high attempts with a null
      // error column (e.g. attempts bump after marker UPDATE failure
      // clears the prior error). isPermanentSanityFailure(null) is false →
      // do not abandon, let the standard path run.
      const row: CandidateRow = {
        id: 400,
        clientOrderId: 'coid-null-error',
        symbol: 'SOXL',
        side: 'BUY',
        brokerStatus: 'FILLED',
        filledQty: 2,
        filledPrice: 35,
        realizedPnl: null,
        stateAppliedAt: null,
        stateApplyAttempts: 7,
        stateApplyError: null,
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

      // Standard repair path runs (DO apply succeeded).
      expect(symbolStub.recordFillOnce).toHaveBeenCalled()
      expect(summary.abandoned).toBe(0)
      expect(summary.stateApplied).toBe(1)
      expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
    })

    it('markAsAbandoned UPDATE throws → loop continues, row goes to errors, abandoned not bumped', async () => {
      // CodeRabbit #228: the auto-abandon UPDATE must be wrapped in
      // try/catch so a single transient D1 failure does not abort the
      // whole reconcile batch. Two rows both qualify for auto-abandon;
      // the first row's UPDATE throws (simulated via
      // `failStateAppliedAtOnce`) — the loop must continue to process
      // the second row, which abandons normally.
      const stuckRows: CandidateRow[] = [
        {
          id: 9697,
          clientOrderId: 'coid-stuck-1',
          symbol: '9697',
          side: 'BUY',
          brokerStatus: 'FILLED',
          filledQty: 1,
          filledPrice: null,
          realizedPnl: null,
          stateAppliedAt: null,
          stateApplyAttempts: 5,
          stateApplyError: 'sanity_failed: filled_price rejected by ratio guard',
        },
        {
          id: 9698,
          clientOrderId: 'coid-stuck-2',
          symbol: '9697',
          side: 'BUY',
          brokerStatus: 'FILLED',
          filledQty: 1,
          filledPrice: null,
          realizedPnl: null,
          stateAppliedAt: null,
          stateApplyAttempts: 6,
          stateApplyError: 'sanity_failed: filled_price rejected by ratio guard',
        },
      ]
      // Fail the first stateAppliedAt-bearing UPDATE (= first row's
      // markAsAbandoned). Second row's UPDATE then succeeds.
      const { db, updates } = makeFakeDb(stuckRows, { failStateAppliedAtOnce: true })
      vi.mocked(createDb).mockReturnValue(db)
      vi.mocked(createWebullHttpClient).mockReturnValue(
        makeWebullStub({}) as unknown as ReturnType<typeof createWebullHttpClient>,
      )
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const symbolStub = emptySymbolStateStub()

      const summary = await reconcileFills({
        env: {
          DB: FAKE_DB_BINDING,
          SYMBOL_STATE: makeSymbolStateNamespace(symbolStub) as never,
        } as never,
        now: () => new Date('2026-04-25T12:00:00.000Z'),
        retryStateApply: true,
      })

      // Both rows attempted the auto-abandon UPDATE (= loop continued
      // past the first row's failure). Both UPDATEs carry the abandon
      // marker shape (`stateAppliedAt` + `auto_abandoned_after_*`).
      expect(updates).toHaveLength(2)
      expect(updates[0]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
      expect(updates[0]!.set.stateApplyError).toMatch(/^auto_abandoned_after_5_attempts:/)
      expect(updates[1]!.set.stateAppliedAt).toBe('2026-04-25T12:00:00.000Z')
      expect(updates[1]!.set.stateApplyError).toMatch(/^auto_abandoned_after_6_attempts:/)
      // First row failed: surfaced as an error, NOT counted as abandoned.
      // Second row succeeded: counted as abandoned.
      expect(summary.abandoned).toBe(1)
      // CodeRabbit #228 minor: stateApplyFailed counts DO state apply
      // failures, not auto-abandon DB UPDATE failures. The latter is
      // tracked via summary.errors.
      expect(summary.stateApplyFailed).toBe(0)
      expect(summary.errors).toEqual([
        {
          clientOrderId: 'coid-stuck-1',
          message: expect.stringContaining('auto_abandon_failed:'),
        },
      ])
      // Error log emitted for the failed row.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"reconcile_auto_abandon_error"'),
      )
      // Second row's success audit log emitted.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"reconcile_auto_abandon"'),
      )
    })
  })
})
