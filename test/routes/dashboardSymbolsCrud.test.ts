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
  table: 'symbol_config' | 'config_audit_log' | 'inverse_pairs' | 'unknown'
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
  const deletes: { table: string; whereSymbol: string | null }[] = []

  const tableName = (t: unknown): InsertCall['table'] => {
    // drizzle SQLite table object stores name in `[Symbol.for('drizzle:Name')]` or `_.name`。
    const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes('drizzle:Name'))
    if (sym) {
      const v = (t as Record<symbol, unknown>)[sym]
      if (v === 'symbol_config') return 'symbol_config'
      if (v === 'config_audit_log') return 'config_audit_log'
      if (v === 'inverse_pairs') return 'inverse_pairs'
    }
    const inner = (t as { _?: { name?: string } })?._?.name
    if (inner === 'symbol_config') return 'symbol_config'
    if (inner === 'config_audit_log') return 'config_audit_log'
    if (inner === 'inverse_pairs') return 'inverse_pairs'
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
    deletes,
    rows,
    drizzleLike: {
      select: () => selectChain(() => rows),
      delete: (table: unknown) => ({
        where: async (cond: unknown) => {
          const tn = tableName(table)
          const symbol = extractSymbolFromWhere(cond)
          if (tn === 'symbol_config' && symbol !== null) {
            const idx = rows.findIndex((r) => r.symbol === symbol)
            if (idx !== -1) rows.splice(idx, 1)
          }
          deletes.push({ table: tn, whereSymbol: symbol })
        },
      }),
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
              notes: (v.notes as string | null) ?? null,
              timeStopDaysOverride: (v.timeStopDaysOverride as number | null) ?? null,
              kAtrOverride: (v.kAtrOverride as number | null) ?? null,
              budgetAllocPct: (v.budgetAllocPct as number | null) ?? null,
              lotSize: (v.lotSize as number | null) ?? null,
              stopPctOverride: (v.stopPctOverride as number | null) ?? null,
              takeProfitPctOverride: (v.takeProfitPctOverride as number | null) ?? null,
              intradayOnly: v.intradayOnly === true || v.intradayOnly === 1,
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
      // repo の setInversePair / createSymbolPair / deleteInversePairsForSymbol が使う。
      // fake の insert().values() / delete().where() は呼び出し時に即実行され Promise を
      // 返すので、batch は既に走った statement を待つだけで良い (#315)。
      batch: (stmts: Promise<unknown>[]) => Promise.all(stmts),
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
    notes: null,
    timeStopDaysOverride: null,
    kAtrOverride: null,
    budgetAllocPct: null,
    lotSize: 1,
    stopPctOverride: null,
    takeProfitPctOverride: null,
    intradayOnly: false,
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
      row({ symbol: 'SOXL', name: 'Direxion Semi 3X', active: true, maxNotional: 2000 }),
      row({ symbol: '7203', name: 'トヨタ自動車', market: 'JP', currency: 'JPY', active: false, maxNotional: null, notes: 'paused' }),
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
    // hard delete button only on inactive row (active 行は無効化先行を要求)
    expect(body).toContain('/admin/symbol-config/7203/delete')
    expect(body).not.toContain('/admin/symbol-config/SOXL/delete')
    // counts (post-cleanup format)
    expect(body).toContain('有効 1 / 無効 1')
    // #415: 買付余力バッジ (client-side fetch) がページに含まれる
    expect(body).toContain('buying-power-badge')
    expect(body).toContain('/admin/buying-power')
  })

  it('list flags NULL / invalid lot_size as ⚠ 未設定 (matches runtime fail-closed, CodeRabbit #409)', async () => {
    const db = fakeDb([
      row({ symbol: 'AAA', lotSize: null }), // 未設定
      row({ symbol: 'BBB', lotSize: 0 }), // 不正値 (実行系は fail-closed)
      row({ symbol: 'CCC', lotSize: 100 }), // 正常
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    // NULL も 0 も警告。正常な 100 は数値表示。
    expect((body.match(/⚠ 未設定/g) ?? []).length).toBe(2)
    expect(body).toMatch(/100 <span class="muted"[^>]*>株<\/span>/)
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
      lot_size: '1',
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
    const db = fakeDb([row({ symbol: 'SOXL', maxNotional: 2000 })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'SOXL', // path source of truth, body should be overridden
      name: 'Direxion Semi 3X (edited)',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '3000',
      lot_size: '1',
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

  // --- POST delete (hard, inactive only) ---
  it('POST /admin/symbol-config/:symbol/delete hard-deletes inactive row', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', active: false })])
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
    // DELETE 1 件、UPDATE は走らないこと
    const deletes = db.deletes.filter((d) => d.table === 'symbol_config')
    expect(deletes).toHaveLength(1)
    const auditInsert = db.inserts.find((i) => i.table === 'config_audit_log')
    expect(auditInsert).toBeDefined()
    // audit log の after_json は JSON.stringify(null) = 文字列 "null" (削除を意味)
    expect(auditInsert!.values.afterJson).toBe('null')
  })

  it('POST /admin/symbol-config/:symbol/delete on active row → 303 redirect ?error=still_active (no DELETE)', async () => {
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
    expect(res.headers.get('location')).toBe('/dashboard/symbols?error=still_active&symbol=SOXL')
    const deletes = db.deletes.filter((d) => d.table === 'symbol_config')
    expect(deletes).toHaveLength(0)
  })

  // --- lot_size 入力必須 (#symbol-lot-size) ---
  it('validation: rejects missing / empty / non-integer lot_size with 400 (required, no fallback)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()

    const post = (extra: Record<string, string>) =>
      app.request(
        '/admin/symbol-config',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
          body: new URLSearchParams({
            symbol: 'TQQQ',
            market: 'US',
            currency: 'USD',
            active: 'true',
            ...extra,
          }).toString(),
        },
        { ...baseEnv, DB: {} as D1Database },
      )

    // lot_size 欄が無い → 400 (fallback しない)
    expect((await post({})).status).toBe(400)
    // 空文字 → 400
    expect((await post({ lot_size: '' })).status).toBe(400)
    // 0 / 負 / 非整数 → 400
    expect((await post({ lot_size: '0' })).status).toBe(400)
    expect((await post({ lot_size: '-1' })).status).toBe(400)
    expect((await post({ lot_size: '1.5' })).status).toBe(400)

    // どれも insert は走っていない (fail-closed)
    expect(db.inserts.filter((i) => i.table === 'symbol_config')).toHaveLength(0)
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
  it('escapes <script> payloads in notes on list and edit pages', async () => {
    const xssNotes = '<script>alert(1)</script>'
    const db = fakeDb([row({ symbol: 'SOXL', notes: xssNotes })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()

    // list page
    const listRes = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const listBody = await listRes.text()
    expect(listBody).not.toContain(xssNotes)
    expect(listBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')

    // edit page
    const editRes = await app.request(
      '/dashboard/symbols/SOXL/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const editBody = await editRes.text()
    expect(editBody).not.toContain(xssNotes)
    expect(editBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
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
          lot_size: '1',
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
          lot_size: 1,
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
    const db = fakeDb([row({ symbol: 'SOXL', active: true, maxNotional: 2000 })])
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
      },
    })
  })

  // --- Per-symbol strategy override (#316) ---
  it('POST /admin/symbol-config persists timeStopDaysOverride / kAtrOverride from form', async () => {
    // SOXL (3x leveraged ETF) で time_stop=5 / k_atr=3.0 を入れて DB に
    // 書かれることを確認。global default は別途 placeholder で表示するだけ。
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'SOXL',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '2000',
      lot_size: '1',
      time_stop_days_override: '5',
      k_atr_override: '3.0',
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
    const insert = db.inserts.find((i) => i.table === 'symbol_config')
    expect(insert).toBeDefined()
    expect(insert!.values).toMatchObject({
      symbol: 'SOXL',
      timeStopDaysOverride: 5,
      kAtrOverride: 3.0,
    })
  })

  it('POST /admin/symbol-config treats empty override fields as NULL (global fall-through)', async () => {
    // 空文字 → null (= global default を使う) の挙動を保証。3x ETF 以外の
    // 一般銘柄 form ではこちらが既定の path。
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'AAPL',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '1000',
      lot_size: '1',
      time_stop_days_override: '',
      k_atr_override: '',
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
    const insert = db.inserts.find((i) => i.table === 'symbol_config')
    expect(insert).toBeDefined()
    expect(insert!.values.timeStopDaysOverride).toBeNull()
    expect(insert!.values.kAtrOverride).toBeNull()
  })

  it('POST /admin/symbol-config rejects out-of-range overrides with 400', async () => {
    // DB CHECK と二重防御。timeStopDays は 1-365 整数、kAtr は 0.5-5.0 float。
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()

    // timeStop 0 (下限未満)
    const tooLowDays = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SOXL',
          market: 'US',
          currency: 'USD',
          active: 'true',
          time_stop_days_override: '0',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(tooLowDays.status).toBe(400)

    // kAtr 0.1 (下限未満)
    const tooLowAtr = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SOXL',
          market: 'US',
          currency: 'USD',
          active: 'true',
          k_atr_override: '0.1',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(tooLowAtr.status).toBe(400)

    // kAtr 6.0 (上限超え)
    const tooHighAtr = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SOXL',
          market: 'US',
          currency: 'USD',
          active: 'true',
          k_atr_override: '6.0',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(tooHighAtr.status).toBe(400)

    expect(db.inserts.filter((i) => i.table === 'symbol_config')).toHaveLength(0)
  })

  it('POST /admin/symbol-config/:symbol/update persists override values + audit log', async () => {
    // Update path で override 値が DB に書かれて audit before/after が乗ること。
    const db = fakeDb([row({ symbol: 'SOXL', timeStopDaysOverride: null, kAtrOverride: null })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'SOXL',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '2000',
      lot_size: '1',
      time_stop_days_override: '7',
      k_atr_override: '2.5',
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
    const update = db.updates.find((u) => u.table === 'symbol_config')
    expect(update).toBeDefined()
    expect(update!.set).toMatchObject({
      timeStopDaysOverride: 7,
      kAtrOverride: 2.5,
    })
    const auditInsert = db.inserts.find((i) => i.table === 'config_audit_log')
    expect(auditInsert).toBeDefined()
    const before = JSON.parse(String(auditInsert!.values.beforeJson))
    const after = JSON.parse(String(auditInsert!.values.afterJson))
    expect(before.timeStopDaysOverride).toBeNull()
    expect(before.kAtrOverride).toBeNull()
    expect(after.timeStopDaysOverride).toBe(7)
    expect(after.kAtrOverride).toBe(2.5)
  })

  it('GET /dashboard/symbols/:symbol/edit renders override fields with current values + global placeholders', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', timeStopDaysOverride: 5, kAtrOverride: 3.0 })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/SOXL/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    // form input が存在
    expect(body).toContain('name="time_stop_days_override"')
    expect(body).toContain('name="k_atr_override"')
    // 現在値が反映 (value 属性)
    expect(body).toMatch(/name="time_stop_days_override"[^>]*value="5"/)
    expect(body).toMatch(/name="k_atr_override"[^>]*value="3"/)
    // placeholder に global default が表示される (makeGlobalConfigSnapshot の値)
    expect(body).toContain('global default')
  })

  // --- #315 inverse-pair linked registration ---
  it('new form shows inverse_symbol input', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/new',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('name="inverse_symbol"')
    expect(body).toContain('対で登録')
    // 登録モード選択 (単体 / インバース対)
    expect(body).toContain('name="reg_mode"')
    expect(body).toContain('value="single"')
    expect(body).toContain('value="inverse"')
    // inverse 欄は同じ Yahoo autocomplete (searchInverseSuggest)
    expect(body).toContain('window.searchInverseSuggest')
  })

  it('POST with inverse_symbol creates both symbols + inverse_pairs link, 303', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'soxl',
      name: 'Direxion Semi 3X',
      market: 'US',
      currency: 'USD',
      active: 'true',
      max_notional: '500',
      lot_size: '1',
      inverse_symbol: 'soxs',
      // Yahoo pick 由来の counterpart メタ (一覧でインバース側の銘柄名を出す #315)
      inverse_name: 'Direxion Daily Semiconductor Bear 3X Shares',
      inverse_market: 'US',
      inverse_currency: 'USD',
    })
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/symbols')
    // primary + counterpart の symbol_config が両方作られる
    expect(db.rows.map((r) => r.symbol).sort()).toEqual(['SOXL', 'SOXS'])
    // counterpart は Yahoo メタの銘柄名 / market / currency を焼く
    const soxs = db.rows.find((r) => r.symbol === 'SOXS')!
    expect(soxs.name).toBe('Direxion Daily Semiconductor Bear 3X Shares')
    expect(soxs.market).toBe('US')
    expect(soxs.currency).toBe('USD')
    // counterpart は同じ商品種別なので売買単位を primary 継承 (#symbol-lot-size)
    expect(soxs.lotSize).toBe(1)
    // inverse_pairs リンクが書かれる
    expect(db.inserts.some((i) => i.table === 'inverse_pairs')).toBe(true)
  })

  it('POST persists budget_alloc_pct as a fraction (% input ÷ 100)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: '1570',
      market: 'JP',
      currency: 'JPY',
      active: 'true',
      lot_size: '1', // 1570 (日経レバ ETF) は 1口
      budget_alloc_pct: '40', // 40% → 0.4
    })
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    const inserted = db.inserts.find((i) => i.table === 'symbol_config')!
    expect(inserted.values.budgetAllocPct).toBeCloseTo(0.4, 6)
  })

  it('POST persists stop/take-profit override as fractions (% input ÷ 100) (#exit-atr)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'TQQQ',
      market: 'US',
      currency: 'USD',
      active: 'true',
      lot_size: '1',
      stop_pct_override: '-8', // -8% → -0.08
      take_profit_pct_override: '6', // +6% → 0.06
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
    const inserted = db.inserts.find((i) => i.table === 'symbol_config')!
    expect(inserted.values.stopPctOverride).toBeCloseTo(-0.08, 6)
    expect(inserted.values.takeProfitPctOverride).toBeCloseTo(0.06, 6)
  })

  it('rejects a positive stop_pct_override (must be negative) with 400', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'TQQQ',
          market: 'US',
          currency: 'USD',
          active: 'true',
          lot_size: '1',
          stop_pct_override: '8', // 正値は不正 (stop は負)
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(400)
  })

  it('edit form shows 予算配分 (%) field', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', budgetAllocPct: 0.4 })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/SOXL/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('name="budget_alloc_pct"')
    // fraction 0.4 → 表示は 40 (%)
    expect(body).toMatch(/name="budget_alloc_pct"[^>]*value="40"/)
  })

  it('list renders budget-allocation ladder slider + confirm button (tentative until 確定)', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', budgetAllocPct: 0.4 })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    // slider が form="symbol-budget-form" に紐づき、現在値 40 が反映
    expect(body).toContain('name="pct_SOXL"')
    expect(body).toContain('form="symbol-budget-form"')
    expect(body).toMatch(/name="pct_SOXL"[^>]*value="40"/)
    // 確定ボタン (即保存しない)
    expect(body).toContain('確定して保存')
    expect(body).toContain('action="/admin/symbol-config/budget-alloc"')
  })

  it('bulk budget-alloc POST converts % → fraction (÷100), 303', async () => {
    let lastSetPct: number | null | undefined
    // chain mock: from() は await で [] (loadInversePairs)、where().limit() で
    // SOXL 行 (findSymbolConfig)、update().set().where() で set 値を捕捉。
    const chain: Record<string, unknown> = {}
    chain.from = () => chain
    chain.where = () => chain
    chain.limit = async () => [{ symbol: 'SOXL', budgetAllocPct: null }]
    chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve)
    vi.mocked(createDb).mockReturnValue({
      select: () => chain,
      update: () => ({
        set: (vals: { budgetAllocPct: number | null }) => ({
          where: async () => {
            lastSetPct = vals.budgetAllocPct
          },
        }),
      }),
      insert: () => ({ values: async () => undefined }),
    } as never)
    const app = createApp()
    const form = new URLSearchParams({ pct_SOXL: '40' })
    const res = await app.request(
      '/admin/symbol-config/budget-alloc',
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard/symbols')
    expect(lastSetPct).toBeCloseTo(0.4, 6)
  })

  it('new form inputs carry password-manager opt-out (data-1p-ignore)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/new',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    // symbol / inverse 入力に 1Password / LastPass の autofill 抑止属性が付く
    expect((body.match(/data-1p-ignore="true"/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(body).toContain('name="inverse_name"')
  })

  it('POST with inverse_symbol equal to symbol → 303 error (inverse_self)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'soxl',
      market: 'US',
      currency: 'USD',
      active: 'true',
      lot_size: '1',
      inverse_symbol: 'SOXL',
    })
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('error=inverse_self')
    expect(db.rows.length).toBe(0)
  })

  it('delete cascades inverse_pairs link removal', async () => {
    const db = fakeDb([row({ symbol: 'SOXS', active: false })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config/SOXS/delete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(303)
    // symbol_config 削除 + inverse_pairs に対する delete が発行される
    expect(db.deletes.some((d) => d.table === 'symbol_config')).toBe(true)
    expect(db.deletes.some((d) => d.table === 'inverse_pairs')).toBe(true)
  })
})

