import type { AtrBaselineMode } from '../../trading/strategy/indicators'
import { eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { globalConfig, type GlobalConfigRow } from './schema'

export interface GlobalConfigSnapshot {
  dryRun: boolean
  tradingEnabled: boolean
  marketHoursCheck: boolean
  /**
   * True skips the strategy cron outside the open-30min-before-to-close
   * window (per market). Default false = evaluate at all times.
   */
  sessionWindowGateEnabled: boolean
  /**
   * @deprecated Superseded by the currency-specific `maxOrderNotionalUsd` /
   * `maxOrderNotionalJpy`. Still loaded for compatibility, but the Risk
   * gate reads the currency-specific fields.
   */
  maxOrderNotional: number
  maxOrderNotionalUsd: number
  maxOrderNotionalJpy: number
  /** Null skips the portfolio exposure check. */
  totalCapitalUsd: number | null
  totalCapitalJpy: number | null
  maxPortfolioExposurePct: number
  drawdownKillThreshold: number
  staleQuoteMs: number
  gapRejectPct: number
  spreadLimitPctUs: number
  spreadLimitPctJp: number
  pullbackDefaultStopPct: number
  pullbackDefaultTakeProfitPct: number
  pullbackDefaultTimeStopDays: number
  pullbackDefaultPullbackMax: number
  pullbackDefaultPullbackMin: number
  pullbackDefaultMinReturn50d: number
  pullbackDefaultRequireAboveSma50: boolean
  /** ATR multiplier for vol-adaptive stop. Default 2.0. */
  pullbackDefaultKAtr: number
  /** BUY skipped when the SMA50 upside deviation exceeds this ratio. */
  pullbackDefaultMaxSma50DeviationPct: number
  /** BUY skipped when atr20/baselineAtr20 exceeds this ratio. */
  pullbackDefaultMaxAtrRatio: number
  /** Stop width cap = `|price * takeProfitPct| * this`. 0 disables the cap. */
  pullbackDefaultMaxStopToTpRatio: number
  /** Estimated trading cost rate. 0 keeps gross PnL unchanged. */
  feePctOfNotional: number
  /** Estimated fixed cost per order, in the symbol's currency. */
  feeFixedPerOrder: number
  /** How the baseline ATR is built. An invalid DB value falls back to 'percentile'. */
  atrBaselineMode: AtrBaselineMode
  /** Base risk fraction per trade. Default 0.4%. */
  riskBasePerTradePct: number
  /** Size scaled to 0.5x once drawdown drops below this (negative) threshold. */
  riskDdHalfThreshold: number
  /** Size scaled to 0 once drawdown drops below this (negative) threshold. */
  riskDdHaltThreshold: number
  /** BUY size scaled by `vixWarningSizeScale` once `^VIX` exceeds this threshold. */
  vixWarningThreshold: number
  /** BUY halted entirely (sizeScale=0) once VIX exceeds this threshold. */
  vixCriticalThreshold: number
  vixWarningSizeScale: number
  /**
   * Cash-fallback auto-BUY for the conditional allocation layer. Default
   * false (fail-closed): while off, the gate only evaluates and displays,
   * never places an automatic BUY into the fallback symbol.
   */
  cashFallbackOrdersEnabled: boolean
  /**
   * Demand-linked auto-SELL of cash-fallback holdings. 'off' (default) /
   * 'observe' (log only) / 'enforce'. An out-of-enum DB value falls back to
   * 'off' (gate disabled is the safe side). Toggled independently of the
   * BUY side (`cashFallbackOrdersEnabled`).
   */
  cashFallbackSellMode: 'off' | 'observe' | 'enforce'
  /**
   * Pair-regime layer. 'off' (default) / 'observe' (log only) / 'enforce'.
   * An out-of-enum DB value falls back to 'off'.
   */
  pairRegimeMode: 'off' | 'observe' | 'enforce'
  /** Schmitt-trigger thresholds (1x proxy basis). Ordering is validated on the pairRegime side. */
  pairRegimeThetaBullEnter: number
  pairRegimeThetaBullExit: number
  pairRegimeThetaBearEnter: number
  pairRegimeThetaBearExit: number
  /**
   * News-shock gate. 'off' (default) / 'observe' (trace only) / 'enforce'.
   * An out-of-enum DB value falls back to 'off', same convention as
   * `pairRegimeMode`.
   */
  newsShockMode: 'off' | 'observe' | 'enforce'
  /** Warning once (recent max / baseline median) exceeds this ratio. Default 2.3 (GDELT 12mo p90). */
  newsShockWarnRatio: number
  /** Critical once the ratio exceeds this and the tone condition is also met. Default 4.4 (p99). */
  newsShockBlockRatio: number
  newsShockWarnSizeScale: number
  /** Tone drop (baselineTone - latestTone) required for a critical verdict. */
  newsShockToneDropThreshold: number
  /** True (default) requires the tone-drop condition in addition to the ratio for critical. */
  newsShockRequireTone: boolean
  /** Trailing window (days) for the baseline median population. */
  newsShockBaselineDays: number
  /** Below this sample count, the baseline is 'unknown' (insufficient_baseline). */
  newsShockMinSamples: number
  /** Window (minutes) for the ratio's numerator (recent max). */
  newsShockWindowMin: number
  /** Latest observation older than this (minutes) is treated as unknown (unavailable). */
  newsShockMaxAgeMin: number
  /**
   * Fail-open/closed switch for when the attention observation feed (GDELT
   * producer) is unavailable or insufficient. 'fail_open' (default) |
   * 'block_buy' (operator escape hatch).
   */
  attentionStalePolicy: 'fail_open' | 'block_buy'
  /**
   * Extended-hours (pre-market) gate: folds `extended_hours_observation`'s
   * same-day WARNING/STOP_AT_OPEN_CANDIDATE into BUY sizing. 'off' (default)
   * / 'observe' (trace only) / 'enforce'. An out-of-enum DB value falls
   * back to 'off', same convention as `newsShockMode`.
   */
  extendedHoursGateMode: 'off' | 'observe' | 'enforce'
}

const ATR_BASELINE_MODES = ['overlap', 'exclude-recent', 'percentile'] as const

/** An out-of-enum value falls back to 'percentile', the empirically best default. */
function sanitizeAtrBaselineMode(value: string | null | undefined): AtrBaselineMode {
  return (ATR_BASELINE_MODES as readonly string[]).includes(value ?? '')
    ? (value as AtrBaselineMode)
    : 'percentile'
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
  sessionWindowGateEnabled: false,
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
  pullbackDefaultMaxSma50DeviationPct: 0.6,
  pullbackDefaultMaxAtrRatio: 1.5,
  pullbackDefaultMaxStopToTpRatio: 2.0,
  feePctOfNotional: 0,
  feeFixedPerOrder: 0,
  atrBaselineMode: 'percentile',
  riskBasePerTradePct: 0.004,
  riskDdHalfThreshold: -0.05,
  riskDdHaltThreshold: -0.10,
  vixWarningThreshold: 25.0,
  vixCriticalThreshold: 30.0,
  vixWarningSizeScale: 0.5,
  cashFallbackOrdersEnabled: false,
  cashFallbackSellMode: 'off',
  pairRegimeMode: 'off',
  pairRegimeThetaBullEnter: 0.03,
  pairRegimeThetaBullExit: 0.01,
  pairRegimeThetaBearEnter: -0.04,
  pairRegimeThetaBearExit: -0.015,
  newsShockMode: 'off',
  newsShockWarnRatio: 2.3,
  newsShockBlockRatio: 4.4,
  newsShockWarnSizeScale: 0.5,
  newsShockToneDropThreshold: 1.5,
  newsShockRequireTone: true,
  newsShockBaselineDays: 7,
  newsShockMinSamples: 200,
  newsShockWindowMin: 120,
  newsShockMaxAgeMin: 90,
  attentionStalePolicy: 'fail_open',
  extendedHoursGateMode: 'off',
})

