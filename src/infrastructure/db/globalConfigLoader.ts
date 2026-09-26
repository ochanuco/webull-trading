import { loadGlobalConfig, type GlobalConfigSnapshot } from './globalConfigRepo'
import { createDb } from './tradeJournalRepo'

export interface LoadedGlobalConfig extends GlobalConfigSnapshot {
  source: 'd1'
}

interface GlobalConfigEnv {
  DB?: D1Database
}

/**
 * Loads the global risk / lifecycle config from D1. `env.DB` is required —
 * throws rather than silently falling back, since a missing binding is a
 * setup mistake that should fail closed.
 */
export async function loadGlobalConfigFrom(
  env: GlobalConfigEnv,
  requestId?: string,
): Promise<LoadedGlobalConfig> {
  if (!env.DB) {
    throw new Error('loadGlobalConfigFrom: env.DB is not bound (D1 setup required)')
  }
  const db = createDb(env.DB)
  const snapshot = await loadGlobalConfig(db, requestId)
  return { ...snapshot, source: 'd1' }
}
