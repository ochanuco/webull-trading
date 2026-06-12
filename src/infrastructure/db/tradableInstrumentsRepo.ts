import { eq, inArray, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { TradableInstrumentEntry } from '../webull/tradableInstruments'
import { tradableInstrument, type TradableInstrumentRow } from './schema'

/**
 * tradable_instrument allowlist の読み書き (#460)。
 *
 * 設計の肝は **物理削除しない upsert**: 日次 sweep で消えた銘柄は
 * `currentlyTradable=false` に倒すだけで行は残す ([[schema.ts]] の table コメント
 * 参照)。これにより運用中銘柄の追跡が壊れず、`true→false` 遷移を監視できる。
 */

export type TradableDb = DrizzleD1Database<Record<string, never>>

/** 銘柄の allowlist 突合結果。 */
export type TradableStatus =
  /** 直近 sweep で tradable/list に在籍。OpenAPI 発注可。 */
  | 'tradable'
  /** 過去は在籍したが直近 sweep で消失。取扱停止された可能性。 */
  | 'disappeared'
  /** allowlist に一度も観測されていない。OpenAPI で発注できない可能性。 */
  | 'unknown'

export interface TradableAllowlistEntry {
  symbol: string
  status: TradableStatus
  name: string | null
  instrumentId: string | null
  lastSeenAt: string | null
}

/** symbol(大文字) → allowlist エントリ の lookup map。 */
export type TradableAllowlist = Map<string, TradableAllowlistEntry>

function rowStatus(row: TradableInstrumentRow): TradableStatus {
  return row.currentlyTradable ? 'tradable' : 'disappeared'
}

/**
 * allowlist 全件を map で返す。dashboard (フォーム / 一覧 / ワークフロー) の突合に
 * 使う。row が無い symbol を引いたら 'unknown' (= 取扱対象外の可能性) 扱い。
 */
export async function loadTradableAllowlist(db: TradableDb): Promise<TradableAllowlist> {
  const rows = await db.select().from(tradableInstrument)
  const map: TradableAllowlist = new Map()
  for (const row of rows) {
    map.set(row.symbol.toUpperCase(), {
      symbol: row.symbol.toUpperCase(),
      status: rowStatus(row),
      name: row.name,
      instrumentId: row.instrumentId,
      lastSeenAt: row.lastSeenAt,
    })
  }
  return map
}

/** map から 1 銘柄の status を引く (row 無し → 'unknown')。 */
export function lookupTradableStatus(allowlist: TradableAllowlist, symbol: string): TradableStatus {
  return allowlist.get(symbol.trim().toUpperCase())?.status ?? 'unknown'
}

/** D1 から 1 銘柄の allowlist status を引く (form のライブチェック用。row 無し → 'unknown')。 */
export async function getTradableStatusForSymbol(
  db: TradableDb,
  symbol: string,
): Promise<TradableStatus> {
  const sym = symbol.trim().toUpperCase()
  const rows = await db
    .select()
    .from(tradableInstrument)
    .where(eq(tradableInstrument.symbol, sym))
    .limit(1)
  const row = rows[0]
  return row ? rowStatus(row) : 'unknown'
}

export interface RefreshTradableResult {
  /** 今回 tradable として upsert した件数。 */
  upserted: number
  /** true→false に倒した (今回消失) 件数。 */
  disappeared: number
  /** 消失と判定した symbol (監視通知用、最大数件想定)。 */
  disappearedSymbols: string[]
  /** sweep が完走 (complete=true) して消失判定まで行ったか。 */
  appliedDisappearance: boolean
}

// D1 は 1 文あたり束縛変数 ~100 個まで。1 行 9 列なので 1 chunk = 10 行に抑える。
const UPSERT_CHUNK = 10
// db.batch にまとめる文数の上限 (round-trip 削減)。
const BATCH_STMTS = 40
// inArray の IN 句に積む symbol 数の上限。
const IN_CHUNK = 80

/**
 * 取得できた 1 ページ分 (または任意件数) の銘柄を `currentlyTradable=true` で
 * bulk upsert する (#460)。`firstSeenAt` は **conflict 時に更新しない** ので
 * 初回観測時刻が保持される。多数行を per-row await せず chunk + `db.batch` で
 * 数往復に畳む (4957 件の per-row 書き込みは遅すぎるため)。
 *
 * `watermarkIso` は **その sweep を識別する単調増加タイムスタンプ** で、seen 行の
 * `lastSeenAt` に書く。分割 sweep (チャンク) では全チャンクで同じ watermark を
 * 使い、最後に {@link finalizeTradableDisappearance} が「この watermark で
 * 触られなかった行 = 消失」を判定する (mark-and-sweep)。
 */
export async function upsertTradablePage(
  db: TradableDb,
  entries: TradableInstrumentEntry[],
  watermarkIso: string,
): Promise<number> {
  if (entries.length === 0) return 0
  // 同一ページ内の symbol 重複を除去 (ON CONFLICT 二重発火を避ける)。
  const bySymbol = new Map<string, TradableInstrumentEntry>()
  for (const e of entries) bySymbol.set(e.symbol.toUpperCase(), e)
  const rows = [...bySymbol.values()].map((e) => ({
    symbol: e.symbol.toUpperCase(),
    instrumentId: e.instrumentId,
    name: e.name,
    currency: e.currency,
    exchangeCode: e.exchangeCode,
    currentlyTradable: true,
    firstSeenAt: watermarkIso,
    lastSeenAt: watermarkIso,
    updatedAt: watermarkIso,
  }))

  const stmts: BatchItem<'sqlite'>[] = []
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK)
    stmts.push(
      db
        .insert(tradableInstrument)
        .values(chunk)
        .onConflictDoUpdate({
          target: tradableInstrument.symbol,
          set: {
            instrumentId: sql`excluded.instrument_id`,
            name: sql`excluded.name`,
            currency: sql`excluded.currency`,
            exchangeCode: sql`excluded.exchange_code`,
            currentlyTradable: true,
            lastSeenAt: watermarkIso,
            updatedAt: watermarkIso,
          },
        }) as unknown as BatchItem<'sqlite'>,
    )
  }
  for (let i = 0; i < stmts.length; i += BATCH_STMTS) {
    const group = stmts.slice(i, i + BATCH_STMTS) as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]
    await db.batch(group)
  }
  return rows.length
}