/**
 * Dashboard overview panel visibility, stored as CSV in
 * `global_config.overview_panels`. Display-only: never routed through
 * `GlobalConfigSnapshot` or the cron path, read/written by the dashboard
 * alone.
 *
 * A saved CSV is respected as-is rather than reconciled against this
 * default — a panel added here later stays off for operators until they
 * next save the settings form.
 */
const OVERVIEW_PANELS_DEFAULT = 'status,positions,kpi,equity,composition,recent'

export async function loadOverviewPanelsCsv(db: DrizzleD1Database): Promise<string> {
  try {
    const rows = await db
      .select({ value: globalConfig.overviewPanels })
      .from(globalConfig)
      .where(eq(globalConfig.id, 'default'))
      .limit(1)
    const v = rows[0]?.value
    return typeof v === 'string' && v.trim().length > 0 ? v : OVERVIEW_PANELS_DEFAULT
  } catch {
    // Missing migration or any D1 error falls back to show-all, so the
    // overview still renders.
    return OVERVIEW_PANELS_DEFAULT
  }
}

/**
 * Upserts `overview_panels`, creating the row if unseeded (no primary-key
 * collision under concurrent POSTs). Reads the previous value and writes
 * the new one inside a single D1 batch (one transaction), so the audit
 * log's `before` can't drift from the actual prior state under a
 * concurrent update. Returns that `before` value.
 */
