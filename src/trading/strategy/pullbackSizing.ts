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
  /**
   * Per-symbol budget allocation fraction of NAV (0..1)。指定されると **fixed-%
   * 配分モード**になり risk-% / ATR floor を bypass して
   * `notional = min(equity * budgetAllocPct, symbolCap)` で sizing する (#budget-alloc)。
   * 小口座で risk-% sizing が 0 株になる高額レバ ETF 用。NULL は従来の risk sizing。
   */
  budgetAllocPct?: number
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
   * Diagnostic fields populated only when applicable per decision/reject route;
   * may be undefined otherwise. These are diagnostic-only for debugging and
   * help operators understand the reject reason.
   * - `rawQuantity`: pre-lot-size quantity (shows how much short of 1 lot).
   *   Filled on lot-size-round path and in successful sizing path.
   * - `stopDistance`: max(kAtr * atr20, |entry * stopPct|).
   *   Filled on invalid-stop, insufficient-risk-budget, lot-size-round, and successful paths.
   * - `riskBudget`: equity * riskPerTradePct.
   *   Filled on insufficient-risk-budget, lot-size-round, and successful paths.
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
  let quantity: number
  let capped = false
  let capReason: PullbackSizingResult['capReason']
  let stopDistance: number | undefined
  let riskBudget: number | undefined

  if (input.budgetAllocPct !== undefined && input.budgetAllocPct > 0) {
    // === fixed-% 予算配分モード (#budget-alloc) ===
    // notional = min(equity * pct, symbolCap)。risk-% / ATR floor は使わない。
    // 小口座で高額レバ ETF を「予算の N%」で建てるための path。
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'invalid-stop' }
    }
    const rawNotional = input.equity * input.budgetAllocPct
    if (!Number.isFinite(rawNotional) || rawNotional <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget' }
    }
    let target = rawNotional
    // %優先・絶対上限は安全弁: min(予算×%, symbolCap)。
    if (input.symbolCap !== undefined && target > input.symbolCap) {
      target = input.symbolCap
      capped = true
      capReason = 'symbol-cap'
    }
    quantity = Math.floor(target / input.entryPrice)
  } else {
    // === 従来の risk-% sizing ===
    const pctStop = Math.abs(input.entryPrice * input.stopPct)
    // vol-adaptive: kAtr * atr20。atr20=0 (post-halt/gap) は pct stop が floor。
    const atrStop = input.atr20 > 0 ? input.kAtr * input.atr20 : 0
    stopDistance = atrStop > pctStop ? atrStop : pctStop

    if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'invalid-stop', stopDistance }
    }

    riskBudget = input.equity * riskPct
    if (!Number.isFinite(riskBudget) || riskBudget <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget', stopDistance, riskBudget }
    }

    quantity = Math.floor(riskBudget / stopDistance)

    if (input.baselineAtr20 > 0 && input.atr20 < input.baselineAtr20 * atrFloor) {
      quantity = Math.floor(quantity / 2)
      capped = true
      capReason = 'atr-floor'
    }

    let notionalRisk = quantity * input.entryPrice
    if (input.symbolCap !== undefined && notionalRisk > input.symbolCap) {
      quantity = Math.floor(input.symbolCap / input.entryPrice)
      notionalRisk = quantity * input.entryPrice
      capped = true
      capReason = 'symbol-cap'
    }
  }

  let notional = quantity * input.entryPrice

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