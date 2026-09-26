import { eq } from 'drizzle-orm'
import { configStateSnapshot } from '../../infrastructure/db/schema'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import type { Notifier } from '../../infrastructure/notification/Notifier'
import type { QuoteFeedError } from './quoteScheduler'

const QUOTE_FEED_STREAK_KEY = 'quote_feed_failure_streak'
/** Full `runQuoteFeed()` promise rejection has no per-symbol/category breakdown. */
export const QUOTE_FEED_ALL_KEY = '__all__'

export interface QuoteFeedFailureItem {
  /** `symbol` when set, else `category:${category}`, else `__all__` for a full-run rejection. */
  key: string
  /** Rendered for the crossing notification's 詳細 line. */
  display: string
}

export interface StreakUpdateResult {
  /** Next streak map to persist — keys not in `failingKeys` are dropped (reset), not carried forward. */
  next: Record<string, number>
  /** Keys whose streak count reached exactly 3 this tick. */
  crossedKeys: string[]
}

const CROSSING_THRESHOLD = 3

export function updateFailureStreak(prev: Record<string, number>, failingKeys: string[]): StreakUpdateResult {
  const next: Record<string, number> = {}
  const crossedKeys: string[] = []
  for (const key of new Set(failingKeys)) {
    const count = (prev[key] ?? 0) + 1
    next[key] = count
    if (count === CROSSING_THRESHOLD) crossedKeys.push(key)
  }
  return { next, crossedKeys }
}

export function toQuoteFeedFailureItems(errors: QuoteFeedError[]): QuoteFeedFailureItem[] {
  return errors.map((e) => ({
    key: e.symbol ?? `category:${e.category}`,
    display: e.symbol ? e.message : `[${e.category}] ${e.message}`,
  }))
}

function isStreakMap(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'number')
}

async function loadFailureStreak(db: D1Database): Promise<Record<string, number>> {
  const drizzle = createDb(db)
  const rows = await drizzle
    .select({ value: configStateSnapshot.value })
    .from(configStateSnapshot)
    .where(eq(configStateSnapshot.key, QUOTE_FEED_STREAK_KEY))
  if (rows.length === 0) return {}
  const parsed = JSON.parse(rows[0]!.value) as unknown
  return isStreakMap(parsed) ? parsed : {}
}

async function persistFailureStreak(
  db: D1Database,
  next: Record<string, number>,
  now: Date,
  requestId: string | undefined,
): Promise<void> {
  const drizzle = createDb(db)
  await drizzle.delete(configStateSnapshot).where(eq(configStateSnapshot.key, QUOTE_FEED_STREAK_KEY))
  await drizzle.insert(configStateSnapshot).values({
    key: QUOTE_FEED_STREAK_KEY,
    value: JSON.stringify(next),
    snapshotAt: now.toISOString(),
    requestId: requestId ?? null,
  })
}

function notifyItems(
  notifier: Notifier,
  items: QuoteFeedFailureItem[],
  cause: 'quote_feed_partial' | 'quote_feed',
): Promise<void> {
  const summaryMsg = items
    .slice(0, 3)
    .map((i) => i.display)
    .join(' | ')
  const tail = items.length > 3 ? ` (+${items.length - 3} 件)` : ''
  return notifier
    .notify({
      type: 'ERROR',
      message: `${summaryMsg}${tail}`,
      cause,
      severity: 'warning',
    })
    .catch(() => undefined)
}

export interface ReconcileQuoteFeedFailureStreakArgs {
  db: D1Database | undefined
  notifier: Notifier
  items: QuoteFeedFailureItem[]
  cause: 'quote_feed_partial' | 'quote_feed'
  requestId?: string
  now?: Date
}

/**
 * No `db` binding can't track streaks at all, so it fails open (notifies
 * every failing tick) rather than going silent — same trade-off as a D1
 * read/write throw below.
 */
export async function reconcileQuoteFeedFailureStreak(args: ReconcileQuoteFeedFailureStreakArgs): Promise<void> {
  const now = args.now ?? new Date()
  const failingKeys = args.items.map((i) => i.key)

  if (!args.db) {
    if (args.items.length > 0) await notifyItems(args.notifier, args.items, args.cause)
    return
  }

  try {
    const prev = await loadFailureStreak(args.db)
    const { next, crossedKeys } = updateFailureStreak(prev, failingKeys)
    if (Object.keys(prev).length > 0 || Object.keys(next).length > 0) {
      await persistFailureStreak(args.db, next, now, args.requestId)
    }
    if (crossedKeys.length > 0) {
      const crossed = new Set(crossedKeys)
      await notifyItems(
        args.notifier,
        args.items.filter((i) => crossed.has(i.key)),
        args.cause,
      )
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'quote_feed_failure_streak_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    if (args.items.length > 0) await notifyItems(args.notifier, args.items, args.cause)
  }
}
