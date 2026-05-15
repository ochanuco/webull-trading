import { eq } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig, tradingToggleHistory } from './schema'

export interface TradingToggleResult {
  before: boolean | null
  after: boolean
  historyId: number | null
}

/**
 * Apply a kill-switch toggle (issue #276)。
 *
 * 1. `global_config.trading_enabled` の現在値を読む (before snapshot)
 * 2. `enabled` で上書き UPDATE
 * 3. `trading_toggle_history` に append (timestamp / actor / before / after /
 *    reason / requestId)
 *
 * Returns the before/after snapshot for log emission. Throws if D1 binding is
 * missing or the UPDATE fails — fail-closed (toggle が DB に書けなかったのに
 * 200 返しちゃう sit を避ける)。
 *
 * No-op detection は呼出側に任せる: same-value toggle でも history は残す
 * (operator が「無駄な ON ボタン押した」を audit で見たいケースもあるため)。
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
    // 初回 (= row 未 seed)。`/admin/trading/toggle` が seed も担当することで
    // 「runtime に DB 未投入で toggle 不能」を回避。`updatedAt` 必須 / 他列は
    // schema default (dry_run=true, trading_enabled は arg, など) に任せる。
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

/**
 * Wraps a raw `D1Database` binding into a drizzle instance suitable for
 * `applyTradingToggle`. Kept as a thin helper so callers don't need to import
 * drizzle directly.
 */
export function createTradingToggleDb(d1: D1Database): DrizzleD1Database {
  return drizzle(d1)
}
