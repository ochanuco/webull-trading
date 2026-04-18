export interface PullbackSizingInput {
  equity: number
  entryPrice: number
  /** Stop-loss fraction, negative (e.g. -0.04). */
  stopPct: number
  atr20: number
  /** Longer-window baseline ATR(20) for the low-vol cap. */
  baselineAtr20: number
  /** Optional symbol-specific absolute notional cap. */
  symbolCap?: number
  /** Risk fraction of NAV per trade. Default 0.004 (0.4%). */
  riskPerTradePct?: number
  /** ATR floor ratio. If atr20 < baselineAtr20 * this, size is halved. Default 0.5. */
  atrFloorRatio?: number
}

export interface PullbackSizingResult {
  quantity: number
  notional: number
  capped: boolean
  capReason?: 'atr-floor' | 'symbol-cap' | 'invalid-stop' | 'insufficient-risk-budget'
}

/**
 * Fixed-% NAV risk sizing with ATR floor + absolute symbol cap.
 *
 * `qty = floor(equity * riskPct / (entry * |stopPct|))`. If current ATR has
 * collapsed to less than `atrFloorRatio` of its baseline, the POC halves the
 * size (vol expansion risk). A separate `symbolCap` hard-limits notional.
 */
export function computePullbackSizing(input: PullbackSizingInput): PullbackSizingResult {
  const riskPct = input.riskPerTradePct ?? 0.004
  const atrFloor = input.atrFloorRatio ?? 0.5
  const stopDistance = Math.abs(input.entryPrice * input.stopPct)

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return { quantity: 0, notional: 0, capped: true, capReason: 'invalid-stop' }
  }

  const riskBudget = input.equity * riskPct
  if (!Number.isFinite(riskBudget) || riskBudget <= 0) {
    return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget' }
  }

  let quantity = Math.floor(riskBudget / stopDistance)
  let capped = false
  let capReason: PullbackSizingResult['capReason']

  if (input.baselineAtr20 > 0 && input.atr20 < input.baselineAtr20 * atrFloor) {
    quantity = Math.floor(quantity / 2)
    capped = true
    capReason = 'atr-floor'
  }

  let notional = quantity * input.entryPrice
  if (input.symbolCap !== undefined && notional > input.symbolCap) {
    quantity = Math.floor(input.symbolCap / input.entryPrice)
    notional = quantity * input.entryPrice
    capped = true
    capReason = 'symbol-cap'
  }

  return { quantity, notional, capped, capReason }
}