import { orderRowsByPair, assignPairColors, pairRoles, computeBudgetUsage } from '../../src/routes/dashboard'

describe('#budget-jpy-base-fx computeBudgetUsage (single account % meter)', () => {
  const rec = (symbol: string, budgetAllocPct: number | null) => ({ symbol, budgetAllocPct })

  it('counts an inverse pair once via max (only one side held at a time)', () => {
    // SOXL 40% / SOXS 40% (synced) → pair contributes 40, not 80.
    expect(computeBudgetUsage([rec('SOXL', 0.4), rec('SOXS', 0.4)], { SOXL: 'SOXS', SOXS: 'SOXL' })).toBeCloseTo(40, 6)
  })

  it('uses max when the two sides differ', () => {
    expect(computeBudgetUsage([rec('SOXL', 0.4), rec('SOXS', 0.2)], { SOXL: 'SOXS', SOXS: 'SOXL' })).toBeCloseTo(40, 6)
  })

  it('sums standalone + separate pairs across currencies into one account % (FX-agnostic)', () => {
    // 口座(円)に対する割合なので通貨混在でも 1 本に合算: 40 + 30 + 10 + 50 = 130 (超過)。
    const used = computeBudgetUsage(
      [
        rec('SOXL', 0.4), rec('SOXS', 0.4), // pair → 40
        rec('TQQQ', 0.3), rec('SQQQ', 0.3), // pair → 30
        rec('AAPL', 0.1), // standalone → 10
        rec('1570', 0.5), rec('1357', 0.5), // JP pair → 50
      ],
      { SOXL: 'SOXS', SOXS: 'SOXL', TQQQ: 'SQQQ', SQQQ: 'TQQQ', '1570': '1357', '1357': '1570' },
    )
    expect(used).toBeCloseTo(130, 6)
  })

  it('ignores null / 0 allocations (returns 0)', () => {
    expect(computeBudgetUsage([rec('SOXL', null), rec('AAPL', 0)], {})).toBe(0)
  })
})

