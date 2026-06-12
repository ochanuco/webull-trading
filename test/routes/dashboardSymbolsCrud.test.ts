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
function fakeDb(
  initial: SymbolConfigRow[],
  pairs: Array<{ symbol: string; inverse: string }> = [],
) {
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
      // inverse_pairs を select したら pair 行を返す (loadInversePairs 用)。
      // それ以外 (symbol_config) は従来通り自身を返して rows を流す。
      from: (tbl: unknown) =>
        tableName(tbl) === 'inverse_pairs'
          ? {
              then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(pairs).then(resolve, reject),
            }
          : chain,
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
              role: (v.role as string | null) ?? null,
              pullbackMaxOverride: (v.pullbackMaxOverride as number | null) ?? null,
              pullbackMinOverride: (v.pullbackMinOverride as number | null) ?? null,
              minReturn50dOverride: (v.minReturn50dOverride as number | null) ?? null,
              maxAtrRatioOverride: (v.maxAtrRatioOverride as number | null) ?? null,
              maxSma50DeviationPctOverride: (v.maxSma50DeviationPctOverride as number | null) ?? null,
              requireAboveSma50Override: (v.requireAboveSma50Override as boolean | null) ?? null,
              entryRequired: v.entryRequired === true || v.entryRequired === 1,
              alwaysActive: v.alwaysActive === true || v.alwaysActive === 1,
              cashFallbackSymbols: (v.cashFallbackSymbols as string | null) ?? null,
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
    role: null,
    pullbackMaxOverride: null,
    pullbackMinOverride: null,
    minReturn50dOverride: null,
    maxAtrRatioOverride: null,
    maxSma50DeviationPctOverride: null,
    requireAboveSma50Override: null,
    entryRequired: false,
    alwaysActive: false,
    cashFallbackSymbols: null,
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

  // 持ち越し設定は radio 2 択で両状態を明示 (「持ち越し」+「持ち越さない」
  // checkbox の二重否定が読めない、という operator 指摘の regression 防止)。
  it('持ち越し setting renders as two explicit radios and reflects intradayOnly', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', intradayOnly: true })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/SOXL/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('持ち越す')
    expect(body).toContain('持ち越さない')
    // intradayOnly=true の行は radio value="true" 側が checked
    expect(body).toMatch(/type="radio" name="intraday_only" value="true" checked/)
    expect(body).not.toMatch(/type="radio" name="intraday_only" value="false" checked/)
    // 旧 hidden+checkbox パターンが残っていない
    expect(body).not.toContain('type="checkbox" name="intraday_only"')
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

  it('inverse pair renders one shared budget slider (rowspan=2), not two', async () => {
    const db = fakeDb(
      [row({ symbol: 'SOXL', budgetAllocPct: 0.35 }), row({ symbol: 'SOXS', budgetAllocPct: 0.35 })],
      [{ symbol: 'SOXL', inverse: 'SOXS' }],
    )
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    // 上段 (SOXL) にだけ slider、下段 (SOXS) の予算セルは rowspan で消える
    expect(body).toContain('name="pct_SOXL"')
    expect(body).not.toContain('name="pct_SOXS"')
    expect(body).toContain('rowspan="2"')
    expect(body).toContain('ペア共通')
  })

  it('shared pair slider initializes to max of both sides when diverged', async () => {
    const db = fakeDb(
      [row({ symbol: 'SOXL', budgetAllocPct: 0.2 }), row({ symbol: 'SOXS', budgetAllocPct: 0.4 })],
      [{ symbol: 'SOXL', inverse: 'SOXS' }],
    )
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const body = await res.text()
    // meter と同じ max 方式 (同時に建つのは片側のみ) — max(20, 40) = 40
    expect(body).toMatch(/name="pct_SOXL"[^>]*value="40"/)
  })

  it('half-present pair (filtered) keeps its own slider without rowspan', async () => {
    const db = fakeDb(
      [row({ symbol: 'SOXL', budgetAllocPct: 0.35 }), row({ symbol: 'SOXS', budgetAllocPct: 0.35 })],
      [{ symbol: 'SOXL', inverse: 'SOXS' }],
    )
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols?q=SOXS',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('name="pct_SOXS"')
    expect(body).not.toContain('name="pct_SOXL"')
    expect(body).not.toContain('rowspan="2"')
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

describe('dashboard symbol_config role / entry override (#452)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('POST persists role and entry overrides (% → fraction)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'QQQ',
      market: 'US',
      currency: 'USD',
      active: 'true',
      lot_size: '1',
      role: 'core_trend',
      pullback_max_override: '-1.5', // -1.5% → -0.015
      pullback_min_override: '-5', // -5% → -0.05
      min_return_50d_override: '3', // +3% → 0.03
      max_atr_ratio_override: '1.8', // ratio 生値
      max_sma50_deviation_pct_override: '20', // +20% → 0.2
      require_above_sma50_override: 'false',
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
    expect(inserted.values.role).toBe('core_trend')
    expect(inserted.values.pullbackMaxOverride).toBeCloseTo(-0.015, 6)
    expect(inserted.values.pullbackMinOverride).toBeCloseTo(-0.05, 6)
    expect(inserted.values.minReturn50dOverride).toBeCloseTo(0.03, 6)
    expect(inserted.values.maxAtrRatioOverride).toBeCloseTo(1.8, 6)
    expect(inserted.values.maxSma50DeviationPctOverride).toBeCloseTo(0.2, 6)
    expect(inserted.values.requireAboveSma50Override).toBe(false)
  })

  it('POST with empty role / overrides persists NULLs (従来挙動)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'SOXL',
      market: 'US',
      currency: 'USD',
      active: 'true',
      lot_size: '1',
      role: '',
      pullback_max_override: '',
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
    expect(inserted.values.role).toBeNull()
    expect(inserted.values.pullbackMaxOverride).toBeNull()
  })

  it('rejects an out-of-enum role with 400 (typo を従来挙動に黙って倒さない)', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SGOV',
          market: 'US',
          currency: 'USD',
          active: 'true',
          lot_size: '1',
          role: 'cash_praking', // typo
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(400)
  })

  it('rejects an inconsistent pullback band (max deeper than min) with 400', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'QQQ',
          market: 'US',
          currency: 'USD',
          active: 'true',
          lot_size: '1',
          pullback_max_override: '-6', // 0 側のはずが深い
          pullback_min_override: '-3',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(400)
  })


  it('edit form shows role select / entry override fields with current values', async () => {
    const db = fakeDb([
      row({
        symbol: 'QQQ',
        role: 'core_trend',
        pullbackMaxOverride: -0.015,
        minReturn50dOverride: 0.03,
        requireAboveSma50Override: false,
      }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/QQQ/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('name="role"')
    // select 廃止 → hidden input に現在の role が入る (#role-stats)
    expect(body).toMatch(/<input type="hidden" name="role" id="symbol-form-role" value="core_trend">/)
    // fraction → % 表示
    expect(body).toMatch(/name="pullback_max_override"[^>]*value="-1\.5"/)
    expect(body).toMatch(/name="min_return_50d_override"[^>]*value="3"/)
    expect(body).toMatch(/name="require_above_sma50_override"/)
  })
})

describe('dashboard symbol_config 条件連動配分 (#452 Layer 3)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('POST persists entry_required / always_active / cash_fallback_symbol', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const form = new URLSearchParams({
      symbol: 'QQQ',
      market: 'US',
      currency: 'USD',
      active: 'true',
      lot_size: '1',
      entry_required: 'true',
      always_active: 'false',
      cash_fallback_symbol: 'sgov', // 小文字も大文字正規化
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
    expect(inserted.values.entryRequired).toBe(true)
    expect(inserted.values.alwaysActive).toBe(false)
    expect(inserted.values.cashFallbackSymbols).toBe('["SGOV"]')
  })

  it('rejects a self-referential cash_fallback_symbol with 400', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/admin/symbol-config',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeader },
        body: new URLSearchParams({
          symbol: 'SGOV',
          market: 'US',
          currency: 'USD',
          active: 'true',
          lot_size: '1',
          cash_fallback_symbol: 'SGOV',
        }).toString(),
      },
      { ...baseEnv, DB: {} as D1Database },
    )
    expect(res.status).toBe(400)
  })

  it('edit form shows 条件連動配分 fields with current values', async () => {
    const db = fakeDb([
      row({ symbol: 'QQQ', entryRequired: true, cashFallbackSymbols: '["SGOV"]' }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/QQQ/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toMatch(/name="entry_required" value="true" checked/)
    expect(body).toMatch(/name="cash_fallback_symbol"[^>]*value="SGOV"/)
  })
})

describe('symbols list ロール列 (#452)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('一覧に role と条件連動配分の要約を表示する', async () => {
    const db = fakeDb([
      row({ symbol: 'SGOV', role: 'cash_parking', alwaysActive: true }),
      row({
        symbol: 'QQQ',
        role: 'core_trend',
        entryRequired: true,
        cashFallbackSymbols: '["SGOV"]',
      }),
      row({ symbol: 'SOXL' }), // role NULL = 従来挙動
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('<th>ロール</th>')
    expect(body).toContain('cash_parking')
    expect(body).toContain('常時配分')
    expect(body).toContain('core_trend')
    expect(body).toContain('条件連動')
    expect(body).toMatch(/→<a [^>]*>SGOV<\/a>/)
  })

  it('不正な role 値は警告表示 (entry 抑止の旨)', async () => {
    const db = fakeDb([row({ symbol: 'OOPS', role: 'cash_praking' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('⚠ cash_praking')
  })
})

describe('CodeRabbit #453 対応 (不正 role のフォーム防御)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('不正 role は hidden input に保持され警告表示 (silent に未設定へ戻さない)', async () => {
    const db = fakeDb([row({ symbol: 'OOPS', role: 'cash_praking' })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/OOPS/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    // select 廃止 → 不正値は hidden input に保持され、警告を出す (#role-stats)
    expect(body).toMatch(/<input type="hidden" name="role" id="symbol-form-role" value="cash_praking">/)
    expect(body).toContain('entry は抑止中')
  })
})

describe('新規登録フォームの取扱チェック (#461)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('new フォームに取扱チェック表示と denied 時の保存ブロックがある', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/new',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    expect(body).toContain('id="symbol-tradability"')
    expect(body).toContain('/admin/symbol-config/tradability-check')
    expect(body).toContain('id="symbol-form-save"')
    expect(body).toContain('_tradabilityDenied')
    // denied のみブロック。quote_ok は ✅ ではなく △ (発注可否は未保証)
    expect(body).toContain('登録は可能')
    expect(body).toContain('発注可否は未保証')
    // inline script が構文エラーなく parse できる (#465 の回帰ガードをこのページにも)
    for (const m of body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1]!)).not.toThrow()
    }
  })
})

