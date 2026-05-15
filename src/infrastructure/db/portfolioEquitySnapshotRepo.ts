import { and, asc, gte, lte, type SQL } from 'drizzle-orm'
import {
  portfolioEquitySnapshot,
  type PortfolioEquitySnapshotRow,
} from './schema'
import { createDb } from './tradeJournalRepo'

/**
 * Daily snapshot writer / reader for `portfolio_equity_snapshot`. Wraps the
 * raw `D1Database` so callers don't repeat the drizzle bootstrap. Each
 * `recordPortfolioEquitySnapshot` is intended to be called once per
 * `PortfolioStateDO.rollDaily()` execution (manual `/admin/portfolio/roll-daily`
 * or the EOD `runPortfolioRoll` cron); same-day duplicates are intentionally
 * accepted because the table doubles as an audit trail.
 *
 * `loadPortfolioEquitySnapshots` returns rows in ASC order so the dashboard
 * chart can feed echarts directly without a client-side reverse.
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
   * `dailyRealizedPnl / dailyStartEquity` (fraction、負が drawdown)。
   * 計算側で start equity が 0 / 無効なら null を渡す。
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
  return await query
    .orderBy(asc(portfolioEquitySnapshot.snapshotAt), asc(portfolioEquitySnapshot.id))
    .limit(clampLimit(opts.limit))
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(raw), MAX_LIMIT)
}
