/**
 * Bridge lifecycle policy.
 *
 * - `always-on`: ignore schedule, keep the container running 24/7
 * - `disabled`: kill switch — stop the container every tick
 * - `auto` (default): start on weekdays UTC, stop on weekends
 *
 * Kept as a dependency-free module so it can be unit-tested without pulling
 * in the `@cloudflare/containers` runtime.
 */
export const BRIDGE_RUN_MODES = ['always-on', 'disabled', 'auto'] as const
export type BridgeRunMode = (typeof BRIDGE_RUN_MODES)[number]

const DEFAULT_MODE: BridgeRunMode = 'auto'

/**
 * Parses the `BRIDGE_RUN_MODE` env string into the enum. Unknown / undefined
 * values fall back to `auto` — never throw, because this is a non-critical
 * knob and staging should not break on a typo.
 */
export function parseBridgeRunMode(value: string | undefined): BridgeRunMode {
  if (value === undefined || value === '') return DEFAULT_MODE
  if ((BRIDGE_RUN_MODES as readonly string[]).includes(value)) {
    return value as BridgeRunMode
  }
  console.warn(`Invalid BRIDGE_RUN_MODE '${value}'; using '${DEFAULT_MODE}'`)
  return DEFAULT_MODE
}

/**
 * True when the bridge should be running now. 平日 UTC のみ true を返す。
 * 祝日カレンダーは #54 系で強化予定。
 */
export function isBridgeActive(now: Date, mode: BridgeRunMode = 'auto'): boolean {
  if (mode === 'always-on') return true
  if (mode === 'disabled') return false
  const utcDay = now.getUTCDay()
  return utcDay >= 1 && utcDay <= 5
}