describe('#315 inverse-pair list grouping', () => {
  const r = (symbol: string): SymbolConfigRow => row({ symbol, name: symbol })

  it('orderRowsByPair places the counterpart right after its primary', () => {
    const rows = [r('AAPL'), r('SOXL'), r('TQQQ'), r('SOXS'), r('SQQQ')]
    const pairs = { SOXL: 'SOXS', SOXS: 'SOXL', TQQQ: 'SQQQ', SQQQ: 'TQQQ' }
    const ordered = orderRowsByPair(rows, pairs).map((x) => x.symbol)
    // AAPL(対なし) → SOXL+SOXS → TQQQ+SQQQ。primary の直後に相手が来る。
    expect(ordered).toEqual(['AAPL', 'SOXL', 'SOXS', 'TQQQ', 'SQQQ'])
  })

  it('orderRowsByPair leaves unpaired and half-present pairs in place', () => {
    const rows = [r('SOXL'), r('AAPL')] // SOXS は一覧に居ない
    const pairs = { SOXL: 'SOXS', SOXS: 'SOXL' }
    const ordered = orderRowsByPair(rows, pairs).map((x) => x.symbol)
    expect(ordered).toEqual(['SOXL', 'AAPL'])
  })

  it('assignPairColors colors both sides of a present pair with the same color, alternating per pair', () => {
    const rows = [r('SOXL'), r('SOXS'), r('TQQQ'), r('SQQQ'), r('AAPL')]
    const pairs = { SOXL: 'SOXS', SOXS: 'SOXL', TQQQ: 'SQQQ', SQQQ: 'TQQQ' }
    const ordered = orderRowsByPair(rows, pairs)
    const color = assignPairColors(ordered, pairs)
    // 同一ペアは同色、別ペアは別色、対なしは無着色。
    expect(color.get('SOXL')).toBe(color.get('SOXS'))
    expect(color.get('TQQQ')).toBe(color.get('SQQQ'))
    expect(color.get('SOXL')).not.toBe(color.get('TQQQ'))
    expect(color.has('AAPL')).toBe(false)
  })

  it('assignPairColors skips half-present pairs (counterpart not in list)', () => {
    const rows = [r('SOXL')]
    const pairs = { SOXL: 'SOXS', SOXS: 'SOXL' }
    const color = assignPairColors(rows, pairs)
    expect(color.has('SOXL')).toBe(false)
  })

  it('pairRoles marks primary as top (┌) and counterpart as bottom (└), unpaired none', () => {
    const rows = [r('SOXL'), r('SOXS'), r('AAPL')]
    const pairs = { SOXL: 'SOXS', SOXS: 'SOXL' }
    const ordered = orderRowsByPair(rows, pairs)
    const roles = pairRoles(ordered, pairs)
    expect(roles.get('SOXL')).toBe('top')
    expect(roles.get('SOXS')).toBe('bottom')
    expect(roles.has('AAPL')).toBe(false)
  })

  it('pairRoles assigns no role when counterpart is not adjacent (half-present)', () => {
    const rows = [r('SOXL'), r('AAPL')]
    const pairs = { SOXL: 'SOXS', SOXS: 'SOXL' }
    const roles = pairRoles(orderRowsByPair(rows, pairs), pairs)
    expect(roles.has('SOXL')).toBe(false)
  })
})
