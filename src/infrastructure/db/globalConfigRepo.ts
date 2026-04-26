import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig, type GlobalConfigRow } from './schema'

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
  /** Base risk fraction per trade (0.4% default)。#23 Lane 2。 */
  riskBasePerTradePct: number
  /** drawdown がこの閾値 (負) 未満で size を 0.5× に (-0.05 default)。 */
  riskDdHalfThreshold: number
  /** drawdown がこの閾値 (負) 未満で size を 0 に (-0.10 default)。 */
  riskDdHaltThreshold: number
  /** 同一 bucket の open 合計 notional 上限 = equity × この比率。#23 Lane 3。 */
  bucketExposurePct: number
  /**
   * VIX regime filter (issue #196 3/3)。`^VIX` 最新値がこの閾値超で BUY size を
   * `vixWarningSizeScale` 倍に縮小 (default 25 → x0.5)。
   */
  vixWarningThreshold: number
  /** VIX がこの閾値超で BUY 全停止 (sizeScale=0)。default 30。 */
  vixCriticalThreshold: number
  /** warning 領域の size 倍率。default 0.5。 */
  vixWarningSizeScale: number
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
  riskBasePerTradePct: 0.004,
  riskDdHalfThreshold: -0.05,
  riskDdHaltThreshold: -0.10,
  bucketExposurePct: 0.30,
  vixWarningThreshold: 25.0,
  vixCriticalThreshold: 30.0,
  vixWarningSizeScale: 0.5,
})

