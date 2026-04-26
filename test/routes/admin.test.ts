import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { reconcileFills } from '../../src/trading/reconciliation/reconcileFills'

vi.mock('../../src/trading/reconciliation/reconcileFills', () => ({
  reconcileFills: vi.fn(),
}))

const baseEnv = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'false',
  ALLOWED_SYMBOLS: 'SOXL',
  MAX_ORDER_NOTIONAL: '100',
}

const authHeader = { Authorization: `Basic ${btoa('admin:secret')}` }

function fakeSymbolState(captured: { calls: Array<{ symbol: string; amount: number }> }) {
  const stub = {
    async seedSettledCash(symbol: string, amount: number) {
      captured.calls.push({ symbol, amount })
      return {
        symbol,
        position: null,
        pendingOrder: null,
        lastSignalAt: null,
        cooldownUntil: null,
        settledCash: amount,
        pendingSettlement: [],
        lastExecutedPrice: null,
        lastQuote: null,
        updatedAt: '2026-04-21T10:00:00.000Z',
      }
    },
  }
  // Minimal DurableObjectNamespace shape for the SymbolStateClient wrapper.
  return {
    idFromName: (_name: string) => 'id',
    get: (_id: string) => stub,
  } as unknown
}

describe('POST /admin/symbols/:symbol/seed-cash', () => {
  it('401s without Basic Auth', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/symbols/SOXL/seed-cash',
      { method: 'POST', body: JSON.stringify({ amount: 100 }) },
      baseEnv,
    )
    expect(res.status).toBe(401)
  })

  it('400s when body is not a JSON object', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ symbol: string; amount: number }> }
    const res = await app.request(
      '/admin/symbols/SOXL/seed-cash',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: 'not-json',
      },
      { ...baseEnv, SYMBOL_STATE: fakeSymbolState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('400s on negative amount', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ symbol: string; amount: number }> }
    const res = await app.request(
      '/admin/symbols/SOXL/seed-cash',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ amount: -5 }),
      },
      { ...baseEnv, SYMBOL_STATE: fakeSymbolState(captured) },
    )
    expect(res.status).toBe(400)
    expect(captured.calls).toEqual([])
  })

  it('200s and forwards the amount to SYMBOL_STATE.seedSettledCash', async () => {
    const app = createApp()
    const captured = { calls: [] as Array<{ symbol: string; amount: number }> }
    const res = await app.request(
      '/admin/symbols/soxl/seed-cash',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ amount: 12_345 }),
      },
      { ...baseEnv, SYMBOL_STATE: fakeSymbolState(captured) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { symbol: string; settledCash: number }
    expect(body).toEqual({
      symbol: 'SOXL',
      settledCash: 12_345,
      updatedAt: '2026-04-21T10:00:00.000Z',
    })
    expect(captured.calls).toEqual([{ symbol: 'SOXL', amount: 12_345 }])
  })
})

