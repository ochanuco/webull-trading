import { createDb } from './tradeJournalRepo'
import { loadInversePairs, loadSymbolConfig, type SymbolCurrency } from './symbolConfigRepo'

export interface SymbolUniverse {
  allowedSymbols: string[]
  symbolMaxNotional: Record<string, number>
  symbolCurrency: Record<string, SymbolCurrency>
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
    symbolMaxNotional: config.symbolMaxNotional,
    symbolCurrency: config.symbolCurrency,
    inversePairs: pairs,
    source: 'd1',
  }
}
