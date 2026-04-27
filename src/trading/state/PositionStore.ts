import type { PendingOrderLock, PendingSettlement, SymbolState } from './types'

/**
 * The subset of {@link SymbolStateDO} that TradingService and reconcileFills
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
  addPendingSettlement(symbol: string, settlement: PendingSettlement): Promise<SymbolState>
  setCooldown(symbol: string, untilIso: string): Promise<SymbolState>
  seedSettledCash(symbol: string, amount: number): Promise<SymbolState>
  /**
   * Operator-driven position override. Used to manually reconcile DO state
   * against broker truth (e.g. corrupted `position.qty` from a past
   * reconcile race) and from the SELL_QTY_EXCEED fallback path to force
   * `position=null` after the fallback closes the broker-side holding.
   */
  overridePosition(
    symbol: string,
    args: {
      qty: number
      avgPrice: number
      openedAt: string | null
      reason: string
      requestId?: string | null
    },
  ): Promise<SymbolState>
}
