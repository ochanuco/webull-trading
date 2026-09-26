import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { recordChange } from '../../src/infrastructure/db/configAuditLog'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/configAuditLog', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/configAuditLog')>(
    '../../src/infrastructure/db/configAuditLog',
  )
  return {
    ...actual,
    recordChange: vi.fn(async () => ({ recorded: true })),
  }
})

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}
const authHeader = {}

type EarningsRow = {
  id: number
  symbol: string
  earningsDate: string
  notes: string | null
  createdAt: string
}
type MacroRow = {
  id: number
  eventType: string
  eventDate: string
  eventTime: string | null
  notes: string | null
  createdAt: string
}

// select().from().where().orderBy() chain + thenable の両方を満たす最小 mock。
// earnings list query (loadEarningsInRange) と delete handler の
// .then((rows) => rows[0] ?? null) の両方をカバーする。
function fakeListDb(earningsRows: EarningsRow[]) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => earningsRows),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(earningsRows)),
  }
  return {
    select: vi.fn(() => query),
  }
}

function fakeEarningsRepo() {
  return {
    bulkUpsert: vi.fn<(records: unknown) => Promise<{ inserted: number; skipped: number }>>(
      async () => ({ inserted: 1, skipped: 0 }),
    ),
    fetchBySymbol: vi.fn<(symbol: string) => Promise<EarningsRow[]>>(async () => []),
    fetchByRange: vi.fn<(symbol: string, from: string, to: string) => Promise<EarningsRow[]>>(
      async () => [],
    ),
    deleteById: vi.fn<(id: number) => Promise<boolean>>(async () => true),
  }
}
function fakeMacroRepo(rows: MacroRow[] = []) {
  return {
    bulkUpsert: vi.fn<(records: unknown) => Promise<{ inserted: number; skipped: number }>>(
      async () => ({ inserted: 1, skipped: 0 }),
    ),
    fetchAll: vi.fn<(filter: unknown) => Promise<MacroRow[]>>(async () => rows),
    fetchByDateRange: vi.fn<
      (from: string, to: string, type?: string) => Promise<MacroRow[]>
    >(async () => rows),
    deleteById: vi.fn<(id: number) => Promise<boolean>>(async () => true),
  }
}

async function withFakeRepos<T>(
  earningsRepo: ReturnType<typeof fakeEarningsRepo>,
  macroRepo: ReturnType<typeof fakeMacroRepo>,
  fn: () => Promise<T>,
): Promise<T> {
  const eMod = await import('../../src/infrastructure/calendar/earningsCalendarRepo')
  const mMod = await import('../../src/infrastructure/calendar/macroEventCalendarRepo')
  const eSpy = vi
    .spyOn(eMod, 'createEarningsCalendarRepo')
    .mockReturnValue(earningsRepo as never)
  const mSpy = vi
    .spyOn(mMod, 'createMacroEventCalendarRepo')
    .mockReturnValue(macroRepo as never)
  try {
    return await fn()
  } finally {
    eSpy.mockRestore()
    mSpy.mockRestore()
  }
}

