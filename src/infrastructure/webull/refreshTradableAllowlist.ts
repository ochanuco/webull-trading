import type { Env } from '../../config/env'
import { createDb } from '../db/tradeJournalRepo'
import {
  finalizeTradableDisappearance,
  upsertTradablePage,
} from '../db/tradableInstrumentsRepo'
import { fetchTradableInstruments } from './tradableInstruments'

/**
 * Sweeps tradable/list and updates the D1 allowlist. Chunked via
 * `opts.maxPages` / `opts.startCursor` because a full sweep (~50 pages)
 * doesn't fit in one Workers `waitUntil` budget; the cron path (larger
 * budget) omits `maxPages`. `watermarkIso` must stay identical across every
 * chunk of one sweep — the mark-and-sweep disappearance check relies on it.
 */
export interface RefreshTradableAllowlistSummary {
  ok: boolean
  done: boolean
  nextCursor: string | null
  upserted: number
  pages: number
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