export async function setOverviewPanels(
  db: DrizzleD1Database,
  csv: string,
  nowIso: string,
): Promise<{ before: string }> {
  const results = await db.batch([
    db
      .select({ value: globalConfig.overviewPanels })
      .from(globalConfig)
      .where(eq(globalConfig.id, 'default'))
      .limit(1),
    db
      .insert(globalConfig)
      .values({ id: 'default', overviewPanels: csv, updatedAt: nowIso })
      .onConflictDoUpdate({
        target: globalConfig.id,
        set: { overviewPanels: csv, updatedAt: nowIso },
      }),
  ])
  const beforeRows = results[0] as Array<{ value: string | null }>
  const prev = beforeRows[0]?.value
  return { before: typeof prev === 'string' && prev.trim().length > 0 ? prev : OVERVIEW_PANELS_DEFAULT }
}

/**
 * Application-level validation for VIX values, filling in for the DB CHECK
 * constraints that the ALTER-TABLE-only migration doesn't carry (see
 * schema.ts). A violation falls back to defaults rather than letting cron
 * run on an out-of-range value, and logs the violating field/value/expected
 * range so it's visible in operation.
 */
function validateVixConfig(
  config: GlobalConfigSnapshot,
  requestId: string | undefined,
): GlobalConfigSnapshot {
  const violations: Array<{ field: string; value: unknown; expected: string }> = []
  const { vixWarningThreshold, vixCriticalThreshold, vixWarningSizeScale } = config

  if (!(vixWarningThreshold > 0 && vixWarningThreshold <= 200)) {
    violations.push({
      field: 'vixWarningThreshold',
      value: vixWarningThreshold,
      expected: '>0 and <=200',
    })
  }
  if (!(vixCriticalThreshold > 0 && vixCriticalThreshold <= 200)) {
    violations.push({
      field: 'vixCriticalThreshold',
      value: vixCriticalThreshold,
      expected: '>0 and <=200',
    })
  }
  if (vixWarningThreshold > vixCriticalThreshold) {
    violations.push({
      field: 'vixWarningThreshold/vixCriticalThreshold',
      value: { warning: vixWarningThreshold, critical: vixCriticalThreshold },
      expected: 'warning <= critical',
    })
  }
  if (!(vixWarningSizeScale >= 0 && vixWarningSizeScale <= 1)) {
    violations.push({
      field: 'vixWarningSizeScale',
      value: vixWarningSizeScale,
      expected: '>=0 and <=1',
    })
  }

  if (violations.length > 0) {
    console.warn(
      JSON.stringify({
        event: 'global_config_vix_validation_failed',
        requestId: requestId ?? null,
        violations,
      }),
    )
    return {
      ...config,
      vixWarningThreshold: GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
      vixCriticalThreshold: GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
      vixWarningSizeScale: GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
    }
  }

  return config
}

