import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig } from './schema'

export interface GlobalConfigSnapshot {
  dryRun: boolean
  tradingEnabled: boolean
  marketHoursCheck: boolean
  maxOrderNotional: number
  drawdownKillThreshold: number
  staleQuoteMs: number
  gapRejectPct: number
  spreadLimitPctUs: number
  spreadLimitPctJp: number
  bridgeRunMode: string
}

/**
 * Hard defaults used when D1 does not have a `global_config` row yet (i.e.
 * before the initial seed is applied). Matches the previous env-var defaults
 * so existing deployments keep the same behaviour through the cutover.
 */
export const GLOBAL_CONFIG_DEFAULTS: GlobalConfigSnapshot = Object.freeze({
  dryRun: true,
  tradingEnabled: false,
  marketHoursCheck: false,
  maxOrderNotional: 100,
  drawdownKillThreshold: -0.02,
  staleQuoteMs: 15 * 60 * 1_000,
  gapRejectPct: 0.03,
  spreadLimitPctUs: 0.0025,
  spreadLimitPctJp: 0.006,
  bridgeRunMode: 'auto',
})

export async function loadGlobalConfig(
  db: DrizzleD1Database,
): Promise<GlobalConfigSnapshot> {
  const rows = await db.select().from(globalConfig).where(eq(globalConfig.id, 'default')).limit(1)
  const row = rows[0]
  if (!row) return { ...GLOBAL_CONFIG_DEFAULTS }
  return {
    dryRun: row.dryRun,
    tradingEnabled: row.tradingEnabled,
    marketHoursCheck: row.marketHoursCheck,
    maxOrderNotional: row.maxOrderNotional,
    drawdownKillThreshold: row.drawdownKillThreshold,
    staleQuoteMs: row.staleQuoteMs,
    gapRejectPct: row.gapRejectPct,
    spreadLimitPctUs: row.spreadLimitPctUs,
    spreadLimitPctJp: row.spreadLimitPctJp,
    bridgeRunMode: row.bridgeRunMode,
  }
}
