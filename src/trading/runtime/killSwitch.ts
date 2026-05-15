/**
 * Runtime kill-switch resolver (issue #276)。
 *
 * 「DB が真値、env は deploy-gate の override」。両方を AND で結合して
 * **より制限的な側が勝つ** (env=false なら DB=true でも OFF)。
 *
 * - DB (`global_config.trading_enabled`) は dashboard / admin から runtime
 *   切替できる現在値。deploy 不要。
 * - env (`TRADING_ENABLED`) は wrangler.jsonc / .dev.vars で固定する deploy-gate。
 *   preview / staging で「DB を間違って ON にしてもこの環境では絶対に発注しない」
 *   保険として効く。
 *
 * 受理値:
 *   - env unset / 'true'           → DB を尊重
 *   - env が 'false'               → 強制 OFF (override)
 *   - env がそれ以外 (typo / 空白) → 安全側で強制 OFF
 */
export function resolveTradingEnabled(
  dbFlag: boolean,
  envOverrideRaw: string | undefined,
): boolean {
  if (envOverrideRaw === undefined) return dbFlag
  if (envOverrideRaw === 'true') return dbFlag
  return false
}
