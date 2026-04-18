import type { PendingOrderLock, SymbolState } from './types'

/**
 * The subset of {@link SymbolStateDO} that TradingService and TradeEventHandler
 * need. Exposing it as an interface keeps both testable without a Durable
 * Object runtime.
 */
export interface PositionStore {
  getState(symbol: string): Promise<SymbolState>
  lockPendingOrder(
    symbol: string,
    lock: PendingOrderLock,
  ): Promise<{ ok: boolean; state: SymbolState }>
  clearPendingOrder(symbol: string): Promise<SymbolState>
  recordFill(
    symbol: string,
    fill: { side: 'BUY' | 'SELL'; qty: number; price: number },
  ): Promise<SymbolState>
}
