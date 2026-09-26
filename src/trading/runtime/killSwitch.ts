/**
 * AND-combines the dashboard-editable DB flag with the deploy-time env
 * override — the more restrictive side always wins.
 */
export function resolveTradingEnabled(
  dbFlag: boolean,
  envOverrideRaw: string | undefined,
): boolean {
  if (envOverrideRaw === undefined) return dbFlag
  if (envOverrideRaw === 'true') return dbFlag
  // Any other value (typo, empty string) forces OFF rather than falling
  // through to dbFlag, so a malformed env var can't fail open.
  return false
}
