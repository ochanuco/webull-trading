/** Null when bid/ask cannot yield a trustworthy spread (non-positive, or a crossed book). */
export function computeSpreadPct(bid: number, ask: number): number | null {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null
  if (bid <= 0 || ask <= 0) return null
  if (ask < bid) return null

  const mid = (bid + ask) / 2
  if (mid <= 0) return null

  return (ask - bid) / mid
}

/** Fail-closed: a degenerate book or invalid limit returns false. */
export function isSpreadWithinLimit(bid: number, ask: number, limitPct: number): boolean {
  const spreadPct = computeSpreadPct(bid, ask)
  if (spreadPct === null) return false
  if (!Number.isFinite(limitPct) || limitPct < 0) return false
  return spreadPct <= limitPct
}
