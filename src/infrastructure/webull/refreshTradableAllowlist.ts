import type { Env } from '../../config/env'
import { createDb } from '../db/tradeJournalRepo'
import {
  finalizeTradableDisappearance,
  upsertTradablePage,
} from '../db/tradableInstrumentsRepo'
import { fetchTradableInstruments } from './tradableInstruments'

/**
 * tradable/list を全件 sweep して allowlist (D1) を更新する (#460)。
 * cron (日次) と admin の手動リフレッシュの両方から呼ばれる。
 *
 * fetch が部分結果 (complete=false) のときは消失判定をスキップするので、
 * rate limit 等で途中打ち切りになっても既存 allowlist を破壊しない (fail-safe)。
 */
export interface RefreshTradableAllowlistSummary {
  ok: boolean
  fetched: number
  complete: boolean
  pages: number
  upserted: number
  disappeared: number
  disappearedSymbols: string[]
  error?: string
}

export async function refreshTradableAllowlist(
  env: Env,
  nowIso: string,
): Promise<RefreshTradableAllowlistSummary> {
  if (!env.DB) {
    return {
      ok: false,
      fetched: 0,
      complete: false,
      pages: 0,
      upserted: 0,
      disappeared: 0,
      disappearedSymbols: [],
      error: 'DB binding 未設定',
    }
  }

  const db = createDb(env.DB)
  // 逐次保存: 各ページ取得直後に upsert する。全件 (~50 ページ・rate limit で
  // 約1分) を待たずに表示へ反映でき、途中中断しても部分結果が残る。
  let upserted = 0
  const result = await fetchTradableInstruments(env, {
    onPage: async (entries) => {
      upserted += await upsertTradablePage(db, entries, nowIso)
    },
  })

  // 何も取れず error のときは消失判定をしない (空 sweep で全消失化を防ぐ)。
  if (result.outcome === 'error' && result.instruments.length === 0) {
    return {
      ok: false,
      fetched: 0,
      complete: false,
      pages: result.pages,
      upserted,
      disappeared: 0,
      disappearedSymbols: [],
      error: result.error ?? 'fetch failed',
    }
  }

  // 完走時のみ消失判定 (部分結果では誤検知になるのでスキップ)。
  const seen = new Set(result.instruments.map((e) => e.symbol.toUpperCase()))
  const disappearedSymbols = result.complete
    ? await finalizeTradableDisappearance(db, seen, nowIso)
    : []

  return {
    ok: result.outcome === 'ok',
    fetched: result.instruments.length,
    complete: result.complete,
    pages: result.pages,
    upserted,
    disappeared: disappearedSymbols.length,
    disappearedSymbols,
    ...(result.outcome === 'error' ? { error: result.error ?? 'partial fetch' } : {}),
  }
}
