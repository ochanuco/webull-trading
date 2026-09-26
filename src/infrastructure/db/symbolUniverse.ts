import { createDb } from './tradeJournalRepo'
import {
  loadInversePairs,
  loadPairRegimeConfigs,
  loadSymbolConfig,
  type SymbolCurrency,
  type SymbolMarket,
  type SymbolRoleValue,
} from './symbolConfigRepo'
import type { PairRegimeEntry } from '../../trading/strategy/pairRegime'

export interface SymbolUniverse {
  /** active=1 only — the cron/risk-gate evaluation set. */
  allowedSymbols: string[]
  /**
   * active=0 symbols, for dashboard display only (grayed-out, so operators
   * can see disable history). Never read by cron/risk gate.
   */
  inactiveSymbols: string[]
  symbolMaxNotional: Record<string, number>
  symbolCurrency: Record<string, SymbolCurrency>
  /** Used by the dashboard to switch JP-symbol display. */
  symbolMarket: Record<string, SymbolMarket>
  /** Absent key = no name set (not a null value). */
  symbolName: Record<string, string>
  /** Free-text notes (e.g. disable reason), shown as a dashboard tooltip. Absent when null/empty. */
  symbolNotes: Record<string, string>
  /** Missing key falls through to `global_config.pullback_default_time_stop_days`. */
  symbolTimeStopDaysOverride: Record<string, number>
  /** Missing key falls through to `global_config.pullback_default_k_atr`. */
  symbolKAtrOverride: Record<string, number>
  /** Missing key means the symbol still uses risk-% sizing instead of fixed-% budget allocation. */
  symbolBudgetAllocPct: Record<string, number>
  /** Missing key fails closed in cron sizing rather than falling back to a blanket default lot size. */
  symbolLotSize: Record<string, number>
  /** Missing key = global default stop_pct. */
  symbolStopPctOverride: Record<string, number>
  /** Missing key = global default take_profit_pct. */
  symbolTakeProfitPctOverride: Record<string, number>
  /** Only symbols with intraday_only=true are present. */
  symbolIntradayOnly: Record<string, boolean>
  /**
   * Missing key = legacy behavior. A DB value outside the enum maps to
   * 'unknown', which fails closed by suppressing entry.
   */
  symbolRole: Record<string, SymbolRoleValue>
  /** Entry-gate overrides; a missing key falls through role preset → global default. */
  symbolPullbackMaxOverride: Record<string, number>
  symbolPullbackMinOverride: Record<string, number>
  symbolMinReturn50dOverride: Record<string, number>
  symbolMaxAtrRatioOverride: Record<string, number>
  symbolMaxSma50DeviationPctOverride: Record<string, number>
  symbolRequireAboveSma50Override: Record<string, boolean>
  /** Only symbols with entry_required=true are present. */
  symbolEntryRequired: Record<string, boolean>
  /** Only symbols with always_active=true are present (used for cash-parking symbols). */
  symbolAlwaysActive: Record<string, boolean>
  /** Missing key = no cash-fallback symbols configured. */
  symbolCashFallback: Record<string, string[]>
  inversePairs: Record<string, string>
  /** Regime-enabled pairs only; a misconfigured pair carries `invalidConfig` and is treated as unknown. */
  pairRegimes: PairRegimeEntry[]
  source: 'd1'
}

interface UniverseEnv {
  DB?: D1Database
}

/**
 * Loads the symbol universe from D1 (`symbol_config` / `inverse_pairs`).
 * `env.DB` is required — throws rather than falling back, since a missing
 * binding is a setup mistake that should fail closed.
 */
export async function loadSymbolUniverse(env: UniverseEnv): Promise<SymbolUniverse> {
  if (!env.DB) {
    throw new Error('loadSymbolUniverse: env.DB is not bound (D1 setup required)')
  }
  const db = createDb(env.DB)
  const [config, pairs, pairRegimes] = await Promise.all([
    loadSymbolConfig(db),
    loadInversePairs(db),
    loadPairRegimeConfigs(db),
  ])
  return {
    allowedSymbols: config.allowedSymbols,
    inactiveSymbols: config.inactiveSymbols,
    symbolMaxNotional: config.symbolMaxNotional,
    symbolCurrency: config.symbolCurrency,
    symbolMarket: config.symbolMarket,
    symbolName: config.symbolName,
    symbolNotes: config.symbolNotes,
    symbolTimeStopDaysOverride: config.symbolTimeStopDaysOverride,
    symbolKAtrOverride: config.symbolKAtrOverride,
    symbolBudgetAllocPct: config.symbolBudgetAllocPct,
    symbolLotSize: config.symbolLotSize,
    symbolStopPctOverride: config.symbolStopPctOverride,
    symbolTakeProfitPctOverride: config.symbolTakeProfitPctOverride,
    symbolIntradayOnly: config.symbolIntradayOnly,
    symbolRole: config.symbolRole,
    symbolPullbackMaxOverride: config.symbolPullbackMaxOverride,
    symbolPullbackMinOverride: config.symbolPullbackMinOverride,
    symbolMinReturn50dOverride: config.symbolMinReturn50dOverride,
    symbolMaxAtrRatioOverride: config.symbolMaxAtrRatioOverride,
    symbolMaxSma50DeviationPctOverride: config.symbolMaxSma50DeviationPctOverride,
    symbolRequireAboveSma50Override: config.symbolRequireAboveSma50Override,
    symbolEntryRequired: config.symbolEntryRequired,
    symbolAlwaysActive: config.symbolAlwaysActive,
    symbolCashFallback: config.symbolCashFallback,
    inversePairs: pairs,
    pairRegimes,
    source: 'd1',
  }
}
