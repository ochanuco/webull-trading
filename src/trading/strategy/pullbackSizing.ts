import { resolveStopDistance } from './stopDistance'

export interface PullbackSizingInput {
  /**
   * Risk-% sizing の母数となる口座資産。未指定/非有限/<=0 は risk-% branch を
   * `capital-unset` で fail-closed させる — 架空の baseline を当てると
   * `total_capital_usd` 未設定の口座が実在しない資金に対してサイズを計算して
   * しまう。budgetAllocPct モードでは未使用。
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
   * Per-symbol budget allocation fraction (0..1)。指定すると risk-% / ATR floor
   * を bypass し、口座(円)単一プールに対する割合で sizing する (fixed-% モード) —
   * 高額レバ ETF は risk-% sizing だと小口座で 0 株になるため:
   *   targetSymbolCcy = (budgetBasisJpy * budgetAllocPct) / fxJpyPerSymbolCcy
   *   notional = min(targetSymbolCcy, symbolCap) → floor(/price) → lot
   * 未指定は従来の risk sizing。
   */
  budgetAllocPct?: number
  /** budgetAllocPct モードの基準額 = 口座総額 (円、`total_capital_jpy`)。指定時は finite>0 必須 (fail-closed)。 */
  budgetBasisJpy?: number
  /**
   * 1 単位の symbol 通貨 = 何円か (JPY 銘柄=1、USD 銘柄=USD/JPY レート)。
   * budgetAllocPct 指定時は finite>0 必須。USD で FX 取得失敗時は呼び出し側が
   * 未指定にして fail-closed させる。
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
   * Stop 幅の上限 = `|entryPrice * takeProfitPct| * maxStopToTpRatio`。exit 側と
   * 同じ `resolveStopDistance` で算出しないとサイズを決めた stop とズレる。
   * 0 / 未指定で無効。
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
  /** Diagnostic-only, populated per reject route: pre-lot-size quantity. */
  rawQuantity?: number
  /** Diagnostic-only: max(kAtr * atr20, |entry * stopPct|). */
  stopDistance?: number
  /** Diagnostic-only: equity * riskPerTradePct. */
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
    // 不正な入力を risk-% へフォールバックすると想定外サイジングになるため
    // fail-closed (0 qty) にする。
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
    if (input.symbolCap !== undefined && target > input.symbolCap) {
      target = input.symbolCap
      capped = true
      capReason = 'symbol-cap'
    }
    quantity = Math.floor(target / input.entryPrice)
  } else {
    // strategy の exit 判定と同一関数で算出しないと、サイズを決めた stop と
    // 実際に切る stop がズレる。
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

  // symbolCap 適用後に丸めないと、lot 丸めで上に戻って cap を超えうる。
  let lotSize = input.lotSize ?? 1
  if (!Number.isFinite(lotSize) || !Number.isInteger(lotSize) || lotSize <= 0) {
    lotSize = 1
  }
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