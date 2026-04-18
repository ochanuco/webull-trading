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

const JST_OFFSET_MS = 9 * 60 * 60 * 1_000

/**
 * True when the bridge should be running now. 平日 **JST** のみ true を返す。
 * JP 市場の営業日境界が UTC だと日跨ぎするため、JST で判定した方が運用感覚に
 * 一致する (e.g. 土曜 0:30 JST は UTC で金曜 15:30、UTC 判定だと平日扱いに
 * なり bridge を動かしてしまう)。祝日カレンダーは #54 系で強化予定。
 */
export function isBridgeActive(now: Date, mode: BridgeRunMode = 'auto'): boolean {
  if (mode === 'always-on') return true
  if (mode === 'disabled') return false
  const jstDay = new Date(now.getTime() + JST_OFFSET_MS).getUTCDay()
  return jstDay >= 1 && jstDay <= 5
}