describe('銘柄フォームのセクション UI (#symbols-form-ui)', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
  })
  afterEach(() => vi.resetAllMocks())

  it('new フォーム: 必須バッジは 4 つ、任意セクションは折りたたみ', async () => {
    const db = fakeDb([])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/new',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    // 必須バッジ: 凡例 1 + 銘柄 / 市場 / 通貨 / 売買単位 / ロール の計 6 箇所
    expect((body.match(/>必須<\/span>/g) ?? []).length).toBe(6)
    // ロールは select を廃止し hidden input + カードギャラリーで選択 (#role-stats)
    expect(body).toMatch(/<input type="hidden" name="role" id="symbol-form-role"/)
    expect(body).toContain('選択中:')
    // 任意セクションは details で、新規時は閉じている (open なし)
    expect(body).toContain('発注サイズ')
    expect(body).toContain('戦略ロール・entry 条件')
    expect(body).toContain('損切・利食・保有')
    expect(body).toContain('配分の条件連動')
    expect(body).not.toMatch(/<details open[^>]*>\s*<summary[^>]*>発注サイズ/)
    // 売買単位の fail-closed 注意は 1 行だけ残す
    expect(body).toContain('未設定の銘柄は発注されません (fail-closed)')
    // #role-stats: ロール比較ギャラリー + ホバー右プレビューが ship される。
    expect(body).toContain('id="role-gallery"')
    expect(body).toContain('id="role-preview"')
    // 2軸を構造で表現: 入場アーキ行 (押し目 + 設計中の モメンタム/逆張り)
    expect(body).toContain('id="role-grid"')
    expect(body).toContain('モメンタム')
    expect(body).toContain('逆張り')
    // role 別 preset 解決値 (入場ゲート閾値・stop/TP) が含まれる。
    expect(body).toContain('leveraged_trend: { tr: 8, heat: 60')
    expect(body).toContain('inverse_hedge: { tr: 15, heat: 40')
  })

  it('edit フォーム: 値が入っているセクションは開いた状態で表示', async () => {
    const db = fakeDb([
      row({
        symbol: 'QQQ',
        role: 'core_trend',
        budgetAllocPct: 0.2,
        stopPctOverride: -0.03,
        minReturn50dOverride: 0.03,
        entryRequired: true,
        cashFallbackSymbols: '["SGOV"]',
      }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const res = await app.request(
      '/dashboard/symbols/QQQ/edit',
      { headers: authHeader },
      { ...baseEnv, DB: {} as D1Database },
    )
    const body = await res.text()
    // 値のあるセクションは open
    expect(body).toMatch(/<details open[^>]*>\s*<summary[^>]*>発注サイズ/)
    expect(body).toMatch(/<details open[^>]*>\s*<summary[^>]*>戦略ロール・entry 条件/)
    expect(body).toMatch(/<details open[^>]*>\s*<summary[^>]*>損切・利食・保有/)
    expect(body).toMatch(/<details open[^>]*>\s*<summary[^>]*>配分の条件連動/)
  })
})

describe('POST /admin/symbol-config/:symbol/cash-fallback (#symbol-relation-map 編集)', () => {
  const post = (app: ReturnType<typeof createApp>, symbol: string, body: unknown) =>
    app.request(
      `/admin/symbol-config/${symbol}/cash-fallback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify(body),
      },
      { ...baseEnv, DB: {} as D1Database },
    )

  it('set: 退避先を設定し entry_required も同時に ON、audit log を残す', async () => {
    const db = fakeDb([
      row({ symbol: 'SOXL', currency: 'USD', entryRequired: false }),
      row({ symbol: 'SGOV', currency: 'USD' }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const res = await post(createApp(), 'SOXL', { target: 'sgov' })
    expect(res.status).toBe(200)
    const updated = db.updates.find((u) => u.table === 'symbol_config')
    expect(updated?.set).toMatchObject({ cashFallbackSymbols: '["SGOV"]', entryRequired: true })
    expect(db.inserts.some((i) => i.table === 'config_audit_log')).toBe(true)
  })

  it('clear: target null で解除 (entry_required は触らない)', async () => {
    const db = fakeDb([
      row({ symbol: 'SOXL', currency: 'USD', cashFallbackSymbols: '["SGOV"]', entryRequired: true }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const res = await post(createApp(), 'SOXL', { target: null })
    expect(res.status).toBe(200)
    const updated = db.updates.find((u) => u.table === 'symbol_config')
    expect(updated?.set).toMatchObject({ cashFallbackSymbols: null })
    expect(updated?.set).not.toHaveProperty('entryRequired')
  })

  it('検証: self 参照 / 未登録 target / 通貨不一致は 400', async () => {
    const db = fakeDb([
      row({ symbol: 'SOXL', currency: 'USD' }),
      row({ symbol: '1357', currency: 'JPY' }),
    ])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    expect((await post(app, 'SOXL', { target: 'SOXL' })).status).toBe(400)
    expect((await post(app, 'SOXL', { target: 'ZZZZ' })).status).toBe(400)
    expect((await post(app, 'SOXL', { target: '1357' })).status).toBe(400)
  })
})

describe('銘柄管理の tab 分離 (#symbol-relation-map)', () => {
  it('default は一覧タブ (表あり・キャンバスなし)、?tab=workflow でキャンバスのみ', async () => {
    const db = fakeDb([row({ symbol: 'SOXL', budgetAllocPct: 0.5 })])
    vi.mocked(createDb).mockReturnValue(db.drizzleLike as never)
    const app = createApp()
    const listRes = await app.request('/dashboard/symbols', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const listBody = await listRes.text()
    expect(listBody).toContain('ワークフロー')
    expect(listBody).toContain('銘柄名') // 表 header
    expect(listBody).not.toContain('symbol-map-editor')

    const wfRes = await app.request('/dashboard/symbols?tab=workflow', { headers: authHeader }, { ...baseEnv, DB: {} as D1Database })
    const wfBody = await wfRes.text()
    expect(wfBody).toContain('symbol-map-editor')
    expect(wfBody).toContain("el.classList.add('sm-view')")
    expect(wfBody).not.toContain('銘柄名')
  })
})
