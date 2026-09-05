import { resolveStopDistance } from './stopDistance'

export interface PullbackSizingInput {
  /**
   * Risk-% sizing の母数となる口座資産。未指定/非有限/<=0 は risk-% branch を
   * fail-closed させる (`capital-unset`) — 架空の baseline を当てると
   * `total_capital_usd` 未設定の口座 (本番の VUG/ICLN 等) が実在しない資金に
   * 対して実発注サイズを計算してしまう。budgetAllocPct モードでは未使用。
   */
  equity?: number
  entryPrice: number
  /** Stop-loss fraction, negative (e.g. -0.04). */
  stopPct: number
  atr20: number
  /** Longer-window baseline ATR(20) for the low-vol cap. */
  baselineAtr20: number
  /** Optional symbol-specific absolute notional cap. */
  symbolCap?: number
  /**
   * Per-symbol budget allocation fraction (0..1)。指定されると **fixed-% 配分モード**に
   * なり risk-% / ATR floor を bypass して、**口座(円)単一プール**に対する割合で sizing
   * する (#budget-jpy-base-fx)。
   *   targetSymbolCcy = (budgetBasisJpy * budgetAllocPct) / fxJpyPerSymbolCcy
   *   notional = min(targetSymbolCcy, symbolCap) → floor(/price) → lot
   * 小口座で risk-% sizing が 0 株になる高額レバ ETF 用。NULL は従来の risk sizing。
   */
  budgetAllocPct?: number
  /**
   * 予算配分モードの基準額 = 口座総額 (円)。`total_capital_jpy` を流用。
   * budgetAllocPct 指定時に必須 (finite>0 でなければ fail-closed)。
   */
  budgetBasisJpy?: number
  /**
   * 1 単位の symbol 通貨 = 何円か (JPY 銘柄=1、USD 銘柄=USD/JPY レート)。
   * budgetAllocPct 指定時に必須 (finite>0 でなければ fail-closed)。USD で FX 取得
   * 失敗 (null) のときは呼び出し側が未指定にして fail-closed させる。
   */
  fxJpyPerSymbolCcy?: number
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
  /**
   * Stop 幅の上限 = |entryPrice * takeProfitPct| * これ (#stop-rr-cap)。exit 側と
   * **同じ式**で距離を出さないと「サイズを決めた stop」と「実際に切る stop」が
   * ズレるので、strategy と共有の `resolveStopDistance` を使う。0 / 未指定で無効。
   */
  maxStopToTpRatio?: number
  /** cap の基準となる利確幅 (正値)。未指定なら cap 無効。 */
  takeProfitPct?: number
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
    | 'capital-unset'
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

  if (input.budgetAllocPct !== undefined) {
    // === fixed-% 予算配分モード (#budget-jpy-base-fx) ===
    // 口座(円)単一プールに対する割合で sizing。risk-% / ATR floor は使わない。
    //   targetSymbolCcy = (budgetBasisJpy * pct) / fxJpyPerSymbolCcy
    //   notional = min(targetSymbolCcy, symbolCap)
    // 小口座で高額レバ ETF を「口座の N%」で建てるための path。
    //
    // budgetAllocPct / budgetBasisJpy / fxJpyPerSymbolCcy のいずれかが不正なら
    // **fail-closed (0 qty)**。risk-% へ fallback すると想定外サイジングになるため、
    // また USD で FX 取得失敗 (fxJpyPerSymbolCcy 未指定/非有限) のときも発注しない。
    if (!Number.isFinite(input.budgetAllocPct) || input.budgetAllocPct <= 0 || input.budgetAllocPct > 1) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget' }
    }
    if (
      input.budgetBasisJpy === undefined ||
      !Number.isFinite(input.budgetBasisJpy) ||
      input.budgetBasisJpy <= 0 ||
      input.fxJpyPerSymbolCcy === undefined ||
      !Number.isFinite(input.fxJpyPerSymbolCcy) ||
      input.fxJpyPerSymbolCcy <= 0
    ) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget' }
    }
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'invalid-stop' }
    }
    // 口座円 × pct を symbol 通貨に換算 (JPY 銘柄は fx=1 で素通り)。
    const targetSymbolCcy = (input.budgetBasisJpy * input.budgetAllocPct) / input.fxJpyPerSymbolCcy
    if (!Number.isFinite(targetSymbolCcy) || targetSymbolCcy <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'insufficient-risk-budget' }
    }
    let target = targetSymbolCcy
    // %優先・絶対上限は安全弁: min(換算後 target, symbolCap)。
    if (input.symbolCap !== undefined && target > input.symbolCap) {
      target = input.symbolCap
      capped = true
      capReason = 'symbol-cap'
    }
    quantity = Math.floor(target / input.entryPrice)
  } else {
    // === 従来の risk-% sizing ===
    // vol-adaptive: kAtr * atr20 (atr20=0 は pct stop が floor)、さらに
    // R:R cap (#stop-rr-cap)。exit 判定と同一関数で算出する。
    stopDistance = resolveStopDistance({
      price: input.entryPrice,
      stopPct: input.stopPct,
      takeProfitPct: input.takeProfitPct ?? 0,
      atr20: input.atr20,
      kAtr: input.kAtr,
      maxStopToTpRatio: input.maxStopToTpRatio ?? 0,
    }).distance

    if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'invalid-stop', stopDistance }
    }

    const equity = input.equity
    if (equity === undefined || !Number.isFinite(equity) || equity <= 0) {
      return { quantity: 0, notional: 0, capped: true, capReason: 'capital-unset', stopDistance }
    }

    riskBudget = equity * riskPct
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