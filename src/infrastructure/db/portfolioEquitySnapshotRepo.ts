import { and, desc, gte, lte, type SQL } from 'drizzle-orm'
import {
  portfolioEquitySnapshot,
  type PortfolioEquitySnapshotRow,
} from './schema'
import { createDb } from './tradeJournalRepo'

/**
 * Daily snapshot writer / reader for `portfolio_equity_snapshot`.
 * Same-day duplicates are accepted rather than upserted, since the table
 * doubles as an audit trail. Rows load newest-first under `limit` (so
 * `?range=30d` is the most recent 30 days, not the oldest 30 ever recorded),
 * then get reversed back to ASC before returning — the dashboard chart still
 * wants oldest-to-newest order to feed echarts directly.
 */

export interface RecordPortfolioEquitySnapshotPayload {
  /**
   * ISO timestamp the snapshot was taken. Callers should use the same
   * `state.updatedAt` that `rollDaily()` returns so the snapshot timestamp
   * aligns with the DO transition.
   */
  snapshotAt: string
  dailyStartEquityUsd?: number | null
  dailyStartEquityJpy?: number | null
  dailyRealizedPnlUsd?: number | null
  dailyRealizedPnlJpy?: number | null
  /**
   * `dailyRealizedPnl / dailyStartEquity` as a fraction (negative = drawdown).
   * Null when the caller's start equity was 0 or invalid.
   */
  drawdownPct?: number | null
  requestId?: string | null
}

export async function recordPortfolioEquitySnapshot(
  d1: D1Database,
  payload: RecordPortfolioEquitySnapshotPayload,
): Promise<void> {
  const db = createDb(d1)
  await db.insert(portfolioEquitySnapshot).values({
    snapshotAt: payload.snapshotAt,
    dailyStartEquityUsd: payload.dailyStartEquityUsd ?? null,
    dailyStartEquityJpy: payload.dailyStartEquityJpy ?? null,
    dailyRealizedPnlUsd: payload.dailyRealizedPnlUsd ?? null,
    dailyRealizedPnlJpy: payload.dailyRealizedPnlJpy ?? null,
    drawdownPct: payload.drawdownPct ?? null,
    requestId: payload.requestId ?? null,
  })
}

export interface LoadPortfolioEquitySnapshotOptions {
  /** ISO timestamp inclusive lower bound. */
  from?: string
  /** ISO timestamp inclusive upper bound. */
  to?: string
  /**
   * Cap on returned rows. Default 365, max 3650 (~10y of daily snapshots).
   * Values <= 0 or non-finite fall back to the default.
   */
  limit?: number
}

const DEFAULT_LIMIT = 365
const MAX_LIMIT = 3650

export async function loadPortfolioEquitySnapshots(
  d1: D1Database,
  opts: LoadPortfolioEquitySnapshotOptions = {},
): Promise<PortfolioEquitySnapshotRow[]> {
  const db = createDb(d1)
  const conditions: SQL[] = []
  if (opts.from) conditions.push(gte(portfolioEquitySnapshot.snapshotAt, opts.from))
  if (opts.to) conditions.push(lte(portfolioEquitySnapshot.snapshotAt, opts.to))
  let query = db.select().from(portfolioEquitySnapshot).$dynamic()
  if (conditions.length > 0) {
    query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
  }
  const rows = await query
    .orderBy(desc(portfolioEquitySnapshot.snapshotAt), desc(portfolioEquitySnapshot.id))
    .limit(clampLimit(opts.limit))
  // DESC+LIMIT selects the latest N rows; reverse restores the ASC order
  // callers (and the chart) expect without re-querying.
  return rows.reverse()
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(raw), MAX_LIMIT)
}
