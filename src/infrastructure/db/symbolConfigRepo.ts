import { eq, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { inversePairs, symbolConfig, type SymbolConfigRow } from './schema'

export type SymbolCurrency = 'USD' | 'JPY'
export type SymbolMarket = 'US' | 'JP'

/**
 * 銘柄ロール 6 分類 (#452 Layer 1、#451)。初期有効化は cash_parking /
 * core_trend / leveraged_trend の 3 つ。low_volatility / sector_trend /
 * inverse_hedge は定義のみ (後続 issue) で entry 抑止される。
 */
export const SYMBOL_ROLES = [
  'cash_parking',
  'core_trend',
  'leveraged_trend',
  'low_volatility',
  'sector_trend',
  'inverse_hedge',
] as const
export type SymbolRole = (typeof SYMBOL_ROLES)[number]

/**
 * Snapshot 上の role 値。DB に enum 外の文字列が直接書かれた場合は 'unknown' に
 * 正規化する — NULL (= 従来挙動で取引可) に**倒さない**。typo した role の銘柄が
 * 既定 gate で発注される事故を防ぐ fail-closed (downstream は 'unknown' を
 * entry 抑止として扱う、#452)。
 */
export type SymbolRoleValue = SymbolRole | 'unknown'

export function isSymbolRole(value: unknown): value is SymbolRole {
  return typeof value === 'string' && (SYMBOL_ROLES as readonly string[]).includes(value)
}


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
  /**
   * symbol → lot_size (売買単位、integer >= 1)。NULL / 不正は map に**含めない**。
   * 下流 (cron sizing) は map に無い銘柄を fail-closed (発注見送り) 扱いにする
   * — blanket default に倒さない (#symbol-lot-size)。
   */
  symbolLotSize: Record<string, number>
  /**
   * symbol → stop_pct_override (負の fraction)。NULL は map に含めない
   * (= global default を使う)。3x レバ ETF 等で stop を広げる (#exit-atr)。
   */
  symbolStopPctOverride: Record<string, number>
  /**
   * symbol → take_profit_pct_override (正の fraction)。NULL は map に含めない。
   */
  symbolTakeProfitPctOverride: Record<string, number>
  /**
   * intraday_only = true の symbol 集合 (#intraday-only)。false は map に含めない。
   * cron が US 引け前に強制クローズする対象。
   */
  symbolIntradayOnly: Record<string, boolean>
  /**
   * symbol → role (#452 Layer 1)。NULL は map に含めない (= 従来挙動)。
   * enum 外の DB 直書き値は 'unknown' として**含める** — downstream が entry 抑止
   * (fail-closed) で扱う。NULL fallback に倒さない。
   */
  symbolRole: Record<string, SymbolRoleValue>
  /**
   * Entry gate override (#452 Layer 2a)。NULL / 範囲外は map に含めない
   * (= role preset → global default の fall-through)。
   * pullback band: max は 0 側 / min は深い側、いずれも fraction [-1, 0]。
   */
  symbolPullbackMaxOverride: Record<string, number>
  symbolPullbackMinOverride: Record<string, number>
  /** トレンド条件 override (fraction [-1, 10])。 */
  symbolMinReturn50dOverride: Record<string, number>
  /** ボラ過熱ガード override (ratio (0, 10])。 */
  symbolMaxAtrRatioOverride: Record<string, number>
  /** 過伸長ガード override (fraction (0, 10])。 */
  symbolMaxSma50DeviationPctOverride: Record<string, number>
  /** SMA50 上抜け必須 override (true / false 両方 map に含める。NULL は不在)。 */
  symbolRequireAboveSma50Override: Record<string, boolean>
  /**
   * entry_required=true の symbol 集合 (#452 Layer 3)。gate 未通過の間
   * active weight = 0 になり cash fallback へ退避される。false は不在。
   */
  symbolEntryRequired: Record<string, boolean>
  /** always_active=true の symbol 集合 (#452、cash_parking 用)。false は不在。 */
  symbolAlwaysActive: Record<string, boolean>
  /**
   * symbol → cash_fallback_symbol (#452)。NULL / 不正 ticker / self 参照は不在
   * (= 退避しない、現金のまま)。
   */
  symbolCashFallback: Record<string, string>
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
  const symbolLotSize: Record<string, number> = {}
  const symbolStopPctOverride: Record<string, number> = {}
  const symbolTakeProfitPctOverride: Record<string, number> = {}
  const symbolIntradayOnly: Record<string, boolean> = {}
  const symbolRole: Record<string, SymbolRoleValue> = {}
  const symbolPullbackMaxOverride: Record<string, number> = {}
  const symbolPullbackMinOverride: Record<string, number> = {}
  const symbolMinReturn50dOverride: Record<string, number> = {}
  const symbolMaxAtrRatioOverride: Record<string, number> = {}
  const symbolMaxSma50DeviationPctOverride: Record<string, number> = {}
  const symbolRequireAboveSma50Override: Record<string, boolean> = {}
  const symbolEntryRequired: Record<string, boolean> = {}
  const symbolAlwaysActive: Record<string, boolean> = {}
  const symbolCashFallback: Record<string, string> = {}
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
    // lot_size は integer >= 1 のみ採用。NULL / 非整数 / <1 は map に出さず
    // (= 下流 fail-closed)。blanket default に倒さない (#symbol-lot-size)。
    if (
      row.lotSize !== null &&
      row.lotSize !== undefined &&
      Number.isFinite(row.lotSize) &&
      Number.isInteger(row.lotSize) &&
      row.lotSize >= 1
    ) {
      symbolLotSize[symbol] = row.lotSize
    }
    // stop/TP override は **符号・レンジまで検証**して採用 (fail-closed、CodeRabbit #432)。
    // 直接 DB を弄って stop=0 / 正値や TP=0 / 負値が入っても、無効値は map に出さず
    // global default にフォールバックさせる (admin parse の二重防御)。
    // stop は負 fraction [-1, 0)、TP は正 fraction (0, 1]。
    if (
      row.stopPctOverride !== null &&
      row.stopPctOverride !== undefined &&
      Number.isFinite(row.stopPctOverride) &&
      row.stopPctOverride < 0 &&
      row.stopPctOverride >= -1
    ) {
      symbolStopPctOverride[symbol] = row.stopPctOverride
    }
    if (
      row.takeProfitPctOverride !== null &&
      row.takeProfitPctOverride !== undefined &&
      Number.isFinite(row.takeProfitPctOverride) &&
      row.takeProfitPctOverride > 0 &&
      row.takeProfitPctOverride <= 1
    ) {
      symbolTakeProfitPctOverride[symbol] = row.takeProfitPctOverride
    }
    if (row.intradayOnly === true) {
      symbolIntradayOnly[symbol] = true
    }
    // role (#452): NULL は不在 (= 従来挙動)。enum 外の DB 直書きは 'unknown' で
    // 含める — NULL 扱いに倒すと typo した role が既定 gate で発注され得るため、
    // downstream で entry 抑止される値に正規化する (fail-closed)。
    if (row.role !== null && row.role !== undefined) {
      const trimmedRole = row.role.trim()
      if (trimmedRole.length > 0) {
        symbolRole[symbol] = isSymbolRole(trimmedRole) ? trimmedRole : 'unknown'
      }
    }
    // entry gate override (#452 Layer 2a)。stop/TP override と同じく符号・レンジ
    // まで検証して採用し、無効値は map に出さず fall-through。pullback band の
    // max < min 不整合はここでは弾かない — 「常に entry 不成立 = 発注なし」に
    // しかならず fail-closed 側のため (admin parse 側で入力時に cross-check)。
    if (
      row.pullbackMaxOverride !== null &&
      row.pullbackMaxOverride !== undefined &&
      Number.isFinite(row.pullbackMaxOverride) &&
      row.pullbackMaxOverride >= -1 &&
      row.pullbackMaxOverride <= 0
    ) {
      symbolPullbackMaxOverride[symbol] = row.pullbackMaxOverride
    }
    if (
      row.pullbackMinOverride !== null &&
      row.pullbackMinOverride !== undefined &&
      Number.isFinite(row.pullbackMinOverride) &&
      row.pullbackMinOverride >= -1 &&
      row.pullbackMinOverride <= 0
    ) {
      symbolPullbackMinOverride[symbol] = row.pullbackMinOverride
    }
    if (
      row.minReturn50dOverride !== null &&
      row.minReturn50dOverride !== undefined &&
      Number.isFinite(row.minReturn50dOverride) &&
      row.minReturn50dOverride >= -1 &&
      row.minReturn50dOverride <= 10
    ) {
      symbolMinReturn50dOverride[symbol] = row.minReturn50dOverride
    }
    if (
      row.maxAtrRatioOverride !== null &&
      row.maxAtrRatioOverride !== undefined &&
      Number.isFinite(row.maxAtrRatioOverride) &&
      row.maxAtrRatioOverride > 0 &&
      row.maxAtrRatioOverride <= 10
    ) {
      symbolMaxAtrRatioOverride[symbol] = row.maxAtrRatioOverride
    }
    if (
      row.maxSma50DeviationPctOverride !== null &&
      row.maxSma50DeviationPctOverride !== undefined &&
      Number.isFinite(row.maxSma50DeviationPctOverride) &&
      row.maxSma50DeviationPctOverride > 0 &&
      row.maxSma50DeviationPctOverride <= 10
    ) {
      symbolMaxSma50DeviationPctOverride[symbol] = row.maxSma50DeviationPctOverride
    }
    if (row.requireAboveSma50Override === true || row.requireAboveSma50Override === false) {
      symbolRequireAboveSma50Override[symbol] = row.requireAboveSma50Override
    }
    // 条件連動配分 (#452 Layer 3)。false は map に出さない (従来挙動 = 常時枠)。
    if (row.entryRequired === true) {
      symbolEntryRequired[symbol] = true
    }
    if (row.alwaysActive === true) {
      symbolAlwaysActive[symbol] = true
    }
    // 退避先は ticker 文法 + self 参照禁止まで検証。無効値は不在 (= 退避なし、
    // 現金のまま) — 誤った退避先に積み増すより安全側。
    if (row.cashFallbackSymbol !== null && row.cashFallbackSymbol !== undefined) {
      const fallback = row.cashFallbackSymbol.trim().toUpperCase()
      if (/^[A-Z0-9]{1,10}$/.test(fallback) && fallback !== symbol) {
        symbolCashFallback[symbol] = fallback
      }
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
    symbolLotSize,
    symbolStopPctOverride,
    symbolTakeProfitPctOverride,
    symbolIntradayOnly,
    symbolRole,
    symbolPullbackMaxOverride,
    symbolPullbackMinOverride,
    symbolMinReturn50dOverride,
    symbolMaxAtrRatioOverride,
    symbolMaxSma50DeviationPctOverride,
    symbolRequireAboveSma50Override,
    symbolEntryRequired,
    symbolAlwaysActive,
    symbolCashFallback,
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
  /**
   * 売買単位 (integer >= 1)。**入力必須** — admin parse が未入力を弾く。NULL は
   * 既存行 (migration 前) のみで、cron sizing は NULL を fail-closed 扱いにする
   * (#symbol-lot-size)。
   */
  lotSize: number | null
  /** 損切り fraction override (負値、NULL = global default、#exit-atr)。 */
  stopPctOverride: number | null
  /** 利食い fraction override (正値、NULL = global default)。 */
  takeProfitPctOverride: number | null
  /** intraday-only (US 引け前強制クローズ、default false、#intraday-only)。 */
  intradayOnly: boolean
  /** 銘柄ロール (NULL = 従来挙動、#452 Layer 1)。admin parse が enum を強制する。 */
  role: SymbolRole | null
  /** Entry gate override (NULL = role preset → global default、#452 Layer 2a)。 */
  pullbackMaxOverride: number | null
  pullbackMinOverride: number | null
  minReturn50dOverride: number | null
  maxAtrRatioOverride: number | null
  maxSma50DeviationPctOverride: number | null
  requireAboveSma50Override: boolean | null
  /** 条件連動配分 (#452 Layer 3): gate 通過を実配分の必須条件にする。default false。 */
  entryRequired: boolean
  /** 常時 target = active (cash_parking 用、#452)。default false。 */
  alwaysActive: boolean
  /** 条件未通過時の退避先 symbol (NULL = 退避しない、#452)。 */
  cashFallbackSymbol: string | null
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
      lotSize: input.lotSize,
      stopPctOverride: input.stopPctOverride,
      takeProfitPctOverride: input.takeProfitPctOverride,
      intradayOnly: input.intradayOnly,
      role: input.role,
      pullbackMaxOverride: input.pullbackMaxOverride,
      pullbackMinOverride: input.pullbackMinOverride,
      minReturn50dOverride: input.minReturn50dOverride,
      maxAtrRatioOverride: input.maxAtrRatioOverride,
      maxSma50DeviationPctOverride: input.maxSma50DeviationPctOverride,
      requireAboveSma50Override: input.requireAboveSma50Override,
      entryRequired: input.entryRequired,
      alwaysActive: input.alwaysActive,
      cashFallbackSymbol: input.cashFallbackSymbol,
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
      lotSize: input.lotSize,
      stopPctOverride: input.stopPctOverride,
      takeProfitPctOverride: input.takeProfitPctOverride,
      intradayOnly: input.intradayOnly,
      role: input.role,
      pullbackMaxOverride: input.pullbackMaxOverride,
      pullbackMinOverride: input.pullbackMinOverride,
      minReturn50dOverride: input.minReturn50dOverride,
      maxAtrRatioOverride: input.maxAtrRatioOverride,
      maxSma50DeviationPctOverride: input.maxSma50DeviationPctOverride,
      requireAboveSma50Override: input.requireAboveSma50Override,
      entryRequired: input.entryRequired,
      alwaysActive: input.alwaysActive,
      cashFallbackSymbol: input.cashFallbackSymbol,
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
/**
 * Broker が銘柄単位で発注拒否 (TICKER_IS_DENY 等の恒久エラー) を返したとき、
 * cron が該当銘柄を fail-closed で自動 entry 停止する (#460)。
 *
 * - `active = 0` + notes に理由を**追記** (既存メモは保持、256 chars に切詰め)
 * - 既に inactive なら no-op (`null` 返却) — 同 tick 内の並走や再検知で
 *   notes が重複追記されない冪等ガード
 * - 解除 (再有効化) は operator の明示操作のみ。自動では戻さない
 */
export async function deactivateSymbolForBrokerDeny(
  db: DrizzleD1Database,
  symbol: string,
  reasonNote: string,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const upper = symbol.trim().toUpperCase()
  const before = await findSymbolConfig(db, upper)
  if (before === null || !before.active) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  const existingNotes = before.notes?.trim() ?? ''
  const mergedNotes = (existingNotes.length > 0 ? `${existingNotes} / ${reasonNote}` : reasonNote).slice(0, 256)
  await db
    .update(symbolConfig)
    .set({ active: false, notes: mergedNotes, updatedAt: nowIso })
    .where(eq(symbolConfig.symbol, upper))
  const after = await findSymbolConfig(db, upper)
  if (after === null) return null
  return { before: beforeSnapshot, after }
}

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
 * budget_alloc_pct だけを更新する focused update (#budget-alloc ラダー調整用)。
 * `pct` は fraction (0<pct<=1) or null (= risk-% sizing に戻す)。存在しなければ null。
 * before/after を返し caller が audit / inverse 同期に使う。
 */
/**
 * 退避先 (cash_fallback_symbol) の set / clear (#symbol-relation-map 編集
 * キャンバス用)。set 時は entry_required も同時に ON する — 退避先だけ設定して
 * 条件連動 OFF の「眠った設定」(operator が実際に踏んだ罠) を作らせない。
 * clear は entry_required を触らない (条件連動自体の意図は別设定)。
 * 同値なら UPDATE しない (updatedAt だけ無監査で進むのを防ぐ)。
 */
export async function updateCashFallback(
  db: DrizzleD1Database,
  symbol: string,
  target: string | null,
  nowIso: string,
): Promise<{
  before: SymbolConfigRow
  after: SymbolConfigRow
  /** 対の相方から外した退避先 (1 対 1 本ルール)。無ければ null。 */
  clearedPartner: { symbol: string; previousFallback: string } | null
} | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  // 1 対 1 本 (キャンバスと同じ規則): 対の両側に退避先があると、対で 1 枠の
  // 配分が銘柄単位の reroute で二重退避されるため、set 時は相方の退避先を外す。
  let clearedPartner: { symbol: string; previousFallback: string } | null = null
  if (target !== null) {
    const pairs = await loadInversePairs(db).catch(() => ({}) as Record<string, string>)
    const partner = pairs[symbol.toUpperCase()]
    if (partner !== undefined) {
      const partnerRow = await findSymbolConfig(db, partner)
      if (partnerRow?.cashFallbackSymbol) {
        await db
          .update(symbolConfig)
          .set({ cashFallbackSymbol: null, updatedAt: nowIso })
          .where(eq(symbolConfig.symbol, partnerRow.symbol))
        clearedPartner = { symbol: partnerRow.symbol, previousFallback: partnerRow.cashFallbackSymbol }
      }
    }
  }
  const sameTarget = (before.cashFallbackSymbol ?? null) === (target ?? null)
  const needsEntryRequired = target !== null && before.entryRequired !== true
  if (sameTarget && !needsEntryRequired) {
    return { before: beforeSnapshot, after: beforeSnapshot, clearedPartner }
  }
  await db
    .update(symbolConfig)
    .set({
      cashFallbackSymbol: target,
      ...(target !== null ? { entryRequired: true } : {}),
      updatedAt: nowIso,
    })
    .where(eq(symbolConfig.symbol, symbol))
  const after = await findSymbolConfig(db, symbol)
  if (after === null) return null
  return { before: beforeSnapshot, after, clearedPartner }
}

export async function updateBudgetAllocPct(
  db: DrizzleD1Database,
  symbol: string,
  pct: number | null,
  nowIso: string,
): Promise<{ before: SymbolConfigRow; after: SymbolConfigRow } | null> {
  const before = await findSymbolConfig(db, symbol)
  if (before === null) return null
  const beforeSnapshot: SymbolConfigRow = { ...before }
  // 同値なら UPDATE しない (updatedAt だけ無監査で進むのを防ぐ、CodeRabbit #405)。
  if ((before.budgetAllocPct ?? null) === (pct ?? null)) {
    return { before: beforeSnapshot, after: beforeSnapshot }
  }
  await db
    .update(symbolConfig)
    .set({ budgetAllocPct: pct, updatedAt: nowIso })
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
 * regime 有効化済みペアの設定を返す (#472)。`regime_enabled=1` の行のみ。
 * proxy / bull の不備・bull がペア членでない等の misconfig は **skip せず**
 * `invalidConfig` 付きで返す — 下流 (scheduler) が zone=unknown (両側 BUY
 * block) に倒すため。「不正設定を黙って無効扱い」にしない (fail-closed)。
 */
export async function loadPairRegimeConfigs(
  db: DrizzleD1Database,
): Promise<import('../../trading/strategy/pairRegime').PairRegimeEntry[]> {
  const rows = await db.select().from(inversePairs)
  const entries: import('../../trading/strategy/pairRegime').PairRegimeEntry[] = []
  for (const row of rows) {
    if (!row.regimeEnabled) continue
    const a = row.symbol.toUpperCase()
    const b = row.inverse.toUpperCase()
    const proxy = row.regimeProxySymbol?.trim().toUpperCase() ?? ''
    const bull = row.regimeBullSymbol?.trim().toUpperCase() ?? ''
    let invalidConfig: string | null = null
    if (a === b) {
      // 書き込み経路 (buildInversePairWrite) は self-pair を throw で弾くが、
      // DB 直書きで入り得る。黙って有効扱いにせず unknown へ (CodeRabbit #473)。
      invalidConfig = `inverse pair must contain two distinct symbols (got ${a}/${b})`
    } else if (proxy.length === 0 || !/^[A-Z0-9]{1,10}$/.test(proxy)) {
      invalidConfig = `regime_proxy_symbol is missing/invalid for pair ${a}/${b}`
    } else if (bull !== a && bull !== b) {
      invalidConfig = `regime_bull_symbol must be ${a} or ${b} (got '${bull}')`
    }
    const bullSymbol = bull === b ? b : a
    const bearSymbol = bullSymbol === a ? b : a
    entries.push({ bullSymbol, bearSymbol, proxySymbol: proxy || a, invalidConfig })
  }
  return entries
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
      // インバース対は同じ商品種別 (両方 3x ETF 等) なので売買単位も primary 継承。
      // 異なる場合は counterpart を個別編集で上書きする (#symbol-lot-size)。
      lotSize: primary.lotSize,
      // 同じレバ特性なので stop/TP override / intraday-only も primary 継承。
      stopPctOverride: primary.stopPctOverride,
      takeProfitPctOverride: primary.takeProfitPctOverride,
      intradayOnly: primary.intradayOnly,
      // role / entry override は **継承しない** (#452)。インバース
      // 相手は方向が逆で entry 特性が異なる (bull 側の押し目閾値は bear 側に
      // 適用できない)。NULL = 従来挙動で開始し、必要なら個別編集で設定する。
      role: null,
      pullbackMaxOverride: null,
      pullbackMinOverride: null,
      minReturn50dOverride: null,
      maxAtrRatioOverride: null,
      maxSma50DeviationPctOverride: null,
      requireAboveSma50Override: null,
      // 条件連動配分も継承しない (#452): 方向が逆の相手に同じ配分条件は適用
      // できない。default (false / NULL) = 従来挙動で開始。
      entryRequired: false,
      alwaysActive: false,
      cashFallbackSymbol: null,
      updatedAt: nowIso,
    })
    await db.batch([delLink, insCounterpart, insLink])
  } else {
    await db.batch([delLink, insLink])
  }
  return { primary: 'created', counterpartCreated: counterpartBefore === null }
}
