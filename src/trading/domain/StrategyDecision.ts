/**
 * strategy_decision_log classification.
 * - `SKIP`: stopped by an internal gate (risk / sizing / spread / capital
 *   pool / inverse-pair) — never reached the broker.
 * - `REJECT`: broker returned a definitive 4xx (SELL_SHORT, insufficient
 *   buying power, ticker deny, etc).
 * - `ERROR`: anything else — network failure / 5xx / unexpected exception,
 *   cause unknown or transient.
 */
export type StrategyDecision = 'BUY' | 'SELL' | 'HOLD' | 'SKIP' | 'REJECT' | 'ERROR'
