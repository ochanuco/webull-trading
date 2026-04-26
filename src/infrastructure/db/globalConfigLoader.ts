import { loadGlobalConfig, type GlobalConfigSnapshot } from './globalConfigRepo'
import { createDb } from './tradeJournalRepo'

export interface LoadedGlobalConfig extends GlobalConfigSnapshot {
  source: 'd1'
}

interface GlobalConfigEnv {
  DB?: D1Database
}

/**
 * Loads the global risk / lifecycle config from D1.
 *
 * D1 binding is **required** (Phase E で env fallback を削除)。未 bind は
 * setup ミスなので明示的に throw して fail-closed にする。
 *
 * `requestId` を任意で受け取り、pre-0015 fallback 警告ログに含める
 * (CodeRabbit 2nd round Major)。caller (cron / route) で手元にあれば必ず渡す。
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
