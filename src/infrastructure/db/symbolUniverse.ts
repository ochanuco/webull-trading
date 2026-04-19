import { createDb } from './tradeJournalRepo'
import { loadInversePairs, loadSymbolConfig, type SymbolCurrency } from './symbolConfigRepo'
import { parseCsvEnv, parseInversePairs, parseSymbolNotionalMap } from '../../config/env'
import { inferWebullMarket } from '../webull/mapper'

export interface SymbolUniverse {
  allowedSymbols: string[]
  symbolMaxNotional: Record<string, number>
  symbolCurrency: Record<string, SymbolCurrency>
  inversePairs: Record<string, string>
  source: 'd1' | 'env'
}

interface UniverseEnv {
  DB?: D1Database
  ALLOWED_SYMBOLS?: string
  SYMBOL_MAX_NOTIONAL?: string
  INVERSE_PAIRS?: string
}

/**
 * Loads the symbol universe (allowed list + per-symbol caps + currencies +
 * inverse pairs).
 *
 * - When `env.DB` is bound: reads from `symbol_config` / `inverse_pairs` in D1.
 * - Otherwise falls back to the legacy env-var parsing so existing deploys or
 *   local tests that have not migrated stay working. env fallback では currency
 *   を 4 桁数字コード = JP 判定で補完する。
 */
export async function loadSymbolUniverse(env: UniverseEnv): Promise<SymbolUniverse> {
  if (env.DB) {
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

  const allowedSymbols = parseCsvEnv(env.ALLOWED_SYMBOLS).map((s) => s.toUpperCase())
  const symbolCurrency: Record<string, SymbolCurrency> = {}
  for (const s of allowedSymbols) {
    symbolCurrency[s] = inferWebullMarket(s) === 'JP' ? 'JPY' : 'USD'
  }
  return {
    allowedSymbols,
    symbolMaxNotional: parseSymbolNotionalMap(env.SYMBOL_MAX_NOTIONAL),
    symbolCurrency,
    inversePairs: parseInversePairs(env.INVERSE_PAIRS),
    source: 'env',
  }
}
