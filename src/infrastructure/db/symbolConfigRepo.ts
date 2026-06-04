import { eq, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { inversePairs, symbolConfig, type SymbolConfigRow } from './schema'

export type SymbolCurrency = 'USD' | 'JPY'
export type SymbolMarket = 'US' | 'JP'

export interface SymbolConfigSnapshot {
  /** Uppercased symbols where `active = 1`. cron / risk gate はこの list だけを評価対象とする。 */
  allowedSymbols: string[]
  /**
   * Uppercased symbols where `active = 0`. Operator visibility 用 — dashboard
   * の picker / table は disabled でも表示し続ける必要がある (operator が
   * disable 経緯を判断して再有効化判断するため)。cron / risk gate からは見えない。
   */
  inactiveSymbols: string[]
  /**
   * symbol → max_notional (positive number). Symbols with `max_notional` NULL
   * are absent from the map — caller falls through to the global
   * `MAX_ORDER_NOTIONAL`. active=0 の銘柄も含む (display 用)。
   */
  symbolMaxNotional: Record<string, number>
  /** symbol → currency ('USD' / 'JPY')。Risk gate が global 通貨別 cap を引くのに使う。active=0 含む。 */
  symbolCurrency: Record<string, SymbolCurrency>
  /**
   * symbol → market ('US' | 'JP')。dashboard が JP 銘柄表示を「番号-会社名」
   * に切り替える判定に使う。CHECK 制約は schema 側に無いので 'US' / 'JP'
   * 以外が混ざる場合は 'US' fallback (defensive)。active=0 含む。
   */
  symbolMarket: Record<string, SymbolMarket>
  /**
   * symbol → 人間可読な銘柄名 (symbol_config.name)。NULL / 空文字は map に
   * 含めない。dashboard が JP の `${symbol}-${name}` 表示で使う。active=0 含む。
   */
  symbolName: Record<string, string>
  /**
   * symbol → notes (symbol_config.notes)。disable 理由などを operator が memo
   * しておく自由 text。NULL / 空文字は map に含めない。dashboard が disabled
   * 銘柄の tooltip 表示に使う。active=0 / active=1 両方含む。
   */
  symbolNotes: Record<string, string>
  /**
   * symbol → time_stop_days_override (integer 1-365)。NULL は map に含めない
   * (= global_config.pullback_default_time_stop_days を使う fall-through)。
   * 3x leveraged ETF 等で短い hold を強制したい時に使う (#316)。
   */
  symbolTimeStopDaysOverride: Record<string, number>
  /**
   * symbol → k_atr_override (float 0.5-5.0)。NULL は map に含めない
   * (= global_config.pullback_default_k_atr を使う fall-through)。
   * 高ボラ銘柄で ATR stop を緩めたい時に使う (#316)。
   */
  symbolKAtrOverride: Record<string, number>
  /**
   * symbol → budget_alloc_pct (fraction 0<pct<=1)。NULL は map に含めない
   * (= 従来の risk-% sizing)。fixed-% 配分モードの sizing に使う (#budget-alloc)。
   */
  symbolBudgetAllocPct: Record<string, number>
}

/**
 * Loads the per-symbol config from D1. A single query is cheap; no cache at
 * this layer — call sites hold the snapshot for the duration of one handler.
 *
 * active=1 / active=0 の両方を取得し、`allowedSymbols` (active=1) と
 * `inactiveSymbols` (active=0) に振り分ける。cron / risk gate は
 * `allowedSymbols` のみを参照するため挙動は変えない。dashboard が
 * disabled 銘柄を grayed-out で表示するために両方を返す (operator visibility)。
 */
export async function loadSymbolConfig(
  db: DrizzleD1Database,
): Promise<SymbolConfigSnapshot> {
  const rows = await db.select().from(symbolConfig)

  const allowedSymbols: string[] = []
  const inactiveSymbols: string[] = []
  const symbolMaxNotional: Record<string, number> = {}
  const symbolCurrency: Record<string, SymbolCurrency> = {}
  const symbolMarket: Record<string, SymbolMarket> = {}
  const symbolName: Record<string, string> = {}
  const symbolNotes: Record<string, string> = {}
  const symbolTimeStopDaysOverride: Record<string, number> = {}
  const symbolKAtrOverride: Record<string, number> = {}
  const symbolBudgetAllocPct: Record<string, number> = {}
  for (const row of rows) {
    const symbol = row.symbol.toUpperCase()
    if (row.active) {
      allowedSymbols.push(symbol)
    } else {
      inactiveSymbols.push(symbol)
    }
    if (row.maxNotional !== null && Number.isFinite(row.maxNotional) && row.maxNotional > 0) {
      symbolMaxNotional[symbol] = row.maxNotional
    }
    symbolCurrency[symbol] = row.currency === 'JPY' ? 'JPY' : 'USD'
    // schema 上 market は 'US' | 'JP' 想定だが CHECK 制約は無いので
    // 不正値は 'US' fallback (defensive)。dashboard 表示の「JP のみ
    // 番号-会社名」判定に使う。
    symbolMarket[symbol] = row.market === 'JP' ? 'JP' : 'US'
    const trimmedName = row.name?.trim()
    if (trimmedName && trimmedName.length > 0) {
      symbolName[symbol] = trimmedName
    }
    const trimmedNotes = row.notes?.trim()
    if (trimmedNotes && trimmedNotes.length > 0) {
      symbolNotes[symbol] = trimmedNotes
    }
    // override 値は DB CHECK で範囲済み。Number.isFinite で defensive 確認だけ
    // 入れて (NaN を絶対に下流に流さない)、NULL は map に出さず fall-through。
    if (
      row.timeStopDaysOverride !== null &&
      row.timeStopDaysOverride !== undefined &&
      Number.isFinite(row.timeStopDaysOverride)
    ) {
      symbolTimeStopDaysOverride[symbol] = row.timeStopDaysOverride
    }
    if (
      row.kAtrOverride !== null &&
      row.kAtrOverride !== undefined &&
      Number.isFinite(row.kAtrOverride)
    ) {
      symbolKAtrOverride[symbol] = row.kAtrOverride
    }
    // budget_alloc_pct は 0<pct<=1 のみ採用 (範囲外 / NaN は無視 = risk sizing)。
    if (
      row.budgetAllocPct !== null &&
      row.budgetAllocPct !== undefined &&
      Number.isFinite(row.budgetAllocPct) &&
      row.budgetAllocPct > 0 &&
      row.budgetAllocPct <= 1
    ) {
      symbolBudgetAllocPct[symbol] = row.budgetAllocPct
    }
  }
  return {
    allowedSymbols,
    inactiveSymbols,
    symbolMaxNotional,
    symbolCurrency,
    symbolMarket,
    symbolName,
    symbolNotes,
    symbolTimeStopDaysOverride,
    symbolKAtrOverride,
    symbolBudgetAllocPct,
  }
}

/**
 * symbol_config 1 行を返す。CRUD UI (#292) の before/after snapshot に使う。
 * 未存在は `null`。
 */
export async function findSymbolConfig(
  db: DrizzleD1Database,
  symbol: string,
): Promise<SymbolConfigRow | null> {
  const rows = await db.select().from(symbolConfig).where(eq(symbolConfig.symbol, symbol)).limit(1)
  return rows[0] ?? null
}

export interface SymbolConfigWriteInput {
  symbol: string
  name: string | null
  market: SymbolMarket
  currency: SymbolCurrency
  active: boolean
  maxNotional: number | null
  notes: string | null
  /**
   * Per-symbol time_stop_days override (NULL = global default 使用、1-365 整数)。
   * 3x leveraged ETF 等で短い hold を強制 (#316)。
   */
  timeStopDaysOverride: number | null
  /**
   * Per-symbol k_atr override (NULL = global default 使用、0.5-5.0 float)。
   * 高ボラ銘柄で ATR stop を緩める (#316)。
   */
  kAtrOverride: number | null
  /**
   * 予算配分 fraction (NULL = risk-% sizing、0<pct<=1)。fixed-% 配分モード
   * (#budget-alloc)。
   */
  budgetAllocPct: number | null
}

/**
 * CRUD UI (#292) で symbol_config に新規 INSERT する。symbol 既存なら null を
 * 返し caller が 409 を返す。INSERT 後の最新行を返す。
 *
 * pre-check + INSERT は TOCTOU race を作る (並列 INSERT が両方 pre-check
 * を通過 → 後者が UNIQUE 制約違反で 500 化する)。代わりに INSERT を直接
 * 試行し、UNIQUE 違反だけを `null` に変換する (= 既存銘柄判定)。
 */
export async function insertSymbolConfig(
  db: DrizzleD1Database,
  input: SymbolConfigWriteInput,
  nowIso: string,
): Promise<SymbolConfigRow | null> {
  try {
    await db.insert(symbolConfig).values({
      symbol: input.symbol,
      name: input.name,
      market: input.market,
      currency: input.currency,
      active: input.active,
      maxNotional: input.maxNotional,
      notes: input.notes,
      timeStopDaysOverride: input.timeStopDaysOverride,
      kAtrOverride: input.kAtrOverride,
      budgetAllocPct: input.budgetAllocPct,
      updatedAt: nowIso,
    })
  } catch (err) {
    if (isUniqueConstraintError(err)) return null
    throw err
  }
  return await findSymbolConfig(db, input.symbol)
}

/**
 * SQLite (better-sqlite3 / D1) は UNIQUE 違反を `UNIQUE constraint failed`
 * を含む Error message で返す。drizzle はそれを wrap した Error で投げる
 * ので、 message 文字列マッチで判定する (driver による差分を吸収)。
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return message.includes('UNIQUE constraint failed')
}

/**
 * CRUD UI (#292) で symbol_config を全列 update する。存在しなければ null を
 * 返し caller が 404 を返す。symbol 自体は path から固定で来るので変更不可。
 */
export async function updateSymbolConfig(
  db: DrizzleD1Database,
  input: SymbolConfigWriteInput,
  nowIso: string,
): Promise<SymbolConfigRow | null> {
  const existing = await findSymbolConfig(db, input.symbol)
  if (existing === null) return null
  await db
    .update(symbolConfig)
    .set({
      name: input.name,
      market: input.market,
      currency: input.currency,
      active: input.active,
      maxNotional: input.maxNotional,
      notes: input.notes,
      timeStopDaysOverride: input.timeStopDaysOverride,
      kAtrOverride: input.kAtrOverride,
      budgetAllocPct: input.budgetAllocPct,
      updatedAt: nowIso,
    })
    .where(eq(symbolConfig.symbol, input.symbol))
  return await findSymbolConfig(db, input.symbol)
}

/**
 * Flip `active` 1↔0 atomically. UPDATE 自体は SQL `NOT active` で
 * read-modify-write race を排除する (並列 2 連打が両方 SELECT で同じ
 * `before` を読んで同じ値を書き戻すのを防ぐ)。
 * Not found → null。
 *
 * WHY: audit log の before/after は SELECT-UPDATE-SELECT で取るため厳密
 * には atomic ではない — 高並列時 before/after の遷移を 1 step ずれて
 * 観測する可能性があるが、DB 上の state 自体は SQL NOT で atomic に
 * flip するので冪等性は壊れない。POC scope では許容。
 */
export async function toggleSymbolActive(
  db: DrizzleD1Database,
  symbol: string,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  await db
    .update(symbolConfig)
    .set({ active: sql`NOT ${symbolConfig.active}`, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

/**
 * Hard delete。inactive (active=false) 行のみ削除可、active 行は削除拒否
 * ({ rejected: 'still_active' } 返却)。
 *
 * 旧 soft-delete (active=false 化) は toggle-active で代替できるため重複機能を
 * 廃止し、UI 上「削除」= row そのものの除去を意味するように整理 (audit row は
 * 別 table のため、削除後も操作履歴は残る)。
 *
 * FK は明示宣言されてないが、削除後に historical trade_journal などが symbol
 * 文字列を保持するのは OK (orphan reference、表示時 inactive 扱い)。
 */
export async function hardDeleteSymbol(
  db: DrizzleD1Database,
  symbol: string,
): Promise<{ before: SymbolConfigRow } | { rejected: 'still_active' } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  if (before.active) {
    return { rejected: 'still_active' }
  }
  const beforeSnapshot: SymbolConfigRow = { ...before }
  await db.delete(symbolConfig).where(eq(symbolConfig.symbol, symbol))
  return { before: beforeSnapshot }
}

/**
 * Returns a bidirectional inverse-pair map (SOXL→SOXS AND SOXS→SOXL even if
 * only one direction is stored). TradingService's inverse-pair gate expects
 * both directions populated.
 */
export async function loadInversePairs(
  db: DrizzleD1Database,
): Promise<Record<string, string>> {
  const rows = await db.select().from(inversePairs)
  const result: Record<string, string> = {}
  for (const row of rows) {
    const left = row.symbol.toUpperCase()
    const right = row.inverse.toUpperCase()
    if (left === right) continue
    result[left] = right
    if (result[right] === undefined) {
      result[right] = left
    }
  }
  return result
}

/**
 * inverse_pairs を 1:1 で張る (#315 regime hedge の対登録)。canonical 1 行のみ
 * 保存し、`loadInversePairs` が双方向展開する。
 *
 * **1:1 強制**: a / b いずれかに触れる既存 pair 行を全削除してから 1 行 INSERT する。
 * これで「SOXL↔SOXS と SOXL↔TQQQ」のような多対多事故を防ぐ (operator が対を
 * 張り替えたら旧リンクは自動で消える)。self-pair (a===b) は throw。
 *
 * 戻り値の statements を呼び出し側が `db.batch` に渡し、symbol_config 作成と
 * 同一トランザクションで原子的に適用できるようにする (createSymbolPair 用)。
 * 単独で張りたい場合は `await runInversePairWrite(db, a, b, nowIso)` を使う。
 */
function buildInversePairWrite(
  db: DrizzleD1Database,
  a: string,
  b: string,
  nowIso: string,
) {
  const left = a.trim().toUpperCase()
  const right = b.trim().toUpperCase()
  if (left.length === 0 || right.length === 0) {
    throw new Error('inverse pair requires two non-empty symbols')
  }
  if (left === right) {
    throw new Error(`inverse pair cannot be self-referential: ${left}`)
  }
  return [
    // a / b に触れる既存リンクを全削除 (どちらの向きで保存されていても消す)。
    db
      .delete(inversePairs)
      .where(
        or(
          eq(inversePairs.symbol, left),
          eq(inversePairs.inverse, left),
          eq(inversePairs.symbol, right),
          eq(inversePairs.inverse, right),
        ),
      ),
    db.insert(inversePairs).values({ symbol: left, inverse: right, updatedAt: nowIso }),
  ] as const
}

export async function setInversePair(
  db: DrizzleD1Database,
  a: string,
  b: string,
  nowIso: string,
): Promise<void> {
  const [del, ins] = buildInversePairWrite(db, a, b, nowIso)
  await db.batch([del, ins])
}

/**
 * symbol に触れる inverse_pairs 行を全削除 (cascade delete 用)。symbol_config の
 * hardDelete と組で呼び、half-pair を残さない。相手の symbol_config 行は消さない。
 */
export async function deleteInversePairsForSymbol(
  db: DrizzleD1Database,
  symbol: string,
): Promise<void> {
  const s = symbol.trim().toUpperCase()
  await db
    .delete(inversePairs)
    .where(or(eq(inversePairs.symbol, s), eq(inversePairs.inverse, s)))
}

export interface CreateSymbolPairResult {
  /** primary が既存 (UNIQUE 衝突) なら 'duplicate'、新規作成成功なら 'created'。 */
  primary: 'created' | 'duplicate'
  /** counterpart を新規作成したか (既存ならそのまま、ON CONFLICT DO NOTHING)。 */
  counterpartCreated: boolean
}

/** counterpart 銘柄のメタ (Yahoo lookup 由来)。未指定列は primary 継承 / name は null。 */
export interface CounterpartMeta {
  name?: string | null
  market?: SymbolMarket
  currency?: SymbolCurrency
}

/**
 * bull/bear を 1 フォームで対登録する (#315)。D1 batch で原子的に:
 *   1. primary symbol_config INSERT (重複は 'duplicate' を返す)
 *   2. counterpart symbol_config を INSERT ... ON CONFLICT DO NOTHING
 *      (name/market/currency は counterpart メタ (Yahoo 由来) を優先、無ければ
 *       market/currency は primary 継承・name は null。maxNotional は primary 継承)
 *   3. inverse_pairs リンク (1:1、既存リンクは buildInversePairWrite が掃除)
 *
 * primary が既存銘柄の場合は何も作らず 'duplicate' を返す (caller が 409/echo)。
 */
export async function createSymbolPair(
  db: DrizzleD1Database,
  primary: SymbolConfigWriteInput,
  inverseSymbol: string,
  nowIso: string,
  counterpartMeta: CounterpartMeta = {},
): Promise<CreateSymbolPairResult> {
  const primarySym = primary.symbol.trim().toUpperCase()
  const counterpartSym = inverseSymbol.trim().toUpperCase()
  if (counterpartSym.length === 0) {
    throw new Error('createSymbolPair requires a non-empty inverse symbol')
  }
  if (primarySym === counterpartSym) {
    throw new Error(`inverse pair cannot be self-referential: ${primarySym}`)
  }

  // primary は重複検知のため先に単独 INSERT (UNIQUE 違反 = duplicate)。ここで
  // 弾けば counterpart / link を作らずに早期 return できる。
  const inserted = await insertSymbolConfig(db, { ...primary, symbol: primarySym }, nowIso)
  if (inserted === null) {
    return { primary: 'duplicate', counterpartCreated: false }
  }

  const counterpartBefore = await findSymbolConfig(db, counterpartSym)
  const [delLink, insLink] = buildInversePairWrite(db, primarySym, counterpartSym, nowIso)

  // counterpart を新規作成 (既存なら触らない)。name/market/currency は Yahoo 由来
  // メタを優先 (インバース銘柄名を一覧に出すため)、無ければ primary 継承。
  // link 掃除 → counterpart 作成 → link 作成 の順。
  if (counterpartBefore === null) {
    const counterpartName = counterpartMeta.name?.trim()
    const insCounterpart = db.insert(symbolConfig).values({
      symbol: counterpartSym,
      name: counterpartName && counterpartName.length > 0 ? counterpartName : null,
      market: counterpartMeta.market ?? primary.market,
      currency: counterpartMeta.currency ?? primary.currency,
      active: true,
      maxNotional: primary.maxNotional,
      notes: null,
      timeStopDaysOverride: null,
      kAtrOverride: null,
      // regime hedge は片方ずつ建てるので counterpart も同じ予算配分%を継承。
      budgetAllocPct: primary.budgetAllocPct,
      updatedAt: nowIso,
    })
    await db.batch([delLink, insCounterpart, insLink])
  } else {
    await db.batch([delLink, insLink])
  }
  return { primary: 'created', counterpartCreated: counterpartBefore === null }
}
