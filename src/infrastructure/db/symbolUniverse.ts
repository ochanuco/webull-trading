import { createDb } from './tradeJournalRepo'
import {
  loadInversePairs,
  loadSymbolConfig,
  type SymbolCurrency,
  type SymbolMarket,
} from './symbolConfigRepo'

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
  inversePairs: Record<string, string>
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
  const [config, pairs] = await Promise.all([loadSymbolConfig(db), loadInversePairs(db)])
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
    inversePairs: pairs,
    source: 'd1',
  }
}
