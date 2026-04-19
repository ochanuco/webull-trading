import {
  parseBooleanEnv,
  parseDrawdownKillThreshold,
  parseNumberEnv,
  parseOptionalNonNegativeNumberEnv,
  parseOptionalPositiveNumber,
} from '../../config/env'
import { parseBridgeRunMode } from '../../trading/bridge/schedule'
import {
  GLOBAL_CONFIG_DEFAULTS,
  loadGlobalConfig,
  type GlobalConfigSnapshot,
} from './globalConfigRepo'
import { createDb } from './tradeJournalRepo'

export interface LoadedGlobalConfig extends GlobalConfigSnapshot {
  source: 'd1' | 'env'
}

interface GlobalConfigEnv {
  DB?: D1Database
  DRY_RUN?: string
  TRADING_ENABLED?: string
  MARKET_HOURS_CHECK?: string
  MAX_ORDER_NOTIONAL?: string
  DRAWDOWN_KILL_THRESHOLD?: string
  STALE_QUOTE_MS?: string
  GAP_REJECT_PCT?: string
  SPREAD_LIMIT_PCT_US?: string
  SPREAD_LIMIT_PCT_JP?: string
  BRIDGE_RUN_MODE?: string
}

/**
 * Loads the global risk / lifecycle config. Prefers D1 (`global_config`
 * singleton) when `env.DB` is bound; otherwise parses the legacy env vars so
 * tests and pre-D1 deployments stay working.
 *
 * `SPREAD_LIMIT_PCT_*` env values are percent (0.25 = 0.25%) historically, so
 * we divide by 100 when coming from env; D1 stores them already as fractions.
 */
export async function loadGlobalConfigFrom(env: GlobalConfigEnv): Promise<LoadedGlobalConfig> {
  if (env.DB) {
    const db = createDb(env.DB)
    const snapshot = await loadGlobalConfig(db)
    return { ...snapshot, source: 'd1' }
  }

  const spreadUsPercent = parseOptionalNonNegativeNumberEnv(
    env.SPREAD_LIMIT_PCT_US,
    'SPREAD_LIMIT_PCT_US',
  )
  const spreadJpPercent = parseOptionalNonNegativeNumberEnv(
    env.SPREAD_LIMIT_PCT_JP,
    'SPREAD_LIMIT_PCT_JP',
  )

  return {
    dryRun: parseBooleanEnv(env.DRY_RUN, GLOBAL_CONFIG_DEFAULTS.dryRun),
    tradingEnabled: parseBooleanEnv(env.TRADING_ENABLED, GLOBAL_CONFIG_DEFAULTS.tradingEnabled),
    marketHoursCheck: parseBooleanEnv(env.MARKET_HOURS_CHECK, GLOBAL_CONFIG_DEFAULTS.marketHoursCheck),
    maxOrderNotional:
      env.MAX_ORDER_NOTIONAL !== undefined
        ? parseNumberEnv(env.MAX_ORDER_NOTIONAL, 'MAX_ORDER_NOTIONAL')
        : GLOBAL_CONFIG_DEFAULTS.maxOrderNotional,
    drawdownKillThreshold: parseDrawdownKillThreshold(env.DRAWDOWN_KILL_THRESHOLD),
    staleQuoteMs: parseOptionalPositiveNumber(
      env.STALE_QUOTE_MS,
      GLOBAL_CONFIG_DEFAULTS.staleQuoteMs,
      'STALE_QUOTE_MS',
    ),
    gapRejectPct: parseOptionalPositiveNumber(
      env.GAP_REJECT_PCT,
      GLOBAL_CONFIG_DEFAULTS.gapRejectPct,
      'GAP_REJECT_PCT',
    ),
    spreadLimitPctUs:
      spreadUsPercent !== undefined ? spreadUsPercent / 100 : GLOBAL_CONFIG_DEFAULTS.spreadLimitPctUs,
    spreadLimitPctJp:
      spreadJpPercent !== undefined ? spreadJpPercent / 100 : GLOBAL_CONFIG_DEFAULTS.spreadLimitPctJp,
    bridgeRunMode: parseBridgeRunMode(env.BRIDGE_RUN_MODE),
    source: 'env',
  }
}
