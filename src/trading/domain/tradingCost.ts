/**
 * 売買コストの見積り (#trade-cost)。
 *
 * これまで realized PnL は `(exit - avg) * qty` の **gross** で、手数料も為替
 * スプレッドも一切入っていなかった。1 トレードの notional が $50–350 の規模だと
 * 往復コストは勝ち幅と同じオーダーになり得るため、gross のまま equity curve /
 * drawdown kill を回すと「勝っているのに減っている」状態を検知できない。
 *
 * broker の order detail は手数料を返さない (`WebullOrderDetailDto` に該当
 * フィールドなし) ので、**設定値からの見積り**を差し引く。実費が取れるように
 * なったらこの module を実測ベースに差し替える。
 *
 * 既定は 0 (= 従来どおり gross)。口座の手数料体系を確認してから
 * `global_config.fee_pct_of_notional` / `fee_fixed_per_order` を設定する。
 */
export interface TradeCostConfig {
  /** 約定代金に対する料率 (0.0022 = 0.22%)。0 で無効。 */
  feePctOfNotional: number
  /** 1 注文あたりの固定費 (銘柄通貨建て)。0 で無効。 */
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

/** 片道 (1 注文) のコスト見積り。notional が不正なら固定費のみ。 */
export function estimateOrderCost(notional: number, config: TradeCostConfig): number {
  const pct = sanitize(config.feePctOfNotional)
  const fixed = sanitize(config.feeFixedPerOrder)
  const base = Number.isFinite(notional) && notional > 0 ? notional : 0
  return base * pct + fixed
}

/**
 * 往復コスト見積り。exit 時にしか realized PnL を出さないので、entry 側の
 * コストもここでまとめて引く (entry notional は avgPrice × qty で近似)。
 */
export function estimateRoundTripCost(
  entryNotional: number,
  exitNotional: number,
  config: TradeCostConfig,
): number {
  return estimateOrderCost(entryNotional, config) + estimateOrderCost(exitNotional, config)
}

/**
 * gross realized PnL から往復コストを引いた net を返す。コスト未設定なら
 * gross をそのまま返す (数値としても完全に一致する)。
 */
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
