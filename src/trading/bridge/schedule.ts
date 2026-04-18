/**
 * Active = weekday in UTC. 土日は両市場とも休場なので bridge も止めて
 * Cloudflare Container の課金を削る。US / JP の祝日カレンダーは #54 系で
 * 別途カバー。`BRIDGE_ALWAYS_ON=true` で override 可能。
 *
 * Kept as a dependency-free module so it can be unit-tested without pulling
 * in the `@cloudflare/containers` runtime.
 */
export function isBridgeActive(now: Date): boolean {
  const utcDay = now.getUTCDay()
  return utcDay >= 1 && utcDay <= 5
}