/**
 * Same application-level validation as `validateVixConfig`, for news-shock
 * config: same ALTER-TABLE-only migration gap, so range/ordering is
 * checked here. Enum fields (`newsShockMode` / `attentionStalePolicy`) are
 * out of scope — those are sanitized inline where `loadGlobalConfig` maps
 * the row, same as `pairRegimeMode`. A violation replaces only the
 * offending numeric fields with defaults; mode fields are untouched here.
 */
function validateNewsShockConfig(
  config: GlobalConfigSnapshot,
  requestId: string | undefined,
): GlobalConfigSnapshot {
  const violations: Array<{ field: string; value: unknown; expected: string }> = []
  const {
    newsShockWarnRatio,
    newsShockBlockRatio,
    newsShockWarnSizeScale,
    newsShockToneDropThreshold,
    newsShockBaselineDays,
    newsShockMinSamples,
    newsShockWindowMin,
    newsShockMaxAgeMin,
  } = config

  if (!(newsShockWarnRatio > 0 && newsShockWarnRatio <= 100)) {
    violations.push({ field: 'newsShockWarnRatio', value: newsShockWarnRatio, expected: '>0 and <=100' })
  }
  if (!(newsShockBlockRatio > 0 && newsShockBlockRatio <= 100)) {
    violations.push({ field: 'newsShockBlockRatio', value: newsShockBlockRatio, expected: '>0 and <=100' })
  }
  if (newsShockWarnRatio > newsShockBlockRatio) {
    violations.push({
      field: 'newsShockWarnRatio/newsShockBlockRatio',
      value: { warn: newsShockWarnRatio, block: newsShockBlockRatio },
      expected: 'warn <= block',
    })
  }
  if (!(newsShockWarnSizeScale >= 0 && newsShockWarnSizeScale <= 1)) {
    violations.push({
      field: 'newsShockWarnSizeScale',
      value: newsShockWarnSizeScale,
      expected: '>=0 and <=1',
    })
  }
  if (!(newsShockToneDropThreshold >= 0 && newsShockToneDropThreshold <= 100)) {
    violations.push({
      field: 'newsShockToneDropThreshold',
      value: newsShockToneDropThreshold,
      expected: '>=0 and <=100',
    })
  }
  if (!(Number.isInteger(newsShockBaselineDays) && newsShockBaselineDays > 0 && newsShockBaselineDays <= 365)) {
    violations.push({ field: 'newsShockBaselineDays', value: newsShockBaselineDays, expected: 'integer >0 and <=365' })
  }
  if (!(Number.isInteger(newsShockMinSamples) && newsShockMinSamples > 0 && newsShockMinSamples <= 1_000_000)) {
    violations.push({ field: 'newsShockMinSamples', value: newsShockMinSamples, expected: 'integer >0 and <=1000000' })
  }
  if (!(Number.isInteger(newsShockWindowMin) && newsShockWindowMin > 0 && newsShockWindowMin <= 10_080)) {
    violations.push({ field: 'newsShockWindowMin', value: newsShockWindowMin, expected: 'integer >0 and <=10080 (1 week in minutes)' })
  }
  if (!(Number.isInteger(newsShockMaxAgeMin) && newsShockMaxAgeMin > 0 && newsShockMaxAgeMin <= 10_080)) {
    violations.push({ field: 'newsShockMaxAgeMin', value: newsShockMaxAgeMin, expected: 'integer >0 and <=10080 (1 week in minutes)' })
  }

  if (violations.length > 0) {
    console.warn(
      JSON.stringify({
        event: 'global_config_news_shock_validation_failed',
        requestId: requestId ?? null,
        violations,
      }),
    )
    return {
      ...config,
      newsShockWarnRatio: GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio,
      newsShockBlockRatio: GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio,
      newsShockWarnSizeScale: GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale,
      newsShockToneDropThreshold: GLOBAL_CONFIG_DEFAULTS.newsShockToneDropThreshold,
      newsShockBaselineDays: GLOBAL_CONFIG_DEFAULTS.newsShockBaselineDays,
      newsShockMinSamples: GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples,
      newsShockWindowMin: GLOBAL_CONFIG_DEFAULTS.newsShockWindowMin,
      newsShockMaxAgeMin: GLOBAL_CONFIG_DEFAULTS.newsShockMaxAgeMin,
    }
  }

  return config
}

