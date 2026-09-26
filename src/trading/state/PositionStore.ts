import type { PendingOrderLock, PendingSettlement, SymbolState } from './types'

/** Interface (not the {@link SymbolStateDO} class) so callers are testable without a Durable Object runtime. */
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
  /** Operator-driven reconcile against broker truth; also used by the SELL_QTY_EXCEED fallback to force `position=null`. */
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