/**
 * mark-and-sweep の sweep フェーズ: 直近 sweep (= `watermarkIso`) で触られなかった
 * 既存 tradable 行を `currentlyTradable=false` に倒す (消失判定、物理削除しない)。
 * `lastSeenAt < watermarkIso` が「今回 sweep に出てこなかった」を意味する。
 * **完走した sweep でのみ呼ぶ** (部分結果で呼ぶと未到達ページの銘柄を誤って
 * 消失扱いする)。seen 集合を持ち回らずに済むのでチャンク分割と相性が良い。
 */
export async function finalizeTradableDisappearance(
  db: TradableDb,
  watermarkIso: string,
  nowIso: string,
): Promise<string[]> {
  const existing = await db.select().from(tradableInstrument)
  const disappeared = existing
    .filter((r) => r.currentlyTradable && (r.lastSeenAt ?? '') < watermarkIso)
    .map((r) => r.symbol.toUpperCase())
  for (let i = 0; i < disappeared.length; i += IN_CHUNK) {
    const chunk = disappeared.slice(i, i + IN_CHUNK)
    await db
      .update(tradableInstrument)
      .set({ currentlyTradable: false, updatedAt: nowIso })
      .where(inArray(tradableInstrument.symbol, chunk))
  }
  return disappeared
}

export interface TradableAllowlistStatus {
  /** 行総数 (tradable + disappeared)。 */
  total: number
  /** currently_tradable=true の件数。 */
  tradableCount: number
  /** 最新 last_seen_at (空文字 = 未取得)。 */
  lastSync: string
}

/** allowlist のサマリ (UI のポーリング・進捗表示用)。 */
export async function getTradableAllowlistStatus(db: TradableDb): Promise<TradableAllowlistStatus> {
  const rows = await db
    .select({ currentlyTradable: tradableInstrument.currentlyTradable, lastSeenAt: tradableInstrument.lastSeenAt })
    .from(tradableInstrument)
  let tradableCount = 0
  let lastSync = ''
  for (const r of rows) {
    if (r.currentlyTradable) tradableCount += 1
    if (r.lastSeenAt && r.lastSeenAt > lastSync) lastSync = r.lastSeenAt
  }
  return { total: rows.length, tradableCount, lastSync }
}

/**
 * 全件 (= 1 配列) を一括反映する高水準ヘルパー。逐次保存しない呼び出し側
 * (テスト等) 向け。live の sweep は `upsertTradablePage` を per-page で呼ぶ。
 */
export async function refreshTradableInstruments(
  db: TradableDb,
  fetched: TradableInstrumentEntry[],
  opts: { complete: boolean; nowIso: string },
): Promise<RefreshTradableResult> {
  const { complete, nowIso } = opts
  // 一括なので watermark = nowIso。seen 行は lastSeenAt=nowIso になり、それ未満の
  // 既存 tradable 行が消失。
  const upserted = await upsertTradablePage(db, fetched, nowIso)
  const disappearedSymbols = complete
    ? await finalizeTradableDisappearance(db, nowIso, nowIso)
    : []
  return {
    upserted,
    disappeared: disappearedSymbols.length,
    disappearedSymbols,
    appliedDisappearance: complete,
  }
}
