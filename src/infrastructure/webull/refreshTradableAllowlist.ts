import type { Env } from '../../config/env'
import { createDb } from '../db/tradeJournalRepo'
import {
  finalizeTradableDisappearance,
  upsertTradablePage,
} from '../db/tradableInstrumentsRepo'
import { fetchTradableInstruments } from './tradableInstruments'

/**
 * tradable/list を sweep して allowlist (D1) を更新する (#460)。
 *
 * 全件 sweep は rate limit で ~50 ページ (約1分) かかり、fetch ハンドラの
 * waitUntil 予算で 1 回完走できない。そこで **チャンク分割 + 再開カーソル** に
 * 対応する:
 *   - `opts.maxPages` でこの呼び出しのページ数を区切る (admin は ~15 ページ/回)。
 *   - `opts.startCursor` で前回の続きから再開する。
 *   - `watermarkIso` は sweep 全体で固定の単調増加タイムスタンプ。全チャンクで
 *     同じ値を渡す事で、最終チャンク (done) の消失判定が「この sweep で触られて
 *     いない行」を正しく検出できる (mark-and-sweep)。
 *
 * cron (scheduled handler は予算大) は maxPages 無指定で一括完走する。
 *
 * fetch が途中終了 (done=false) のときは消失判定をスキップするので、部分結果で
 * 既存 allowlist を破壊しない (fail-safe)。
 */
export interface RefreshTradableAllowlistSummary {
  ok: boolean
  /** sweep 全体が hasNext=false まで読み切れたか。 */
  done: boolean
  /** 続きがある場合の次回再開カーソル (done=true なら null)。 */
  nextCursor: string | null
  /** このチャンクで upsert した件数。 */
  upserted: number
  /** このチャンクで取得したページ数。 */
  pages: number
  /** 消失と判定した件数 (done のときのみ非ゼロ)。 */
  disappeared: number
  disappearedSymbols: string[]
  error?: string
}

export async function refreshTradableAllowlist(
  env: Env,
  watermarkIso: string,
  opts: { startCursor?: string; maxPages?: number } = {},
): Promise<RefreshTradableAllowlistSummary> {
  if (!env.DB) {
    return {
      ok: false,
      done: false,
      nextCursor: null,
      upserted: 0,
      pages: 0,
      disappeared: 0,
      disappearedSymbols: [],
      error: 'DB binding 未設定',
    }
  }

  const db = createDb(env.DB)
  // 逐次保存: 各ページ取得直後に upsert (watermark で mark)。途中中断しても
  // 部分結果が残り、表示にも即反映される。
  let upserted = 0
  const result = await fetchTradableInstruments(env, {
    ...(opts.startCursor !== undefined ? { startCursor: opts.startCursor } : {}),
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
    onPage: async (entries) => {
      upserted += await upsertTradablePage(db, entries, watermarkIso)
    },
  })

  // 何も取れず error のときは消失判定をしない (空 sweep で全消失化を防ぐ)。
  if (result.outcome === 'error' && result.instruments.length === 0) {
    return {
      ok: false,
      done: false,
      nextCursor: null,
      upserted,
      pages: result.pages,
      disappeared: 0,
      disappearedSymbols: [],
      error: result.error ?? 'fetch failed',
    }
  }

  // 完走時のみ消失判定 (部分結果では誤検知になるのでスキップ)。
  const done = result.complete
  const disappearedSymbols = done
    ? await finalizeTradableDisappearance(db, watermarkIso, new Date().toISOString())
    : []

  return {
    ok: result.outcome === 'ok',
    done,
    nextCursor: done ? null : (result.nextCursor ?? null),
    upserted,
    pages: result.pages,
    disappeared: disappearedSymbols.length,
    disappearedSymbols,
    ...(result.outcome === 'error' ? { error: result.error ?? 'partial fetch' } : {}),
  }
}
