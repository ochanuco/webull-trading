import type { Env } from '../../config/env'
import { createDb } from '../db/tradeJournalRepo'
import {
  finalizeTradableDisappearance,
  upsertTradablePage,
} from '../db/tradableInstrumentsRepo'
import { fetchTradableInstruments } from './tradableInstruments'

/**
 * Sweeps tradable/list and updates the D1 allowlist.
 *
 * A full sweep is rate-limited to ~50 pages (~1 minute), which doesn't fit
 * in one `waitUntil` budget, so this supports chunking + a resume cursor:
 *   - `opts.maxPages` bounds this call's page count (admin runs ~15/call).
 *   - `opts.startCursor` resumes from a prior call's `nextCursor`.
 *   - `watermarkIso` must stay the same fixed, monotonically increasing
 *     timestamp across every chunk of one sweep — that's what lets the final
 *     chunk's disappearance check correctly detect "rows this sweep never
 *     touched" (mark-and-sweep).
 *
 * The cron path (larger budget) omits `maxPages` and completes in one call.
 * A partial fetch (`done=false`) skips the disappearance check so it never
 * corrupts the allowlist off an incomplete sweep.
 */
export interface RefreshTradableAllowlistSummary {
  ok: boolean
  done: boolean
  /** Resume cursor for the next call; null once `done`. */
  nextCursor: string | null
  upserted: number
  pages: number
  /** Only non-zero when `done` — disappearance is only checked on a complete sweep. */
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
  let upserted = 0
  const result = await fetchTradableInstruments(env, {
    ...(opts.startCursor !== undefined ? { startCursor: opts.startCursor } : {}),
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
    onPage: async (entries) => {
      upserted += await upsertTradablePage(db, entries, watermarkIso)
    },
  })

  // No disappearance check on a wholly failed fetch — an empty sweep must not mark everything gone.
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
