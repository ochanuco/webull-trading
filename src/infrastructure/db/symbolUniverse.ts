import { createDb } from './tradeJournalRepo'
import { loadInversePairs, loadSymbolConfig } from './symbolConfigRepo'
import { parseCsvEnv, parseInversePairs, parseSymbolNotionalMap } from '../../config/env'

export interface SymbolUniverse {
  allowedSymbols: string[]
  symbolMaxNotional: Record<string, number>
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
 * Loads the symbol universe (allowed list + per-symbol caps + inverse pairs).
 *
 * - When `env.DB` is bound: reads from `symbol_config` / `inverse_pairs` in D1.
 * - Otherwise falls back to the legacy env-var parsing so existing deploys or
 *   local tests that have not migrated stay working.
 *
 * The `source` field tags which path was taken — handy to surface in audit
 * logs after cutover so we can confirm D1 reads are actually hit.
 */
export async function loadSymbolUniverse(env: UniverseEnv): Promise<SymbolUniverse> {
  if (env.DB) {
    const db = createDb(env.DB)
    const [config, pairs] = await Promise.all([loadSymbolConfig(db), loadInversePairs(db)])
    return {
      allowedSymbols: config.allowedSymbols,
      symbolMaxNotional: config.symbolMaxNotional,
      inversePairs: pairs,
      source: 'd1',
    }
  }

  return {
    allowedSymbols: parseCsvEnv(env.ALLOWED_SYMBOLS).map((s) => s.toUpperCase()),
    symbolMaxNotional: parseSymbolNotionalMap(env.SYMBOL_MAX_NOTIONAL),
    inversePairs: parseInversePairs(env.INVERSE_PAIRS),
    source: 'env',
  }
}
