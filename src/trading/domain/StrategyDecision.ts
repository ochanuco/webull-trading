/**
 * strategy_decision_log の decision 分類 (3値タクソノミ)。
 *
 * - `BUY` / `SELL` / `HOLD`: strategy 判定そのまま。
 * - `SKIP`: bot 内部ゲートで見送り (**broker 未到達**)。risk gate / sizing 0株 /
 *   スプレッド超過 / 買付余力プール / inverse-pair など、旧 `REJECT` の全ケース。
 * - `REJECT`: broker が注文を**確定拒否** (HTTP 4xx: 417 SELL_SHORT /
 *   Insufficient Buying Power / TICKER_IS_DENY 等)。
 * - `ERROR`: それ以外の失敗 = 原因不明・一時的 (ネットワーク断 / 5xx /
 *   想定外の例外)。
 */
export type StrategyDecision = 'BUY' | 'SELL' | 'HOLD' | 'SKIP' | 'REJECT' | 'ERROR'