describe('dashboard events UI (#293)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['AAPL'], symbolCurrency: { AAPL: 'USD' } }),
    )
  })
  afterEach(() => vi.resetAllMocks())

  it('renders list page with earnings + macro rows from repos', async () => {
    const now = new Date()
    const inTen = new Date(now.getTime() + 10 * 86_400_000).toISOString().slice(0, 10)
    const earningsRow: EarningsRow = {
      id: 1,
      symbol: 'AAPL',
      earningsDate: inTen,
      notes: 'Q2 2026',
      createdAt: '2026-04-21T00:00:00.000Z',
    }
    const macroRow: MacroRow = {
      id: 7,
      eventType: 'FOMC',
      eventDate: inTen,
      eventTime: '14:00',
      notes: 'US — June meeting',
      createdAt: '2026-04-21T00:00:00.000Z',
    }
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([earningsRow]) as unknown as ReturnType<typeof createDb>,
    )
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo([macroRow])
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      return app.request(
        '/dashboard/events',
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('決算 (earnings)')
    expect(body).toContain('マクロイベント (macro)')
    expect(body).toContain('AAPL')
    expect(body).toContain(inTen)
    expect(body).toContain('Q2 2026')
    expect(body).toContain('<code>FOMC</code>')
    expect(body).toContain('US — June meeting')
    expect(body).toContain('action="/dashboard/events/earnings/1/delete"')
    expect(body).toContain('action="/dashboard/events/macro/7/delete"')
    expect(body).toContain('action="/dashboard/events/earnings/seed"')
    expect(body).toContain('action="/dashboard/events/macro/seed"')
  })

  it('POST add earnings → 303 redirect + bulkUpsert called', async () => {
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo()
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', 'aapl')
      form.set('earnings_date', tomorrow)
      form.set('notes', 'Q2 2026')
      return app.request(
        '/dashboard/events/earnings/seed',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...authHeader,
          },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/events')
    expect(earningsRepo.bulkUpsert).toHaveBeenCalledWith([
      { symbol: 'AAPL', earningsDate: tomorrow, notes: 'Q2 2026' },
    ])
    // 1 件 inserted なので recordChange が呼ばれる (endpoint 一致まで確認)。
    expect(vi.mocked(recordChange)).toHaveBeenCalled()
    expect(vi.mocked(recordChange).mock.calls[0]?.[1]?.endpoint).toBe(
      '/dashboard/events/earnings/seed',
    )
  })

  it('POST add macro → 303 redirect + bulkUpsert called with country folded into notes', async () => {
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo()
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('event_type', 'fomc')
      form.set('country', 'US')
      form.set('event_date', tomorrow)
      form.set('notes', 'June meeting')
      return app.request(
        '/dashboard/events/macro/seed',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...authHeader,
          },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/events')
    expect(macroRepo.bulkUpsert).toHaveBeenCalledWith([
      {
        eventType: 'FOMC',
        eventDate: tomorrow,
        eventTime: null,
        notes: 'US — June meeting',
      },
    ])
    expect(vi.mocked(recordChange)).toHaveBeenCalled()
    expect(vi.mocked(recordChange).mock.calls[0]?.[1]?.endpoint).toBe(
      '/dashboard/events/macro/seed',
    )
  })

  it('POST delete earnings → 303 redirect + repo.deleteById called', async () => {
    const earningsRepo = fakeEarningsRepo()
    earningsRepo.deleteById.mockResolvedValueOnce(true)
    const macroRepo = fakeMacroRepo()
    // createDb は delete handler の "before snapshot" 取得で呼ばれる (中身は問わない)。
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([]) as unknown as ReturnType<typeof createDb>,
    )
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      return app.request(
        '/dashboard/events/earnings/42/delete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/events')
    expect(earningsRepo.deleteById).toHaveBeenCalledWith(42)
    expect(vi.mocked(recordChange)).toHaveBeenCalled()
    expect(vi.mocked(recordChange).mock.calls[0]?.[1]?.endpoint).toBe(
      '/dashboard/events/earnings/:id/delete',
    )
  })

  it('POST delete macro → 303 redirect + repo.deleteById called', async () => {
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo()
    macroRepo.deleteById.mockResolvedValueOnce(true)
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([]) as unknown as ReturnType<typeof createDb>,
    )
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      return app.request(
        '/dashboard/events/macro/9/delete',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/events')
    expect(macroRepo.deleteById).toHaveBeenCalledWith(9)
    expect(vi.mocked(recordChange)).toHaveBeenCalled()
    expect(vi.mocked(recordChange).mock.calls[0]?.[1]?.endpoint).toBe(
      '/dashboard/events/macro/:id/delete',
    )
  })

  it('validation: empty symbol / out-of-range date → 400 re-render with error message', async () => {
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo()
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([]) as unknown as ReturnType<typeof createDb>,
    )
    // 日付は SUT ではないので `now ± clamp` から外れない "today" を使う
    // (固定日付だと数か月後に out-of-range で fail する)。
    const today = new Date().toISOString().slice(0, 10)
    const res1 = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', '')
      form.set('earnings_date', today)
      return app.request(
        '/dashboard/events/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res1.status).toBe(400)
    const body1 = await res1.text()
    expect(body1).toContain('class="err"')
    expect(body1).toContain('symbol は 1〜16 文字')
    expect(earningsRepo.bulkUpsert).not.toHaveBeenCalled()

    // future-too-far date (now + 400 days) → 400
    const farFuture = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10)
    const res2 = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', 'AAPL')
      form.set('earnings_date', farFuture)
      return app.request(
        '/dashboard/events/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res2.status).toBe(400)
    const body2 = await res2.text()
    expect(body2).toContain('過去 90 日 〜 未来 365 日')
    expect(earningsRepo.bulkUpsert).not.toHaveBeenCalled()
  })

  it('clamp upper bound is inclusive at +365d but rejects +366d', async () => {
    const macroRepo = fakeMacroRepo()
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([]) as unknown as ReturnType<typeof createDb>,
    )
    const earningsRepo365 = fakeEarningsRepo()
    const day365 = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10)
    const okRes = await withFakeRepos(earningsRepo365, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', 'AAPL')
      form.set('earnings_date', day365)
      return app.request(
        '/dashboard/events/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(okRes.status).toBe(303)
    expect(earningsRepo365.bulkUpsert).toHaveBeenCalled()

    const earningsRepo366 = fakeEarningsRepo()
    const day366 = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10)
    const badRes = await withFakeRepos(earningsRepo366, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', 'AAPL')
      form.set('earnings_date', day366)
      return app.request(
        '/dashboard/events/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(badRes.status).toBe(400)
    const body = await badRes.text()
    expect(body).toContain('過去 90 日 〜 未来 365 日')
    expect(earningsRepo366.bulkUpsert).not.toHaveBeenCalled()
  })

  it('seed earnings with symbol outside universe → save succeeds + warning rendered', async () => {
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo()
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([]) as unknown as ReturnType<typeof createDb>,
    )
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', 'MSFT') // universe は ['AAPL'] のみ
      form.set('earnings_date', tomorrow)
      return app.request(
        '/dashboard/events/earnings/seed',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
          body: form.toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(earningsRepo.bulkUpsert).toHaveBeenCalledWith([
      { symbol: 'MSFT', earningsDate: tomorrow, notes: null },
    ])
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('class="warn"')
    expect(body).toContain('MSFT')
    expect(body).toContain('symbol_config')
  })

  it('XSS regression: notes / event_kind with <script> payload is escaped on render', async () => {
    const scriptPayload = '<script>alert(1)</script>'
    const today = new Date().toISOString().slice(0, 10)
    const earningsRow: EarningsRow = {
      id: 11,
      symbol: 'AAPL',
      earningsDate: today,
      notes: scriptPayload,
      createdAt: '2026-04-21T00:00:00.000Z',
    }
    const macroRow: MacroRow = {
      id: 22,
      // event_type は schema regex で [A-Z0-9_] のみなので、XSS は notes 側で見る。
      eventType: 'FOMC',
      eventDate: today,
      eventTime: null,
      notes: scriptPayload,
      createdAt: '2026-04-21T00:00:00.000Z',
    }
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([earningsRow]) as unknown as ReturnType<typeof createDb>,
    )
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo([macroRow])
    const res = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      return app.request(
        '/dashboard/events',
        { headers: authHeader },
        { ...baseEnv, DB: {} as D1Database },
      )
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(scriptPayload)
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
