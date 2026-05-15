import { describe, expect, it, vi } from 'vitest'
import {
  extractActor,
  recordChange,
  loadRecentAudit,
} from '../../../src/infrastructure/db/configAuditLog'
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

describe('recordChange', () => {
  it('skips the row when before == after (no-op)', async () => {
    const { db, chain } = fakeInsertChain()
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    const result = await recordChange(fakeD1, {
      actor: 'ai-agent',
      endpoint: '/admin/symbols/:symbol/seed-cash',
      targetKey: 'symbol=SOXL',
      before: { settledCash: 1000 },
      after: { settledCash: 1000 },
    })

    expect(result).toEqual({ recorded: false })
    expect(db.insert).not.toHaveBeenCalled()
    expect(chain.values).not.toHaveBeenCalled()
  })

  it('inserts a stringified diff row when before != after', async () => {
    const { db, chain } = fakeInsertChain()
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    const result = await recordChange(fakeD1, {
      actor: 'alice',
      endpoint: '/admin/symbols/:symbol/seed-cash',
      targetKey: 'symbol=SOXL',
      before: { settledCash: 1000 },
      after: { settledCash: 2000 },
      requestId: 'req-1',
      now: () => new Date('2026-05-15T12:00:00.000Z'),
    })

    expect(result).toEqual({ recorded: true })
    expect(chain.values).toHaveBeenCalledTimes(1)
    expect(chain.values.mock.calls[0]![0]).toEqual({
      timestamp: '2026-05-15T12:00:00.000Z',
      actor: 'alice',
      endpoint: '/admin/symbols/:symbol/seed-cash',
      targetKey: 'symbol=SOXL',
      beforeJson: JSON.stringify({ settledCash: 1000 }),
      afterJson: JSON.stringify({ settledCash: 2000 }),
      requestId: 'req-1',
    })
  })

  it('treats null and undefined before/after as JSON null (still skips when both are null)', async () => {
    const { db } = fakeInsertChain()
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    const result = await recordChange(fakeD1, {
      actor: 'ai-agent',
      endpoint: '/admin/earnings/:id',
      targetKey: 'earnings_id=7',
      before: undefined,
      after: null,
    })

    expect(result).toEqual({ recorded: false })
    expect(db.insert).not.toHaveBeenCalled()
  })
})

describe('extractActor', () => {
  it('returns ai-agent when the Authorization header is absent', () => {
    expect(extractActor(undefined)).toBe('ai-agent')
    expect(extractActor(null)).toBe('ai-agent')
    expect(extractActor('')).toBe('ai-agent')
  })

  it('decodes basic-auth username (drops password)', () => {
    const header = `Basic ${btoa('alice:secret')}`
    expect(extractActor(header)).toBe('alice')
  })

  it('handles lowercase scheme and surrounding whitespace', () => {
    const header = `  basic ${btoa('bob:pw')}  `
    expect(extractActor(header)).toBe('bob')
  })

  it('falls back to ai-agent on malformed token', () => {
    expect(extractActor('Bearer abc')).toBe('ai-agent')
    expect(extractActor('Basic !!!not-base64!!!')).toBe('ai-agent')
  })

  it('falls back to ai-agent when the decoded username is empty', () => {
    const header = `Basic ${btoa(':only-password')}`
    expect(extractActor(header)).toBe('ai-agent')
  })
})

describe('loadRecentAudit', () => {
  it('applies actor + endpoint + date range together via AND', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAudit(fakeD1, {
      actor: 'alice',
      endpoint: '/admin/symbols/:symbol/seed-cash',
      fromIso: '2026-05-01T00:00:00.000Z',
      toIso: '2026-05-15T23:59:59.999Z',
    })

    expect(query.where).toHaveBeenCalledTimes(1)
    const condition = query.where.mock.calls[0]![0] as { queryChunks?: unknown[] } | undefined
    expect(condition).toBeDefined()
    expect(condition && 'queryChunks' in condition).toBe(true)
  })

  it('omits where() when no filter is given and clamps limit to 500', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAudit(fakeD1, { limit: 9999 })

    expect(query.where).not.toHaveBeenCalled()
    expect(query.limit).toHaveBeenCalledWith(500)
  })

  it('defaults limit to 100 when omitted', async () => {
    const { db, query } = fakeSelectChain([])
    vi.mocked(createDb).mockReturnValue(db as unknown as ReturnType<typeof createDb>)

    await loadRecentAudit(fakeD1, {})

    expect(query.limit).toHaveBeenCalledWith(100)
  })
})
