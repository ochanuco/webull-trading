// Portfolio 全体の建玉エクスポージャー上限ゲート (`global_config.max_portfolio_exposure_pct`)
// を cron BUY 経路に適用するための共有台帳。`BuyingPowerLedger` (#415) と同じ
// 「1 tick 分の残余枠を pre-trade で予約 (decrement) する」設計を踏襲する —
// manual `/trade/execute` (`TradingService`) は同じ上限を都度計算しているが、
// cron は同一 tick 内で複数銘柄が連続 BUY するため、pass 1/2 をまたいで
// 1 個の ledger を共有しないと後続銘柄が先行 BUY 分の増分を見られず、
// tick 全体で上限を超過し得る。
//
// fail-safe: 上限が計算できない tick (`total_capital_jpy` 未設定 / 現在建玉の
// 換算に必要な USD/JPY レート欠落 / 建玉 state 読み取り失敗 / 上限 pct 自体が
// 不正) は `unavailable` 台帳にして当 tick の cron BUY を全 fail-closed する。
// 誤ったエクスポージャー額を基準に発注可否を決めない。

export interface ExposureLedger {
  /** `ok` = 上限計算済で予約可能。`unavailable` = 計算不能 → BUY 全 reject。 */
  status: 'ok' | 'unavailable'
  /** 残枠 (JPY 基準)。`unavailable` 時は 0。 */
  remainingJpy: number
  /** 上限 (JPY 基準) = `budgetBasisJpy * maxPortfolioExposurePct`。`unavailable` 時は 0。 */
  ceilingJpy: number
  /** tick 開始時点の現在建玉評価額 (JPY 基準、診断用)。`unavailable` 時は 0。 */
  currentJpy: number
  /** `unavailable` の理由 (dashboard / log 用)。 */
  reason?: string
  /**
   * `notionalJpy` (JPY 基準) を予約する。`ok` かつ残枠で賄えるなら減算して true、
   * それ以外は false (= 発注見送り)。非有限/非正の notional も false。
   */
  tryReserve(notionalJpy: number): boolean
  /** 予約後に submit が失敗した時、予約を戻す (他銘柄判定を歪めないため)。 */
  refund(notionalJpy: number): void
}

/** 上限計算不能 tick 用。常に予約失敗 = 当 tick の cron BUY を全 fail-closed。 */
export function createUnavailableExposureLedger(reason: string): ExposureLedger {
  return {
    status: 'unavailable',
    remainingJpy: 0,
    ceilingJpy: 0,
    currentJpy: 0,
    reason,
    tryReserve() {
      return false
    },
    refund() {
      /* no-op */
    },
  }
}

/** 上限計算成功 tick 用。`remaining = max(0, ceiling - current)`。 */
export function createExposureLedger(opts: { ceilingJpy: number; currentJpy: number }): ExposureLedger {
  const ceilingJpy = Number.isFinite(opts.ceilingJpy) && opts.ceilingJpy > 0 ? opts.ceilingJpy : 0
  const currentJpy = Number.isFinite(opts.currentJpy) && opts.currentJpy >= 0 ? opts.currentJpy : 0
  const ledger: ExposureLedger = {
    status: 'ok',
    remainingJpy: Math.max(0, ceilingJpy - currentJpy),
    ceilingJpy,
    currentJpy,
    tryReserve(notionalJpy: number): boolean {
      if (!Number.isFinite(notionalJpy) || notionalJpy <= 0) return false
      if (notionalJpy > ledger.remainingJpy) return false
      ledger.remainingJpy -= notionalJpy
      return true
    },
    refund(notionalJpy: number): void {
      if (Number.isFinite(notionalJpy) && notionalJpy > 0) ledger.remainingJpy += notionalJpy
    },
  }
  return ledger
}
