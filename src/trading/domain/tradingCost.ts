/**
 * Estimated round-trip trading cost, netted against gross realized PnL.
 * Webull's order detail response carries no fee field, so cost is
 * estimated from config rather than read off the actual fill.
 *
 * Default 0 matches Webull JP's current zero-commission schedule — set
 * `fee_pct_of_notional` / `fee_fixed_per_order` only after confirming the
 * account's actual fee schedule, not as a placeholder.
 *
 * FX conversion spread is deliberately excluded from `feePctOfNotional`:
 * it's a one-time cost paid when converting JPY/USD balances, not a
 * per-trade cost, so folding it into a per-notional rate would overstate
 * cost on trades that don't trigger a conversion.
 */
export interface TradeCostConfig {
  /** Fee rate applied to order notional (0.0022 = 0.22%). 0 disables it. */
  feePctOfNotional: number
  /** Fixed per-order fee, in the symbol's currency. 0 disables it. */
  feeFixedPerOrder: number
}

export const NO_TRADE_COST: TradeCostConfig = Object.freeze({
  feePctOfNotional: 0,
  feeFixedPerOrder: 0,
})

function sanitize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return value
}

/** Cost for a single order leg. Falls back to the fixed fee alone when notional is invalid. */
export function estimateOrderCost(notional: number, config: TradeCostConfig): number {
  const pct = sanitize(config.feePctOfNotional)
  const fixed = sanitize(config.feeFixedPerOrder)
  const base = Number.isFinite(notional) && notional > 0 ? notional : 0
  return base * pct + fixed
}

/**
 * Both legs' cost, since realized PnL is only computed at exit — entry
 * notional is approximated as avgPrice × quantity.
 */
export function estimateRoundTripCost(
  entryNotional: number,
  exitNotional: number,
  config: TradeCostConfig,
): number {
  return estimateOrderCost(entryNotional, config) + estimateOrderCost(exitNotional, config)
}

export function netRealizedPnl(input: {
  avgPrice: number
  exitPrice: number
  quantity: number
  config: TradeCostConfig
}): { gross: number; cost: number; net: number } {
  const gross = (input.exitPrice - input.avgPrice) * input.quantity
  const cost = estimateRoundTripCost(
    input.avgPrice * input.quantity,
    input.exitPrice * input.quantity,
    input.config,
  )
  return { gross, cost, net: gross - cost }
}