export async function loadGlobalConfig(
  db: DrizzleD1Database,
  requestId?: string,
): Promise<GlobalConfigSnapshot> {
  // A column added by a later migration (vix_*, news_shock_*,
  // attention_stale_policy, extended_hours_gate_mode) makes the SELECT
  // itself fail at the SQL level on a pre-migration D1, not just come back
  // null — a `row.field ?? default` fallback can't catch that. This
  // try/catch detects the specific missing-column error text and returns
  // defaults instead; anything else rethrows to keep fail-closed.
  //
  // The pattern is deliberately narrow (schema-missing only): matching a
  // bare column-name substring would fail-open on an unrelated error that
  // happens to mention it, so this only matches SQLite's `no such column:`
  // form or a `<col> not found/does not exist/unknown column` form.
  const MISSING_COLUMN_PATTERN =
    '(?:vix_[a-z_]*|news_shock_[a-z_]*|attention_stale_policy|extended_hours_gate_mode)'
  let rows: GlobalConfigRow[]
  try {
    rows = await db.select().from(globalConfig).where(eq(globalConfig.id, 'default')).limit(1)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isMissingVixColumn =
      new RegExp(`no such column:\\s*${MISSING_COLUMN_PATTERN}`, 'i').test(message) ||
      new RegExp(`${MISSING_COLUMN_PATTERN}\\s+(not found|does not exist|unknown column)`, 'i').test(message)
    if (isMissingVixColumn) {
      console.warn(
        JSON.stringify({
          event: 'global_config_pre_0015_fallback',
          requestId: requestId ?? null,
          message,
        }),
      )
      // Shallow-merges defaults onto a legacy row rather than replacing the
      // whole snapshot: `{ ...GLOBAL_CONFIG_DEFAULTS }` would stomp a real
      // operator-set value (e.g. `tradingEnabled: false`) with the default.
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
            pullbackDefaultMaxSma50DeviationPct: globalConfig.pullbackDefaultMaxSma50DeviationPct,
            pullbackDefaultMaxAtrRatio: globalConfig.pullbackDefaultMaxAtrRatio,
            pullbackDefaultMaxStopToTpRatio: globalConfig.pullbackDefaultMaxStopToTpRatio,
            feePctOfNotional: globalConfig.feePctOfNotional,
            feeFixedPerOrder: globalConfig.feeFixedPerOrder,
            atrBaselineMode: globalConfig.atrBaselineMode,
            riskBasePerTradePct: globalConfig.riskBasePerTradePct,
            riskDdHalfThreshold: globalConfig.riskDdHalfThreshold,
            riskDdHaltThreshold: globalConfig.riskDdHaltThreshold,
          })
          .from(globalConfig)
          .where(eq(globalConfig.id, 'default'))
          .limit(1)
        const legacyRow = legacyRows[0]
        if (legacyRow) {
          return validateNewsShockConfig(validateVixConfig({
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
            pullbackDefaultMaxSma50DeviationPct: legacyRow.pullbackDefaultMaxSma50DeviationPct,
            pullbackDefaultMaxAtrRatio: legacyRow.pullbackDefaultMaxAtrRatio,
            // Below: columns this legacy SELECT doesn't include (added by
            // migrations after the one that's missing here), so each falls
            // back to its default.
            pullbackDefaultMaxStopToTpRatio: GLOBAL_CONFIG_DEFAULTS.pullbackDefaultMaxStopToTpRatio,
            feePctOfNotional: GLOBAL_CONFIG_DEFAULTS.feePctOfNotional,
            feeFixedPerOrder: GLOBAL_CONFIG_DEFAULTS.feeFixedPerOrder,
            atrBaselineMode: GLOBAL_CONFIG_DEFAULTS.atrBaselineMode,
            riskBasePerTradePct: legacyRow.riskBasePerTradePct,
            riskDdHalfThreshold: legacyRow.riskDdHalfThreshold,
            riskDdHaltThreshold: legacyRow.riskDdHaltThreshold,
            vixWarningThreshold: GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
            vixCriticalThreshold: GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
            vixWarningSizeScale: GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
            sessionWindowGateEnabled: GLOBAL_CONFIG_DEFAULTS.sessionWindowGateEnabled,
            cashFallbackOrdersEnabled: GLOBAL_CONFIG_DEFAULTS.cashFallbackOrdersEnabled,
            pairRegimeMode: GLOBAL_CONFIG_DEFAULTS.pairRegimeMode,
            pairRegimeThetaBullEnter: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullEnter,
            pairRegimeThetaBullExit: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullExit,
            pairRegimeThetaBearEnter: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearEnter,
            pairRegimeThetaBearExit: GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearExit,
            newsShockMode: GLOBAL_CONFIG_DEFAULTS.newsShockMode,
            newsShockWarnRatio: GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio,
            newsShockBlockRatio: GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio,
            newsShockWarnSizeScale: GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale,
            newsShockToneDropThreshold: GLOBAL_CONFIG_DEFAULTS.newsShockToneDropThreshold,
            newsShockRequireTone: GLOBAL_CONFIG_DEFAULTS.newsShockRequireTone,
            newsShockBaselineDays: GLOBAL_CONFIG_DEFAULTS.newsShockBaselineDays,
            newsShockMinSamples: GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples,
            newsShockWindowMin: GLOBAL_CONFIG_DEFAULTS.newsShockWindowMin,
            newsShockMaxAgeMin: GLOBAL_CONFIG_DEFAULTS.newsShockMaxAgeMin,
            attentionStalePolicy: GLOBAL_CONFIG_DEFAULTS.attentionStalePolicy,
            extendedHoursGateMode: GLOBAL_CONFIG_DEFAULTS.extendedHoursGateMode,
            cashFallbackSellMode: GLOBAL_CONFIG_DEFAULTS.cashFallbackSellMode,
          }, requestId), requestId)
        }
      } catch (legacyError) {
        // Legacy fetch also failed — an unexpected double failure. Fail
        // open to full defaults rather than halting cron entirely.
        console.warn(
          JSON.stringify({
            event: 'global_config_legacy_load_failed',
            requestId: requestId ?? null,
            message: legacyError instanceof Error ? legacyError.message : String(legacyError),
          }),
        )
      }
      return validateNewsShockConfig(validateVixConfig({ ...GLOBAL_CONFIG_DEFAULTS }, requestId), requestId)
    }
    throw error
  }
  const row = rows[0]
  if (!row) return validateNewsShockConfig(validateVixConfig({ ...GLOBAL_CONFIG_DEFAULTS }, requestId), requestId)
  return validateNewsShockConfig(validateVixConfig({
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
    pullbackDefaultMaxSma50DeviationPct: row.pullbackDefaultMaxSma50DeviationPct,
    pullbackDefaultMaxAtrRatio: row.pullbackDefaultMaxAtrRatio,
    pullbackDefaultMaxStopToTpRatio: row.pullbackDefaultMaxStopToTpRatio,
    feePctOfNotional: row.feePctOfNotional,
    feeFixedPerOrder: row.feeFixedPerOrder,
    atrBaselineMode: sanitizeAtrBaselineMode(row.atrBaselineMode),
    riskBasePerTradePct: row.riskBasePerTradePct,
    riskDdHalfThreshold: row.riskDdHalfThreshold,
    riskDdHaltThreshold: row.riskDdHaltThreshold,
    // Below: columns added by migrations after 0015. An older row can still
    // have these `undefined` (ALTER-vs-read race, or a snapshot predating
    // that migration) even though the try/catch above only catches the
    // column being entirely absent from the schema — so every numeric one
    // null-coalesces to its default, and every mode/enum one rejects an
    // out-of-enum value to its safe ('off' / 'fail_open') default.
    vixWarningThreshold:
      row.vixWarningThreshold ?? GLOBAL_CONFIG_DEFAULTS.vixWarningThreshold,
    vixCriticalThreshold:
      row.vixCriticalThreshold ?? GLOBAL_CONFIG_DEFAULTS.vixCriticalThreshold,
    vixWarningSizeScale:
      row.vixWarningSizeScale ?? GLOBAL_CONFIG_DEFAULTS.vixWarningSizeScale,
    sessionWindowGateEnabled:
      row.sessionWindowGateEnabled ?? GLOBAL_CONFIG_DEFAULTS.sessionWindowGateEnabled,
    cashFallbackOrdersEnabled:
      row.cashFallbackOrdersEnabled ?? GLOBAL_CONFIG_DEFAULTS.cashFallbackOrdersEnabled,
    pairRegimeMode:
      row.pairRegimeMode === 'observe' || row.pairRegimeMode === 'enforce'
        ? row.pairRegimeMode
        : 'off',
    pairRegimeThetaBullEnter:
      row.pairRegimeThetaBullEnter ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullEnter,
    pairRegimeThetaBullExit:
      row.pairRegimeThetaBullExit ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBullExit,
    pairRegimeThetaBearEnter:
      row.pairRegimeThetaBearEnter ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearEnter,
    pairRegimeThetaBearExit:
      row.pairRegimeThetaBearExit ?? GLOBAL_CONFIG_DEFAULTS.pairRegimeThetaBearExit,
    newsShockMode:
      row.newsShockMode === 'observe' || row.newsShockMode === 'enforce' ? row.newsShockMode : 'off',
    newsShockWarnRatio: row.newsShockWarnRatio ?? GLOBAL_CONFIG_DEFAULTS.newsShockWarnRatio,
    newsShockBlockRatio: row.newsShockBlockRatio ?? GLOBAL_CONFIG_DEFAULTS.newsShockBlockRatio,
    newsShockWarnSizeScale: row.newsShockWarnSizeScale ?? GLOBAL_CONFIG_DEFAULTS.newsShockWarnSizeScale,
    newsShockToneDropThreshold:
      row.newsShockToneDropThreshold ?? GLOBAL_CONFIG_DEFAULTS.newsShockToneDropThreshold,
    newsShockRequireTone: row.newsShockRequireTone ?? GLOBAL_CONFIG_DEFAULTS.newsShockRequireTone,
    newsShockBaselineDays: row.newsShockBaselineDays ?? GLOBAL_CONFIG_DEFAULTS.newsShockBaselineDays,
    newsShockMinSamples: row.newsShockMinSamples ?? GLOBAL_CONFIG_DEFAULTS.newsShockMinSamples,
    newsShockWindowMin: row.newsShockWindowMin ?? GLOBAL_CONFIG_DEFAULTS.newsShockWindowMin,
    newsShockMaxAgeMin: row.newsShockMaxAgeMin ?? GLOBAL_CONFIG_DEFAULTS.newsShockMaxAgeMin,
    attentionStalePolicy: row.attentionStalePolicy === 'block_buy' ? 'block_buy' : 'fail_open',
    extendedHoursGateMode:
      row.extendedHoursGateMode === 'observe' || row.extendedHoursGateMode === 'enforce'
        ? row.extendedHoursGateMode
        : 'off',
    cashFallbackSellMode:
      row.cashFallbackSellMode === 'observe' || row.cashFallbackSellMode === 'enforce'
        ? row.cashFallbackSellMode
        : 'off',
  }, requestId), requestId)
}
