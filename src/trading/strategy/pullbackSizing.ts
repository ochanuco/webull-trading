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
  /**
   * Exchange lot size. Final quantity is floored to a multiple of this
   * (e.g. 100 for TSE equities). Default 1 (no rounding).
   */
  lotSize?: number
  /**
   * ATR multiplier for the stop distance. Effective stop becomes
   * `max(kAtr * atr20, |entryPrice * stopPct|)` — vol-adaptive normally,
   * pct-based as a floor guard when ATR is 0 (post-halt / post-gap).
   * Required; invalid (<=0 or non-finite) throws.
   */
  kAtr: number
}

export interface PullbackSizingResult {
  quantity: number
  notional: number
  capped: boolean
  capReason?:
    | 'atr-floor'
    | 'symbol-cap'
    | 'invalid-stop'
    | 'insufficient-risk-budget'
    | 'lot-size-round'
  /**
   * Diagnostic fields populated on every run。reject reason を組み立てる時に
   * operator がすぐ原因を把握できるようにする。
   * - `rawQuantity`: lot-size 丸めの前の qty (1 lot に何株足りないか分かる)
   * - `stopDistance`: max(kAtr * atr20, |entry * stopPct|)
   * - `riskBudget`: equity * riskPerTradePct
   */
  rawQuantity?: number
  stopDistance?: number
  riskBudget?: number
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
  if (!Number.isFinite(input.kAtr) || input.kAtr <= 0) {
    throw new Error(`computePullbackSizing: kAtr must be a positive finite number, got ${input.kAtr}`)
  }
  const pctStop = Math.abs(input.entryPrice * input.stopPct)
  // vol-adaptive: kAtr * atr20。atr20=0 (post-halt/gap) は pct stop が floor。
  const atrStop = input.atr20 > 0 ? input.kAtr * input.atr20 : 0
  const stopDistance = atrStop > pctStop ? atrStop : pctStop

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return { quantity: 0, notional: 0, capped: true, capReason: 'invalid-stop', stopDistance }
  }

  const riskBudget = input.equity * riskPct
  if (!Number.isFinite(riskBudget) || riskBudget <= 0) {
    return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget', stopDistance, riskBudget }
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

  // Exchange lot-size rounding (e.g. TSE 100-share lots). Must run AFTER all
  // other caps so we don't round up back over symbolCap. If the round-down
  // zeroes the qty, surface it explicitly so caller can reject rather than
  // silently skip.
  // Validate and normalize lotSize to a positive finite integer.
  let lotSize = input.lotSize ?? 1
  if (!Number.isFinite(lotSize) || !Number.isInteger(lotSize) || lotSize <= 0) {
    lotSize = 1
  }
  // pre-lot-round を diagnostic 用に捕捉 (symbol-cap で clamp されていれば
  // その clamp 後の qty、されていなければ rawQuantity と同じ)
  const preLotQuantity = quantity
  if (lotSize > 1) {
    const rounded = Math.floor(quantity / lotSize) * lotSize
    if (rounded !== quantity) {
      quantity = rounded
      notional = quantity * input.entryPrice
      if (!Number.isFinite(quantity) || !Number.isFinite(notional)) {
        return { quantity: 0, notional: 0, capped: true, capReason: 'lot-size-round', rawQuantity: preLotQuantity, stopDistance, riskBudget }
      }
      capped = true
      capReason = rounded === 0 ? 'lot-size-round' : capReason ?? 'lot-size-round'
    }
  }

  return { quantity, notional, capped, capReason, rawQuantity: preLotQuantity, stopDistance, riskBudget }
}