export async function loadGlobalConfig(
  db: DrizzleD1Database,
  requestId?: string,
): Promise<GlobalConfigSnapshot> {
  // VIX 列 (vix_warning_threshold / vix_critical_threshold / vix_warning_size_scale)
  // は migration 0015 で追加。pre-0015 deploy / ALTER 適用前の D1 では `select` 自体が
  // SQL レベルで失敗するため、`row.vixXxx ?? defaults` の null fallback では救えない。
  // ここでは query 境界を try/catch で囲み、「missing column」を文字列マッチで検知して
  // defaults を返す段階デプロイ救済を行う (POC 用フォールバック)。それ以外のエラーは
  // 上に再 throw して fail-closed を維持する。
  //
  // Regex は **schema-missing 限定**で組む: `vix_` 単独マッチを許すと非スキーマ
  // 障害メッセージに `vix_` が偶然含まれただけで fail-open 化するリスクがあるため、
  // SQLite 系の `no such column: vix_*` か、`vix_<col> not found / does not exist /
  // unknown column` 形式に絞る (CodeRabbit 2nd round 指摘)。
  let rows: GlobalConfigRow[]
  try {
    rows = await db.select().from(globalConfig).where(eq(globalConfig.id, 'default')).limit(1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isMissingVixColumn =
      /no such column:\s*vix_/i.test(message) ||
      /vix_[a-z_]*\s+(not found|does not exist|unknown column)/i.test(message)
    if (isMissingVixColumn) {
      console.warn(
        JSON.stringify({
          event: 'global_config_pre_0015_fallback',
          requestId: requestId ?? null,
          message,
        }),
      )
      // 段階デプロイ救済: VIX 3 列だけ defaults で埋め、他の列は legacy row から
      // 読み出す。`{ ...GLOBAL_CONFIG_DEFAULTS }` で全部上書きすると
      // `tradingEnabled: false` のような既存運用値が `tradingEnabled: true` (default)
      // で踏み潰されるリスクがある。明示的に vix_ 以外の列だけを select し、
      // defaults と shallow-merge する。
      try {
        const legacyRows = await db
          .select({
            id: globalConfig.id,
            dryRun: globalConfig.dryRun,
            tradingEnabled: globalConfig.tradingEnabled,
            marketHoursCheck: globalConfig.marketHoursCheck,
            maxOrderNotional: globalConfig.maxOrderNotional,
            maxOrderNotionalUsd: globalConfig.maxOrderNotionalUsd,
            maxOrderNotionalJpy: globalConfig.maxOrderNotionalJpy,
            totalCapitalUsd: globalConfig.totalCapitalUsd,
            totalCapitalJpy: globalConfig.totalCapitalJpy,
            maxPortfolioExposurePct: globalConfig.maxPortfolioExposurePct,
            drawdownKillThreshold: globalConfig.drawdownKillThreshold,
            staleQuoteMs: globalConfig.staleQuoteMs,
            gapRejectPct: globalConfig.gapRejectPct,
            spreadLimitPctUs: globalConfig.spreadLimitPctUs,
            spreadLimitPctJp: globalConfig.spreadLimitPctJp,
            pullbackDefaultStopPct: globalConfig.pullbackDefaultStopPct,
            pullbackDefaultTakeProfitPct: globalConfig.pullbackDefaultTakeProfitPct,
            pullbackDefaultTimeStopDays: globalConfig.pullbackDefaultTimeStopDays,
            pullbackDefaultPullbackMax: globalConfig.pullbackDefaultPullbackMax,
            pullbackDefaultPullbackMin: globalConfig.pullbackDefaultPullbackMin,
            pullbackDefaultMinReturn50d: globalConfig.pullbackDefaultMinReturn50d,
            pullbackDefaultRequireAboveSma50: globalConfig.pullbackDefaultRequireAboveSma50,
            pullbackDefaultKAtr: globalConfig.pullbackDefaultKAtr,
            riskBasePerTradePct: globalConfig.riskBasePerTradePct,
            riskDdHalfThreshold: globalConfig.riskDdHalfThreshold,
            riskDdHaltThreshold: globalConfig.riskDdHaltThreshold,
            bucketExposurePct: globalConfig.bucketExposurePct,
          })
          .from(globalConfig)
          .where(eq(globalConfig.id, 'default'))
          .limit(1)
        const legacyRow = legacyRows[0]
        if (legacyRow) {
          return {
            dryRun: legacyRow.dryRun,
            tradingEnabled: legacyRow.tradingEnabled,
            marketHoursCheck: legacyRow.marketHoursCheck,
            maxOrderNotional: legacyRow.maxOrderNotional,
            maxOrderNotionalUsd: legacyRow.maxOrderNotionalUsd,
            maxOrderNotionalJpy: legacyRow.maxOrderNotionalJpy,
            totalCapitalUsd: legacyRow.totalCapitalUsd,
            totalCapitalJpy: legacyRow.totalCapitalJpy,
            maxPortfolioExposurePct: legacyRow.maxPortfolioExposurePct,
            drawdownKillThreshold: legacyRow.drawdownKillThreshold,
            staleQuoteMs: legacyRow.staleQuoteMs,
            gapRejectPct: legacyRow.gapRejectPct,
            spreadLimitPctUs: legacyRow.spreadLimitPctUs,
            spreadLimitPctJp: legacyRow.spreadLimitPctJp,
            pullbackDefaultStopPct: legacyRow.pullbackDefaultStopPct,
            pullbackDefaultTakeProfitPct: legacyRow.pullbackDefaultTakeProfitPct,
            pullbackDefaultTimeStopDays: legacyRow.pullbackDefaultTimeStopDays,
            pullbackDefaultPullbackMax: legacyRow.pullbackDefaultPullbackMax,
            pullbackDefaultPullbackMin: legacyRow.pullbackDefaultPullbackMin,
            pullbackDefaultMinReturn50d: legacyRow.pullbackDefaultMinReturn50d,
            pullbackDefaultRequireAboveSma50: legacyRow.pullbackDefaultRequireAboveSma50,
            pullbackDefaultKAtr: legacyRow.pullbackDefaultKAtr,
            riskBasePerTradePct: legacyRow.riskBasePerTradePct,
            riskDdHalfThreshold: legacyRow.riskDdHalfThreshold,
            riskDdHaltThreshold: legacyRow.riskDdHaltThreshold,
            bucketExposurePct: legacyRow.bucketExposurePct,
            // VIX 3 項目だけ defaults (列が存在しないので legacy row には無い)
            vixWarningThreshold: GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
            vixCriticalThreshold: GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
            vixWarningSizeScale: GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
          }
        }
      } catch (legacyError) {
        // legacy fetch も失敗 → 想定外の double failure。ここまで来たら全 defaults
        // で fail-open を選ぶ (cron 全停止より既知 default で動かす)。
        console.warn(
          JSON.stringify({
            event: 'global_config_legacy_load_failed',
            requestId: requestId ?? null,
            message: legacyError instanceof Error ? legacyError.message : String(legacyError),
          }),
        )
      }
      // legacy row なし or legacy fetch 失敗 → 全 defaults
      return { ...GLOBAL_CONFIG_DEFAULTS }
    }
    throw error
  }
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
    riskBasePerTradePct: row.riskBasePerTradePct,
    riskDdHalfThreshold: row.riskDdHalfThreshold,
    riskDdHaltThreshold: row.riskDdHaltThreshold,
    bucketExposurePct: row.bucketExposurePct,
    // VIX 列は 0015 で追加。古い D1 (snapshot 取得失敗 / ALTER 直前 race) では
    // undefined になり得るため、defaults へ畳む (snapshot 経由 read だが safety)。
    // schema 自体の欠落は上の try/catch で defaults fallback する。
    vixWarningThreshold:
      row.vixWarningThreshold ?? GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
    vixCriticalThreshold:
      row.vixCriticalThreshold ?? GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
    vixWarningSizeScale:
      row.vixWarningSizeScale ?? GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
  }
}
