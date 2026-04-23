import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig } from './schema'

export interface GlobalConfigSnapshot {
  dryRun: boolean
  tradingEnabled: boolean
  marketHoursCheck: boolean
  /**
   * @deprecated Phase E で通貨別 `maxOrderNotionalUsd` / `maxOrderNotionalJpy`
   * に移行。互換目的でロード時も読み出しているが Risk gate は通貨別値を使う。
   */
  maxOrderNotional: number
  maxOrderNotionalUsd: number
  maxOrderNotionalJpy: number
  /** 総資本 USD。null なら portfolio exposure check を skip。 */
  totalCapitalUsd: number | null
  totalCapitalJpy: number | null
  maxPortfolioExposurePct: number
  drawdownKillThreshold: number
  staleQuoteMs: number
  gapRejectPct: number
  spreadLimitPctUs: number
  spreadLimitPctJp: number
  /** Pullback 戦略のデフォルト rule。#118 で hardcoded → D1 化。 */
  pullbackDefaultStopPct: number
  pullbackDefaultTakeProfitPct: number
  pullbackDefaultTimeStopDays: number
  pullbackDefaultPullbackMax: number
  pullbackDefaultPullbackMin: number
  pullbackDefaultMinReturn50d: number
  pullbackDefaultRequireAboveSma50: boolean
  /** ATR multiplier for vol-adaptive stop。default 2.0。 */
  pullbackDefaultKAtr: number
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
  maxOrderNotionalUsd: 2000,
  maxOrderNotionalJpy: 100000,
  totalCapitalUsd: null,
  totalCapitalJpy: null,
  maxPortfolioExposurePct: 0.6,
  drawdownKillThreshold: -0.02,
  staleQuoteMs: 15 * 60 * 1_000,
  gapRejectPct: 0.03,
  spreadLimitPctUs: 0.0025,
  spreadLimitPctJp: 0.006,
  pullbackDefaultStopPct: -0.04,
  pullbackDefaultTakeProfitPct: 0.07,
  pullbackDefaultTimeStopDays: 10,
  pullbackDefaultPullbackMax: -0.03,
  pullbackDefaultPullbackMin: -0.06,
  pullbackDefaultMinReturn50d: 0.08,
  pullbackDefaultRequireAboveSma50: true,
  pullbackDefaultKAtr: 2.0,
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
    maxOrderNotionalUsd: row.maxOrderNotionalUsd,
    maxOrderNotionalJpy: row.maxOrderNotionalJpy,
    totalCapitalUsd: row.totalCapitalUsd,
    totalCapitalJpy: row.totalCapitalJpy,
    maxPortfolioExposurePct: row.maxPortfolioExposurePct,
    drawdownKillThreshold: row.drawdownKillThreshold,
    staleQuoteMs: row.staleQuoteMs,
    gapRejectPct: row.gapRejectPct,
    spreadLimitPctUs: row.spreadLimitPctUs,
    spreadLimitPctJp: row.spreadLimitPctJp,
    pullbackDefaultStopPct: row.pullbackDefaultStopPct,
    pullbackDefaultTakeProfitPct: row.pullbackDefaultTakeProfitPct,
    pullbackDefaultTimeStopDays: row.pullbackDefaultTimeStopDays,
    pullbackDefaultPullbackMax: row.pullbackDefaultPullbackMax,
    pullbackDefaultPullbackMin: row.pullbackDefaultPullbackMin,
    pullbackDefaultMinReturn50d: row.pullbackDefaultMinReturn50d,
    pullbackDefaultRequireAboveSma50: row.pullbackDefaultRequireAboveSma50,
    pullbackDefaultKAtr: row.pullbackDefaultKAtr,
  }
}
