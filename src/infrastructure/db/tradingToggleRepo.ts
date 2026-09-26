import { eq } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig, tradingToggleHistory } from './schema'

export interface TradingToggleResult {
  before: boolean | null
  after: boolean
  historyId: number | null
}

/**
 * Applies a kill-switch toggle: reads the before value, updates
 * `global_config.trading_enabled`, and appends a `trading_toggle_history`
 * row. Throws on any failure instead of swallowing it — a write that fails
 * must not report success. Always appends history, even for a same-value
 * toggle, so a no-op press still shows up in the audit trail.
 */
export async function applyTradingToggle(
  db: DrizzleD1Database,
  args: {
    enabled: boolean
    actor: string | null
    reason: string
    requestId: string | null
    now?: () => Date
  },
): Promise<TradingToggleResult> {
  const now = (args.now ?? (() => new Date()))()
  const nowIso = now.toISOString()

  const rows = await db
    .select({ tradingEnabled: globalConfig.tradingEnabled })
    .from(globalConfig)
    .where(eq(globalConfig.id, 'default'))
    .limit(1)
  const before: boolean | null = rows[0] ? rows[0].tradingEnabled : null

  if (rows[0]) {
    await db
      .update(globalConfig)
      .set({ tradingEnabled: args.enabled, updatedAt: nowIso })
      .where(eq(globalConfig.id, 'default'))
  } else {
    // First-ever call: seed the row here instead of requiring it be
    // pre-seeded, so toggling isn't blocked on manual DB setup.
    await db.insert(globalConfig).values({
      id: 'default',
      tradingEnabled: args.enabled,
      updatedAt: nowIso,
    })
  }

  const inserted = await db
    .insert(tradingToggleHistory)
    .values({
      timestamp: nowIso,
      actor: args.actor,
      before,
      after: args.enabled,
      reason: args.reason,
      requestId: args.requestId,
    })
    .returning({ id: tradingToggleHistory.id })

  return {
    before,
    after: args.enabled,
    historyId: inserted[0]?.id ?? null,
  }
}

/** Thin wrapper so callers don't need to import drizzle directly. */
export function createTradingToggleDb(d1: D1Database): DrizzleD1Database {
  return drizzle(d1)
}
