import type { Env } from '../../config/env'
import { createDb } from '../db/tradeJournalRepo'
import {
  refreshTradableInstruments,
  type RefreshTradableResult,
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

  const result = await fetchTradableInstruments(env)
  // 何も取れず error のときは DB を触らない (空書き込みで全消失判定を防ぐ)。
  if (result.outcome === 'error' && result.instruments.length === 0) {
    return {
      ok: false,
      fetched: 0,
      complete: false,
      pages: result.pages,
      upserted: 0,
      disappeared: 0,
      disappearedSymbols: [],
      error: result.error ?? 'fetch failed',
    }
  }

  const db = createDb(env.DB)
  const applied: RefreshTradableResult = await refreshTradableInstruments(db, result.instruments, {
    complete: result.complete,
    nowIso,
  })

  return {
    ok: result.outcome === 'ok',
    fetched: result.instruments.length,
    complete: result.complete,
    pages: result.pages,
    upserted: applied.upserted,
    disappeared: applied.disappeared,
    disappearedSymbols: applied.disappearedSymbols,
    ...(result.outcome === 'error' ? { error: result.error ?? 'partial fetch' } : {}),
  }
}
