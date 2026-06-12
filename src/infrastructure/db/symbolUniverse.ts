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
  /** active=1 のみ。cron / risk gate の評価対象。 */
  allowedSymbols: string[]
  /**
   * active=0 (一時停止扱い) の symbols。dashboard 表示専用 — operator が
   * disable 経緯を確認できるよう grayed-out で picker / table に出す。
   * cron / risk gate からは参照されない (= 評価対象は allowedSymbols のみ)。
   */
  inactiveSymbols: string[]
  symbolMaxNotional: Record<string, number>
  symbolCurrency: Record<string, SymbolCurrency>
  /** symbol → 'US' | 'JP'。dashboard が JP 銘柄表示を切り替えるのに使う。 */
  symbolMarket: Record<string, SymbolMarket>
  /** symbol → 人間可読 name (symbol_config.name、null は map に不在)。 */
  symbolName: Record<string, string>
  /**
   * symbol → notes (symbol_config.notes)。disable 理由などの自由 text。
   * dashboard が disabled 銘柄の tooltip 表示に使う。null / 空文字は map に不在。
   */
  symbolNotes: Record<string, string>
  /**
   * symbol → time_stop_days override (1-365 整数)。空 map のキーは
   * global_config.pullback_default_time_stop_days を使う (fall-through、#316)。
   */
  symbolTimeStopDaysOverride: Record<string, number>
  /**
   * symbol → k_atr override (0.5-5.0 float)。空 map のキーは
   * global_config.pullback_default_k_atr を使う (fall-through、#316)。
   */
  symbolKAtrOverride: Record<string, number>
  /**
   * symbol → budget_alloc_pct (0<pct<=1)。空 map のキーは従来の risk-% sizing。
   * fixed-% 予算配分モード (#budget-alloc)。
   */
  symbolBudgetAllocPct: Record<string, number>
  /**
   * symbol → lot_size (売買単位、integer >= 1)。NULL は map に不在
   * (= cron sizing が fail-closed)。blanket default に倒さない (#symbol-lot-size)。
   */
  symbolLotSize: Record<string, number>
  /** symbol → stop_pct override (負 fraction)。NULL は不在 (= global default)。#exit-atr */
  symbolStopPctOverride: Record<string, number>
  /** symbol → take_profit_pct override (正 fraction)。NULL は不在 (= global default)。 */
  symbolTakeProfitPctOverride: Record<string, number>
  /** intraday_only=true の symbol 集合 (#intraday-only)。false は不在。 */
  symbolIntradayOnly: Record<string, boolean>
  /**
   * symbol → role (#452)。NULL は不在 (= 従来挙動)。enum 外の DB 直書きは
   * 'unknown' (= entry 抑止、fail-closed)。
   */
  symbolRole: Record<string, SymbolRoleValue>
  /** Entry gate override (#452 Layer 2a)。不在キーは role preset → global default。 */
  symbolPullbackMaxOverride: Record<string, number>
  symbolPullbackMinOverride: Record<string, number>
  symbolMinReturn50dOverride: Record<string, number>
  symbolMaxAtrRatioOverride: Record<string, number>
  symbolMaxSma50DeviationPctOverride: Record<string, number>
  symbolRequireAboveSma50Override: Record<string, boolean>
  /** entry_required=true の集合 (#452 Layer 3)。false は不在。 */
  symbolEntryRequired: Record<string, boolean>
  /** always_active=true の集合 (#452、cash_parking 用)。false は不在。 */
  symbolAlwaysActive: Record<string, boolean>
  /** symbol → 退避先 symbol (#452)。不在 = 退避しない。 */
  symbolCashFallback: Record<string, string[]>
  inversePairs: Record<string, string>
  /** regime 有効化済みペア (#472)。misconfig は invalidConfig 付き (= unknown 扱い)。 */
  pairRegimes: PairRegimeEntry[]
  source: 'd1'
}

interface UniverseEnv {
  DB?: D1Database
}

/**
 * Loads the symbol universe from D1 (`symbol_config` / `inverse_pairs`).
 *
 * D1 binding is **required** (Phase E で env fallback を削除)。未 bind は
 * setup ミスなので明示的に throw する。
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
