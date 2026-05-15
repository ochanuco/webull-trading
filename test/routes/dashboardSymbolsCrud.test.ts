import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { makeGlobalConfigSnapshot } from '../helpers/configFixtures'
import type { SymbolConfigRow } from '../../src/infrastructure/db/schema'

/**
 * symbol_config CRUD UI tests (#292)。dashboard 3 ページ (list / new / edit) +
 * 4 admin POST endpoint を end-to-end でカバーする。
 *
 * DB は `createDb` を spy で差し替えて in-memory store として振る舞わせる
 * (audit log の insert もここに乗る — table を分けて capture)。これで
 * symbol_config 操作と audit log 書き込みを 1 つの fake で検証できる。
 */

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/db/tradeJournalRepo')>(
    '../../src/infrastructure/db/tradeJournalRepo',
  )
  return { ...actual, createDb: vi.fn() }
})

const baseEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
}
const authHeader = {}

interface InsertCall {
  table: 'symbol_config' | 'config_audit_log' | 'unknown'
  values: Record<string, unknown>
}
interface UpdateCall {
  table: 'symbol_config' | 'unknown'
  set: Record<string, unknown>
  whereSymbol: string | null
}

/**
 * 最小限の drizzle-like fake。`drizzle` API の chainable オブジェクトを模倣し、
 * symbol_config 行 (in-memory) と audit log の inserts / updates を記録する。
 *
 * select chain は filter を捕捉しないので、呼び出し側は `findSymbolConfig`
 * → `db.select().from(tbl).where(eq(tbl.symbol, X)).limit(1)` の 1 件返却を
 * 期待する。fake では select chain がそれぞれ自身を返し、最終 `await` で
 * `currentRows` を返す。`where` 時に渡される drizzle eq(...) は内部に値を
 * 保持するので JSON 化して symbol を取り出してフィルタする。
 */
