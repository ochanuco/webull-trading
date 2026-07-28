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
 *
 * ---
 * ## ウィブル証券 (Webull JP) の実際のコスト — 2026-07-27 調査時点
 *
 * **2026-07-27 17:30 JST 約定分から、米国株・ETF (現物 / 信用 / オプション口座の
 * 現物) の売買手数料は恒久的に無料**。それ以前は 0.20%(税抜) = 0.22%(税込) が
 * 片道でかかり、$10,000 以上の約定は $20 上限だった (2026-07-14 告知 →
 * 2026-07-27 発効、同日に「本日より開始」の続報あり)。
 *
 * 無料化後に残るのは以下だけ:
 *   - SEC Section 31: $20.60 / $1M (= 0.00206%)、**売却時のみ** (2026-04-04 発効)
 *   - FINRA TAF:      $0.000195 / 株、**売却時のみ** (上限 $9.79、2026-01-01 改定)
 *   - CAT Fee:        少額 (料率非公表)
 *   - 為替スプレッド: 15 銭 / USD **片道**。円⇔ドル両替時のみで、トレード毎ではない
 *
 * $200 notional / 5 株の往復で現地諸費用は約 $0.005 (= 0.002%) にしかならず、
 * 丸め誤差以下。しかも SEC / FINRA は売却側だけの費用で、往復を均等按分する
 * この module のモデルとは形が合わない。**よって `fee_pct_of_notional` は 0 の
 * ままが実態に最も近い**。為替は両替時の一回きりのコストなので、per-trade の
 * 料率に混ぜると過大計上になる (同じ USD 残高を回している限り発生しない)。
 *
 * このモデルを実際に使うのは、手数料体系が再び変わったときか、JP 株を再開した
 * とき (1570 / 1357 は現在 inactive)。
 *
 * 注意: **2026-07-27 より前の約定は 0.22% × 2 のコストを負担しているが、記録は
 * gross のまま**。累計実現損益 +11.70 の時点で $5–7 程度過大に表示されている。
 * ---
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
