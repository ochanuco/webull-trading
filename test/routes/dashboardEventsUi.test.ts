import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { recordChange } from '../../src/infrastructure/db/configAuditLog'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

/**
 * #293 — dashboard イベント管理 UI のテスト。
 *
 * `GET /dashboard/events` で earnings + macro 一覧 + 追加 form を描画、
 * `POST /dashboard/events/earnings/seed` 等の form 受け handler が repo を
 * 呼んで 303 redirect、バリデーション失敗は 400 で再描画 + 入力 echo を保持
 * することを確認する。XSS regression として notes に <script> を入れて escape
 * されることも見る (#284 と同じ姿勢)。
 */

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

/**
 * `createDb(env.DB).select().from().where().orderBy()` chain を満たす最小限の
 * thenable mock。await でき、`Promise<rows[]>` を返す。Dashboard 側の earnings
 * list query (`loadEarningsInRange`) と delete handler の `.then((rows) => rows[0] ?? null)`
 * 両方をカバーする。
 */
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

/** 共通の repo mock (earnings + macro)。 */
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
    // earnings row 列
    expect(body).toContain('AAPL')
    expect(body).toContain(inTen)
    expect(body).toContain('Q2 2026')
    // macro row 列
    expect(body).toContain('<code>FOMC</code>')
    expect(body).toContain('US — June meeting')
    // 削除 form action は /dashboard/events/<kind>/<id>/delete
    expect(body).toContain('action="/dashboard/events/earnings/1/delete"')
    expect(body).toContain('action="/dashboard/events/macro/7/delete"')
    // 「+ 追加」 details が両セクションに存在
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
  })

  it('POST delete earnings → 303 redirect + repo.deleteById called', async () => {
    const earningsRepo = fakeEarningsRepo()
    earningsRepo.deleteById.mockResolvedValueOnce(true)
    const macroRepo = fakeMacroRepo()
    // createDb は delete handler 内の "before snapshot" 取得で呼ばれる ("rows" を返せれば中身は問わない)。
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
  })

  it('validation: empty symbol / out-of-range date → 400 re-render with error message', async () => {
    const earningsRepo = fakeEarningsRepo()
    const macroRepo = fakeMacroRepo()
    vi.mocked(createDb).mockReturnValue(
      fakeListDb([]) as unknown as ReturnType<typeof createDb>,
    )
    // empty symbol → re-render w/ error, repo NOT called
    const res1 = await withFakeRepos(earningsRepo, macroRepo, async () => {
      const app = createApp()
      const form = new URLSearchParams()
      form.set('symbol', '')
      form.set('earnings_date', '2026-05-15')
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

  it('XSS regression: notes / event_kind with <script> payload is escaped on render', async () => {
    // operator が誤って (or 攻撃者が DB 直接書込みで) 入れた <script> が
    // 一覧テーブルで生で出ないこと。escapeHtml 経由で中和されているはず。
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
      eventType: 'FOMC', // event_type は schema regex で `[A-Z0-9_]` のみだが、
      // 万一壊れた row が入っても escape されるかを notes 側で見る。
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
    // 生の <script>alert(1)</script> が body に出てはいけない
    expect(body).not.toContain(scriptPayload)
    // 代わりに escape 済みの形が両 row 由来で 2 回以上含まれる
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
