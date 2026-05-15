import { describe, expect, it, vi } from 'vitest'
import {
  recordPortfolioEquitySnapshot,
  loadPortfolioEquitySnapshots,
} from '../../../src/infrastructure/db/portfolioEquitySnapshotRepo'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'

vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

function fakeInsertChain() {
  const chain = {
    values: vi.fn(async (_v: unknown) => undefined),
  }
  return {
    chain,
    db: {
      insert: vi.fn(() => chain),
    },
  }
}

function fakeSelectChain(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    $dynamic: vi.fn(() => query),
    where: vi.fn((_arg: unknown) => query),
    orderBy: vi.fn((..._args: unknown[]) => query),
    limit: vi.fn(async (_n: number) => rows),
  }
  return {
    query,
    db: {
      select: vi.fn(() => query),
    },
  }
}

const fakeD1 = {} as D1Database

describe('recordPortfolioEquitySnapshot', () => {
  it('inserts a row with all fields populated', async () => {
    const { db, chain } = fakeInsertChain()
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await recordPortfolioEquitySnapshot(fakeD1, {
      snapshotAt: '2026-05-16T00:00:00.000Z',
      dailyStartEquityUsd: 10000,
      dailyStartEquityJpy: 1500000,
      dailyRealizedPnlUsd: -50,
      dailyRealizedPnlJpy: -8000,
      drawdownPct: -0.005,
      requestId: 'req-roll-1',
    })

    expect(chain.values).toHaveBeenCalledTimes(1)
    expect(chain.values.mock.calls[0]![0]).toEqual({
      snapshotAt: '2026-05-16T00:00:00.000Z',
      dailyStartEquityUsd: 10000,
      dailyStartEquityJpy: 1500000,
      dailyRealizedPnlUsd: -50,
      dailyRealizedPnlJpy: -8000,
      drawdownPct: -0.005,
      requestId: 'req-roll-1',
    })
  })

  it('defaults nullable fields to null when omitted', async () => {
    const { db, chain } = fakeInsertChain()
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await recordPortfolioEquitySnapshot(fakeD1, {
      snapshotAt: '2026-05-16T00:00:00.000Z',
      dailyStartEquityUsd: 10000,
    })

    expect(chain.values).toHaveBeenCalledWith({
      snapshotAt: '2026-05-16T00:00:00.000Z',
      dailyStartEquityUsd: 10000,
      dailyStartEquityJpy: null,
      dailyRealizedPnlUsd: null,
      dailyRealizedPnlJpy: null,
      drawdownPct: null,
      requestId: null,
    })
  })
})

describe('loadPortfolioEquitySnapshots', () => {
  it('applies from/to range together and orders ASC', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadPortfolioEquitySnapshots(fakeD1, {
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-16T00:00:00.000Z',
      limit: 50,
    })

    expect(query.where).toHaveBeenCalledTimes(1)
    expect(query.orderBy).toHaveBeenCalledTimes(1)
    expect(query.limit).toHaveBeenCalledWith(50)
  })

  it('omits where() when no range is given and defaults limit to 365', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadPortfolioEquitySnapshots(fakeD1, {})

    expect(query.where).not.toHaveBeenCalled()
    expect(query.limit).toHaveBeenCalledWith(365)
  })

  it('clamps an excessive limit to 3650', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadPortfolioEquitySnapshots(fakeD1, { limit: 9_999_999 })

    expect(query.limit).toHaveBeenCalledWith(3650)
  })

  it('coerces non-finite / non-positive limit to the default', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadPortfolioEquitySnapshots(fakeD1, { limit: -10 })
    expect(query.limit).toHaveBeenCalledWith(365)

    vi.mocked(createDb).mockReturnValue(fakeSelectChain([]).db as unknown as ReturnType<typeof createDb>)
    await loadPortfolioEquitySnapshots(fakeD1, { limit: Number.NaN })
  })

  it('returns rows as-is from the underlying query', async () => {
    const rows = [
      { id: 1, snapshotAt: '2026-05-15T00:00:00.000Z', dailyStartEquityUsd: 10000 },
    ]
    const { db } = fakeSelectChain(rows)
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    const result = await loadPortfolioEquitySnapshots(fakeD1, {})
    expect(result).toBe(rows)
  })
})
