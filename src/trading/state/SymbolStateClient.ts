import type { PositionStore } from './PositionStore'
import type { SymbolStateDO } from './SymbolStateDO'
import type { PendingOrderLock, PendingSettlement, SymbolState } from './types'

/**
 * Thin adapter from {@link DurableObjectNamespace} to {@link PositionStore}.
 * Routes every call for a given symbol to the DO instance derived from
 * `idFromName(symbol)` so all reads/writes land on the same object.
 */
export class SymbolStateClient implements PositionStore {
  constructor(private readonly namespace: DurableObjectNamespace<SymbolStateDO>) {}

  private stub(symbol: string): DurableObjectStub<SymbolStateDO> {
    return this.namespace.get(this.namespace.idFromName(symbol))
  }

  getState(symbol: string): Promise<SymbolState> {
    return this.stub(symbol).getState(symbol)
  }

  lockPendingOrder(
    symbol: string,
    lock: PendingOrderLock,
  ): Promise<{ ok: boolean; state: SymbolState }> {
    return this.stub(symbol).lockPendingOrder(symbol, lock)
  }

  clearPendingOrder(symbol: string): Promise<SymbolState> {
    return this.stub(symbol).clearPendingOrder(symbol)
  }

  recordFill(
    symbol: string,
    fill: { side: 'BUY' | 'SELL'; qty: number; price: number },
  ): Promise<SymbolState> {
    return this.stub(symbol).recordFill(symbol, fill)
  }

  addPendingSettlement(symbol: string, settlement: PendingSettlement): Promise<SymbolState> {
    return this.stub(symbol).addPendingSettlement(symbol, settlement)
  }

  setCooldown(symbol: string, untilIso: string): Promise<SymbolState> {
    return this.stub(symbol).setCooldown(symbol, untilIso)
  }

  seedSettledCash(symbol: string, amount: number): Promise<SymbolState> {
    return this.stub(symbol).seedSettledCash(symbol, amount)
  }
}