describe('POST /admin/orders/reconcile', () => {
  afterEach(() => vi.resetAllMocks())

  function emptySummary() {
    return {
      inspected: 0,
      updated: [],
      stillPending: [],
      notFound: [],
      errors: [],
      stateApplied: 0,
      stateApplyFailed: 0,
      repaired: 0,
    }
  }

  it('forwards retryStateApply=false to reconcileFills by default', async () => {
    vi.mocked(reconcileFills).mockResolvedValueOnce(emptySummary())
    const app = createApp()
    const res = await app.request(
      '/admin/orders/reconcile',
      { method: 'POST', headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(200)
    expect(reconcileFills).toHaveBeenCalledTimes(1)
    expect(vi.mocked(reconcileFills).mock.calls[0]![0]).toMatchObject({
      retryStateApply: false,
    })
  })

  it.each(['1', 'true', 'TRUE', 'yes'])(
    'enables repair sweep when ?retryStateApply=%s',
    async (value) => {
      vi.mocked(reconcileFills).mockResolvedValueOnce(emptySummary())
      const app = createApp()
      const res = await app.request(
        `/admin/orders/reconcile?retryStateApply=${value}`,
        { method: 'POST', headers: { ...authHeader } },
        baseEnv,
      )
      expect(res.status).toBe(200)
      expect(vi.mocked(reconcileFills).mock.calls[0]![0]).toMatchObject({
        retryStateApply: true,
      })
    },
  )

  it('treats unknown ?retryStateApply values as false (fail-closed)', async () => {
    vi.mocked(reconcileFills).mockResolvedValueOnce(emptySummary())
    const app = createApp()
    const res = await app.request(
      '/admin/orders/reconcile?retryStateApply=please',
      { method: 'POST', headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(200)
    expect(vi.mocked(reconcileFills).mock.calls[0]![0]).toMatchObject({
      retryStateApply: false,
    })
  })
})

describe('GET /admin/orders/repair-status', () => {
  function fakeDbReturning(count: number) {
    const chain = {
      from: () => chain,
      where: async () => [{ count }],
    }
    return { select: () => chain }
  }

  it('401s without Basic Auth', async () => {
    const app = createApp()
    const res = await app.request('/admin/orders/repair-status', {}, {
      ...baseEnv,
      DB: fakeDbReturning(3) as unknown as D1Database,
    })
    expect(res.status).toBe(401)
  })

  it('200s with the count of FILLED rows missing state_applied_at', async () => {
    // Stub createDb so we can inject the query result without spinning up a
    // real D1. The wrapper just receives the env.DB reference and forwards
    // a typed drizzle handle, but here we want the chain we control.
    const dbModule = await import('../../src/infrastructure/db/tradeJournalRepo')
    const spy = vi
      .spyOn(dbModule, 'createDb')
      .mockReturnValue(fakeDbReturning(7) as never)

    const app = createApp()
    const res = await app.request(
      '/admin/orders/repair-status',
      { headers: { ...authHeader } },
      { ...baseEnv, DB: {} as unknown as D1Database },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pendingApply: 7 })
    spy.mockRestore()
  })

  it('400s when DB binding is missing', async () => {
    const app = createApp()
    const res = await app.request(
      '/admin/orders/repair-status',
      { headers: { ...authHeader } },
      baseEnv,
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /admin/symbols/:symbol/clear-cooldown', () => {
  function fakeCooldownNamespace(captured: { calls: Array<{ symbol: string; untilIso: string }> }) {
    const stub = {
      async setCooldown(symbol: string, untilIso: string) {
        captured.calls.push({ symbol, untilIso })
        return {
          symbol,
          position: null,
          pendingOrder: null,
          lastSignalAt: null,
          cooldownUntil: untilIso,
          settledCash: 0,
          pendingSettlement: [],
          lastExecutedPrice: null,
          lastQuote: null,
          updatedAt: '2026-04-25T00:00:00.000Z',
        }
      },
    }
    return {
      idFromName: () => 'id',
      get: () => stub,
    } as unknown
  }

  it('401s without Basic Auth', async () => {
    const app = createApp()
    const res = await app.request('/admin/symbols/SOXL/clear-cooldown', { method: 'POST' }, baseEnv)
    expect(res.status).toBe(401)
  })

  it('200s and sets cooldown to epoch 0 (effectively cleared)', async () => {
    const captured = { calls: [] as Array<{ symbol: string; untilIso: string }> }
    const app = createApp()
    const res = await app.request(
      '/admin/symbols/soxl/clear-cooldown',
      { method: 'POST', headers: { ...authHeader } },
      { ...baseEnv, SYMBOL_STATE: fakeCooldownNamespace(captured) },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { symbol: string; cooldownUntil: string }
    expect(body.symbol).toBe('SOXL')
    expect(body.cooldownUntil).toBe('1970-01-01T00:00:00.000Z')
    expect(captured.calls).toEqual([{ symbol: 'SOXL', untilIso: '1970-01-01T00:00:00.000Z' }])
  })
})

describe('Earnings calendar admin endpoints (#196)', () => {
  type EarningsRow = {
    id: number
    symbol: string
    earningsDate: string
    notes: string | null
    createdAt: string
  }
  function fakeRepo() {
    return {
      bulkUpsert: vi.fn<(records: unknown) => Promise<{ inserted: number; skipped: number }>>(
        async () => ({ inserted: 0, skipped: 0 }),
      ),
      fetchBySymbol: vi.fn<(symbol: string) => Promise<EarningsRow[]>>(async () => []),
      fetchByRange: vi.fn<(symbol: string, from: string, to: string) => Promise<EarningsRow[]>>(
        async () => [],
      ),
      deleteById: vi.fn<(id: number) => Promise<boolean>>(async () => false),
    }
  }

  async function withFakeRepo<T>(repo: ReturnType<typeof fakeRepo>, fn: () => Promise<T>): Promise<T> {
    const mod = await import('../../src/infrastructure/calendar/earningsCalendarRepo')
    const spy = vi.spyOn(mod, 'createEarningsCalendarRepo').mockReturnValue(repo as never)
    try {
      return await fn()
    } finally {
      spy.mockRestore()
    }
  }

  describe('POST /admin/earnings/seed', () => {
    it('401s without Basic Auth', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings/seed',
        {
          method: 'POST',
          body: JSON.stringify([{ symbol: 'AAPL', earnings_date: '2026-04-30' }]),
        },
        { ...baseEnv, DB: {} as unknown as D1Database },
      )
      expect(res.status).toBe(401)
    })

    it('400s when DB binding is missing', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify([{ symbol: 'AAPL', earnings_date: '2026-04-30' }]),
        },
        baseEnv,
      )
      expect(res.status).toBe(400)
    })

    it('400s when body is not an array', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({ symbol: 'AAPL' }),
        },
        { ...baseEnv, DB: {} as unknown as D1Database },
      )
      expect(res.status).toBe(400)
    })

    it('400s on invalid earnings_date format', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify([{ symbol: 'AAPL', earnings_date: '04/30/2026' }]),
        },
        { ...baseEnv, DB: {} as unknown as D1Database },
      )
      expect(res.status).toBe(400)
    })

    it.each(['2026-02-30', '2026-13-01', '2026-00-15', '2026-04-31', '2025-02-29'])(
      'rejects calendar-impossible date %s (round-trip validation)',
      async (badDate) => {
        // CodeRabbit #196 review: 単純な regex + Date.parse() では
        // `2026-02-30` が `2026-03-02` に normalize されて DB に保存される。
        // round-trip で実在日付のみ通すよう validator が直っていることを確認。
        const app = createApp()
        const res = await app.request(
          '/admin/earnings/seed',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify([{ symbol: 'AAPL', earnings_date: badDate }]),
          },
          { ...baseEnv, DB: {} as unknown as D1Database },
        )
        expect(res.status).toBe(400)
      },
    )

    it('400s on empty body array', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify([]),
        },
        { ...baseEnv, DB: {} as unknown as D1Database },
      )
      expect(res.status).toBe(400)
    })

    it('200s and forwards entries (uppercased) to bulkUpsert', async () => {
      const repo = fakeRepo()
      repo.bulkUpsert.mockResolvedValueOnce({ inserted: 2, skipped: 0 })
      const res = await withFakeRepo(repo, async () => {
        const app = createApp()
        return app.request(
          '/admin/earnings/seed',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify([
              { symbol: 'aapl', earnings_date: '2026-04-30', notes: 'Q2' },
              { symbol: 'MSFT', earnings_date: '2026-04-29' },
            ]),
          },
          { ...baseEnv, DB: {} as unknown as D1Database },
        )
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { inserted: number; skipped: number; total: number }
      expect(body).toEqual({ inserted: 2, skipped: 0, total: 2 })
      expect(repo.bulkUpsert).toHaveBeenCalledWith([
        { symbol: 'AAPL', earningsDate: '2026-04-30', notes: 'Q2' },
        { symbol: 'MSFT', earningsDate: '2026-04-29', notes: null },
      ])
    })
  })

  describe('GET /admin/earnings', () => {
    it('400s when symbol query param missing', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings',
        { headers: { ...authHeader } },
        { ...baseEnv, DB: {} as unknown as D1Database },
      )
      expect(res.status).toBe(400)
    })

    it('200s with rows for the symbol', async () => {
      const repo = fakeRepo()
      repo.fetchBySymbol.mockResolvedValueOnce([
        {
          id: 1,
          symbol: 'AAPL',
          earningsDate: '2026-04-30',
          notes: null,
          createdAt: '2026-04-21T00:00:00.000Z',
        },
      ])
      const res = await withFakeRepo(repo, async () => {
        const app = createApp()
        return app.request(
          '/admin/earnings?symbol=aapl',
          { headers: { ...authHeader } },
          { ...baseEnv, DB: {} as unknown as D1Database },
        )
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { symbol: string; rows: Array<{ symbol: string }> }
      expect(body.symbol).toBe('AAPL')
      expect(body.rows).toHaveLength(1)
      expect(repo.fetchBySymbol).toHaveBeenCalledWith('AAPL')
    })
  })

  describe('DELETE /admin/earnings/:id', () => {
    it('400s on non-numeric id', async () => {
      const app = createApp()
      const res = await app.request(
        '/admin/earnings/abc',
        { method: 'DELETE', headers: { ...authHeader } },
        { ...baseEnv, DB: {} as unknown as D1Database },
      )
      expect(res.status).toBe(400)
    })

    it('404 when row does not exist', async () => {
      const repo = fakeRepo()
      repo.deleteById.mockResolvedValueOnce(false)
      const res = await withFakeRepo(repo, async () => {
        const app = createApp()
        return app.request(
          '/admin/earnings/42',
          { method: 'DELETE', headers: { ...authHeader } },
          { ...baseEnv, DB: {} as unknown as D1Database },
        )
      })
      expect(res.status).toBe(404)
    })

    it('200 and forwards id when deletion succeeds', async () => {
      const repo = fakeRepo()
      repo.deleteById.mockResolvedValueOnce(true)
      const res = await withFakeRepo(repo, async () => {
        const app = createApp()
        return app.request(
          '/admin/earnings/9',
          { method: 'DELETE', headers: { ...authHeader } },
          { ...baseEnv, DB: {} as unknown as D1Database },
        )
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ deleted: true, id: 9 })
      expect(repo.deleteById).toHaveBeenCalledWith(9)
    })
  })
})
