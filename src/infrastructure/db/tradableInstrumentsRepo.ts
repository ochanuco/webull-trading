import { eq, inArray } from 'drizzle-orm'
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

/**
 * sweep 結果を allowlist に反映する。
 *
 * - 取得できた銘柄: `currentlyTradable=true`, `lastSeenAt=now` で upsert。
 *   既存行があれば `firstSeenAt` は保持。
 * - **`complete=true` のときだけ**、今回の結果に**含まれない** 既存 tradable 行を
 *   `currentlyTradable=false` に倒す (消失判定)。部分結果 (`complete=false`) で
 *   倒すと誤検知になるのでスキップする。
 * - 物理削除は一切しない。
 */
export async function refreshTradableInstruments(
  db: TradableDb,
  fetched: TradableInstrumentEntry[],
  opts: { complete: boolean; nowIso: string },
): Promise<RefreshTradableResult> {
  const { complete, nowIso } = opts
  const seen = new Map<string, TradableInstrumentEntry>()
  for (const e of fetched) seen.set(e.symbol.toUpperCase(), e)

  const existing = await db.select().from(tradableInstrument)
  const existingBySymbol = new Map(existing.map((r) => [r.symbol.toUpperCase(), r]))

  // 1. seen 銘柄を upsert。
  for (const [symbol, entry] of seen) {
    const prior = existingBySymbol.get(symbol)
    if (prior) {
      await db
        .update(tradableInstrument)
        .set({
          instrumentId: entry.instrumentId,
          name: entry.name,
          currency: entry.currency,
          exchangeCode: entry.exchangeCode,
          currentlyTradable: true,
          lastSeenAt: nowIso,
          updatedAt: nowIso,
        })
        .where(eq(tradableInstrument.symbol, symbol))
    } else {
      await db.insert(tradableInstrument).values({
        symbol,
        instrumentId: entry.instrumentId,
        name: entry.name,
        currency: entry.currency,
        exchangeCode: entry.exchangeCode,
        currentlyTradable: true,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
      })
    }
  }

  // 2. 完走時のみ、消えた既存 tradable 行を false に倒す。
  const disappearedSymbols: string[] = []
  if (complete) {
    for (const row of existing) {
      const key = row.symbol.toUpperCase()
      if (row.currentlyTradable && !seen.has(key)) {
        disappearedSymbols.push(key)
      }
    }
    if (disappearedSymbols.length > 0) {
      await db
        .update(tradableInstrument)
        .set({ currentlyTradable: false, updatedAt: nowIso })
        .where(inArray(tradableInstrument.symbol, disappearedSymbols))
    }
  }

  return {
    upserted: seen.size,
    disappeared: disappearedSymbols.length,
    disappearedSymbols,
    appliedDisappearance: complete,
  }
}
