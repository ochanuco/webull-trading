/**
 * Spread guard: reject submit when the bid/ask spread is too wide relative to mid.
 *
 * Rationale: a wide spread at the moment of submit turns into slippage on market
 * orders and stale fills on marketable limits. Small retail accounts cannot absorb
 * that cost, so we fail-closed per (market, symbol) when spread exceeds a limit.
 *
 * See issue #38-D.
 */

/**
 * Returns (ask - bid) / mid, where mid = (bid + ask) / 2.
 *
 * Returns null for degenerate inputs that should never be trusted as a spread
 * signal: non-positive bid or ask, or a crossed book (ask < bid). A zero spread
 * (bid == ask) is a valid lit-book state and returns 0, not null.
 */
export function computeSpreadPct(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
  if (bid <= 0 || ask <= 0) return null
  if (ask < bid) return null

  const mid = (bid + ask) / 2
  if (mid <= 0) return null

  return (ask - bid) / mid
}

/**
 * True when the spread percentage is within (or equal to) `limitPct`.
 * Degenerate bid/ask returns false — fail-closed: unknown spread blocks submit.
 */
export function isSpreadWithinLimit(bid: number, ask: number, limitPct: number): boolean {
  const spreadPct = computeSpreadPct(bid, ask)
  if (spreadPct === null) return false
  if (!Number.isFinite(limitPct) || limitPct < 0) return false
  return spreadPct <= limitPct
}