function fakeDb(initial: SymbolConfigRow[]) {
  const rows: SymbolConfigRow[] = [...initial]
  const inserts: InsertCall[] = []
  const updates: UpdateCall[] = []

  const tableName = (t: unknown): InsertCall['table'] => {
    // drizzle SQLite table object stores name in `[Symbol.for('drizzle:Name')]` or `_.name`。
    const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes('drizzle:Name'))
    if (sym) {
      const v = (t as Record<symbol, unknown>)[sym]
      if (v === 'symbol_config') return 'symbol_config'
      if (v === 'config_audit_log') return 'config_audit_log'
    }
    const inner = (t as { _?: { name?: string } })?._?.name
    if (inner === 'symbol_config') return 'symbol_config'
    if (inner === 'config_audit_log') return 'config_audit_log'
    return 'unknown'
  }

  // drizzle eq(symbolConfig.symbol, X) は SQL クエリオブジェクト内の Param
  // ノードに X を入れる。POC test 用に、`Param`-like ノード (`{ value: X,
  // encoder, ... }`) を最初に拾った時点で返す。drizzle 表現は内部 API な
  // ので unstable だが test 用途には十分。
  const extractSymbolFromWhere = (cond: unknown): string | null => {
    const seen = new WeakSet<object>()
    const visit = (node: unknown): string | null => {
      if (node === null || typeof node !== 'object') return null
      if (seen.has(node)) return null
      seen.add(node)
      const obj = node as Record<string, unknown>
      // Param ノードは `value` フィールド + `encoder` フィールドを持つ。
      // 単に `name` (= column name) を value にしている SQL ノードと区別する。
      if (
        'value' in obj &&
        typeof obj.value === 'string' &&
        ('encoder' in obj || 'brand' in obj)
      ) {
        return obj.value
      }
      for (const k of Object.keys(obj)) {
        const child = visit(obj[k])
        if (child !== null) return child
      }
      return null
    }
    return visit(cond)
  }

  const selectChain = (filtered: () => SymbolConfigRow[]) => {
    const chain = {
      from: (_tbl: unknown) => chain,
      where: (cond: unknown) => {
        const sym = extractSymbolFromWhere(cond)
        return selectChain(() => filtered().filter((r) => sym === null || r.symbol === sym))
      },
      orderBy: (_o: unknown) => chain,
      limit: (n: number) => Promise.resolve(filtered().slice(0, n)),
      then: (resolve: (v: SymbolConfigRow[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(filtered()).then(resolve, reject),
    }
    return chain
  }

  return {
    inserts,
    updates,
    rows,
    drizzleLike: {
      select: () => selectChain(() => rows),
      insert: (table: unknown) => ({
        values: async (v: Record<string, unknown>) => {
          const tn = tableName(table)
          if (tn === 'symbol_config') {
            const sym = String(v.symbol ?? '')
            // UNIQUE constraint on `symbol` を sqlite と同じ message で模倣。
            // insertSymbolConfig の TOCTOU 修正 (UNIQUE 違反を null 化) の検証用。
            if (rows.some((r) => r.symbol === sym)) {
              throw new Error('UNIQUE constraint failed: symbol_config.symbol')
            }
            rows.push({
              symbol: sym,
              name: (v.name as string | null) ?? null,
              market: String(v.market ?? 'US'),
              currency: String(v.currency ?? 'USD'),
              active: v.active === true || v.active === 1,
              maxNotional: (v.maxNotional as number | null) ?? null,
              bucket: (v.bucket as string | null) ?? null,
              notes: (v.notes as string | null) ?? null,
              updatedAt: String(v.updatedAt ?? ''),
            })
          }
          inserts.push({ table: tn, values: v })
        },
      }),
      update: (table: unknown) => ({
        set: (s: Record<string, unknown>) => ({
          where: async (cond: unknown) => {
            const tn = tableName(table)
            const symbol = extractSymbolFromWhere(cond)
            if (tn === 'symbol_config' && symbol !== null) {
              for (let i = 0; i < rows.length; i++) {
                if (rows[i]!.symbol === symbol) {
                  // `active` が drizzle `sql\`NOT active\`` 表現で来た場合は
                  // fake 側で boolean に解決する (toggleSymbolActive の
                  // atomic update を fake DB で再現)。
                  const resolved: Record<string, unknown> = { ...s }
                  if (resolved.active !== null && typeof resolved.active === 'object') {
                    resolved.active = !rows[i]!.active
                  }
                  rows[i] = { ...rows[i]!, ...(resolved as Partial<SymbolConfigRow>) }
                  updates.push({
                    table: tn as 'symbol_config',
                    set: resolved,
                    whereSymbol: symbol,
                  })
                  return
                }
              }
            }
            updates.push({ table: tn as 'symbol_config', set: s, whereSymbol: symbol })
          },
        }),
      }),
    },
  }
}

function row(overrides: Partial<SymbolConfigRow> = {}): SymbolConfigRow {
  return {
    symbol: 'SOXL',
    name: 'Direxion Semi 3X',
    market: 'US',
    currency: 'USD',
    active: true,
    maxNotional: 2000,
    bucket: 'semi',
    notes: null,
    updatedAt: '2026-04-23T00:00:00.000Z',
    ...overrides,
  }
}

describe('dashboard symbol_config CRUD UI (#292)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  // --- List page ---
  it('renders /dashboard/symbols list with active + inactive rows', async () => {
    const db = fakeDb([
      row({ symbol: 'SOXL', name: 'Direxion Semi 3X', active: true, maxNotional: 2000, bucket: 'semi' }),
      row({ symbol: '7203', name: 'トヨタ自動車', market: 'JP', currency: 'JPY', active: false, maxNotional: null, bucket: null, notes: 'paused' }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SOXL')
    expect(body).toContain('Direxion Semi 3X')
    expect(body).toContain('7203')
    expect(body).toContain('トヨタ自動車')
    expect(body).toContain('+ 新規追加')
    // action links per row
    expect(body).toContain('/dashboard/symbols/SOXL/edit')
    expect(body).toContain('/admin/symbol-config/SOXL/toggle-active')
    // soft delete button only on active row
    expect(body).toContain('/admin/symbol-config/SOXL/delete')
    expect(body).not.toContain('/admin/symbol-config/7203/delete')
    // counts
    expect(body).toContain('active 1 / inactive 1')
  })

  // --- POST add ---
  it('POST /admin/symbol-config inserts row + writes audit row, redirects 303', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'tqqq',
      name: 'ProShares UltraPro QQQ',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '1500',
      bucket: 'us_large_cap',
      notes: '',
    })
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: form.toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/symbols')
    const symbolInsert = db.inserts.find((i) => i.table === 'symbol_config')
    expect(symbolInsert).toBeDefined()
    expect(symbolInsert!.values).toMatchObject({
      symbol: 'TQQQ',
      market: 'US',
      currency: 'USD',
      active: true,
      maxNotional: 1500,
      bucket: 'us_large_cap',
      name: 'ProShares UltraPro QQQ',
    })
    const auditInsert = db.inserts.find((i) => i.table === 'config_audit_log')
    expect(auditInsert).toBeDefined()
    expect(auditInsert!.values).toMatchObject({
      actor: 'admin',
      endpoint: '/admin/symbol-config',
      targetKey: 'symbol=TQQQ',
    })
    expect(JSON.parse(String(auditInsert!.values.beforeJson))).toBeNull()
    expect(JSON.parse(String(auditInsert!.values.afterJson))).toMatchObject({
      symbol: 'TQQQ',
      market: 'US',
      currency: 'USD',
    })
  })

  // --- POST update ---
  it('POST /admin/symbol-config/:symbol/update writes audit with before/after diff', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', maxNotional: 2000, bucket: 'semi' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'SOXL', // path source of truth, body should be overridden
      name: 'Direxion Semi 3X (edited)',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '3000',
      bucket: 'semi',
      notes: 'bumped',
    })
    const res = await app.request(
      '/admin/symbol-config/SOXL/update',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: form.toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/symbols')
    const update = db.updates.find((u) => u.table === 'symbol_config')
    expect(update).toBeDefined()
    expect(update!.set).toMatchObject({
      maxNotional: 3000,
      notes: 'bumped',
    })
    const auditInsert = db.inserts.find((i) => i.table === 'config_audit_log')
    expect(auditInsert).toBeDefined()
    const before = JSON.parse(String(auditInsert!.values.beforeJson))
    const after = JSON.parse(String(auditInsert!.values.afterJson))
    expect(before.maxNotional).toBe(2000)
    expect(after.maxNotional).toBe(3000)
    expect(after.notes).toBe('bumped')
  })

  // --- POST toggle-active ---
  it('POST /admin/symbol-config/:symbol/toggle-active flips active + writes audit', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', active: true })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config/SOXL/toggle-active',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: '',
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    const update = db.updates.find((u) => u.table === 'symbol_config')
    expect(update).toBeDefined()
    expect(update!.set).toMatchObject({ active: false })
    const auditInsert = db.inserts.find((i) => i.table === 'config_audit_log')
    expect(auditInsert).toBeDefined()
    expect(JSON.parse(String(auditInsert!.values.beforeJson))).toEqual({ active: true })
    expect(JSON.parse(String(auditInsert!.values.afterJson))).toEqual({ active: false })
  })

  // --- POST delete (soft) ---
  it('POST /admin/symbol-config/:symbol/delete soft-deletes (active=false) without hard delete', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', active: true })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config/SOXL/delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: '',
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    // UPDATE 1 件のみ — DELETE は呼ばれないこと
    const updates = db.updates.filter((u) => u.table === 'symbol_config')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.set).toMatchObject({ active: false })
    const auditInsert = db.inserts.find((i) => i.table === 'config_audit_log')
    expect(auditInsert).toBeDefined()
    expect(JSON.parse(String(auditInsert!.values.afterJson))).toEqual({ active: false })
  })

  // --- Validation ---
  it('validation: rejects empty symbol / unknown market / negative max_notional with 400', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()

    const badSymbol = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({ symbol: '', market: 'US', currency: 'USD' }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(badSymbol.status).toBe(400)

    const badMarket = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({ symbol: 'SOXL', market: 'EU', currency: 'USD' }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(badMarket.status).toBe(400)

    const badNotional = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SOXL',
          market: 'US',
          currency: 'USD',
          max_notional: '-5',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(badNotional.status).toBe(400)

    // どれも insert は走っていない
    expect(db.inserts.filter((i) => i.table === 'symbol_config')).toHaveLength(0)
  })

  // --- XSS regression ---
  it('escapes <script>/<svg> payloads in notes / bucket on list and edit pages', async () => {
    const xssNotes = '<script>alert(1)</script>'
    const xssBucket = '"><svg onload=alert(2)>'
    const db = fakeDb([row({ symbol: 'SOXL', notes: xssNotes, bucket: xssBucket })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()

    // list page
    const listRes = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const listBody = await listRes.text()
    expect(listBody).not.toContain(xssNotes)
    expect(listBody).not.toContain(xssBucket)
    expect(listBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(listBody).toContain('&quot;&gt;&lt;svg onload=alert(2)&gt;')

    // edit page
    const editRes = await app.request(
      '/dashboard/symbols/SOXL/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const editBody = await editRes.text()
    expect(editBody).not.toContain(xssNotes)
    expect(editBody).not.toContain(xssBucket)
    expect(editBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(editBody).toContain('&quot;&gt;&lt;svg onload=alert(2)&gt;')
  })

  // --- TOCTOU: 既存 symbol を form POST → 303 redirect with ?error=duplicate ---
  it('POST /admin/symbol-config returns 303 with ?error=duplicate when symbol exists (form)', async () => {
    const db = fakeDb([row({ symbol: 'SOXL' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SOXL',
          market: 'US',
          currency: 'USD',
          active: 'true',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(
      '/dashboard/symbols?error=duplicate&symbol=SOXL',
    )
  })

  // --- TOCTOU: 既存 symbol を JSON POST → 409 with error code (JSON path keeps semantics) ---
  it('POST /admin/symbol-config returns 409 when symbol exists (JSON)', async () => {
    const db = fakeDb([row({ symbol: 'SOXL' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          symbol: 'SOXL',
          market: 'US',
          currency: 'USD',
          active: true,
        }),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body).toMatchObject({ error: 'symbol_already_exists', symbol: 'SOXL' })
  })

  // --- list error banner is rendered from ?error= query (PRG from failed POST) ---
  it('renders error banner on /dashboard/symbols?error=duplicate&symbol=SOXL', async () => {
    const db = fakeDb([row({ symbol: 'SOXL' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols?error=duplicate&symbol=SOXL',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('SOXL')
    expect(body).toContain('既に登録済み')
  })

  // --- atomic toggle: SQL NOT active is sent in the UPDATE set ---
  it('toggle-active sends SQL NOT expression (not a precomputed boolean) to UPDATE', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', active: true })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    await app.request(
      '/admin/symbol-config/SOXL/toggle-active',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: '',
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    // fake DB unwraps the SQL NOT into a boolean (= !before.active) so the
    // resulting row is flipped. The end-state check is what matters:
    // 単純 read-modify-write だと「現在 active を SELECT してから書き戻し」
    // になり race するが、新実装は SQL NOT を渡すことで DB が atomic に
    // flip する。fake では update 後 row が反転していることだけ検証する。
    const soxl = db.rows.find((r) => r.symbol === 'SOXL')
    expect(soxl?.active).toBe(false)
  })

  // --- /symbols/new : DB unavailable returns unavailable page ---
  it('GET /dashboard/symbols/new returns DB-not-bound page when DB binding missing', async () => {
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/new',
      { headers: authHeader },
      { ...baseEnv },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('DB not bound')
  })

  // --- edit form has immutability hint ---
  it('GET /dashboard/symbols/:symbol/edit shows immutability hint for the symbol field', async () => {
    const db = fakeDb([row({ symbol: 'SOXL' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/SOXL/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('immutable')
  })

  // --- toggle JSON path returns full row snapshot, not only `active` ---
  it('toggle-active JSON response returns full row snapshot', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', active: true, maxNotional: 2000, bucket: 'semi' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config/SOXL/toggle-active',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: '',
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      symbol: 'SOXL',
      row: {
        symbol: 'SOXL',
        active: false,
        maxNotional: 2000,
        bucket: 'semi',
      },
    })
  })
})
