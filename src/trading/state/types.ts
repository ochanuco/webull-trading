export interface PositionState {
  qty: number
  avgPrice: number
  openedAt: string
}

export interface PendingOrderLock {
  clientOrderId: string
  side: 'BUY' | 'SELL'
  submittedAt: string
  expiresAt: string
}

export interface PendingSettlement {
  tradeDate: string
  settleDate: string
  amount: number
}

export interface QuoteSnapshot {
  price: number
  asOf: string
  fetchedAt: string
  source: string
  bid?: number
  ask?: number
}

export interface SymbolState {
  symbol: string
  position: PositionState | null
  appliedClientOrderIds: string[]
  pendingOrder: PendingOrderLock | null
  lastSignalAt: string | null
  cooldownUntil: string | null
  settledCash: number
  pendingSettlement: PendingSettlement[]
  lastExecutedPrice: number | null
  /** Time of the SELL fill that last closed the position; the re-entry guard's days-since-exit reference. Not updated on BUY or a partial SELL. */
  lastExitAt: string | null
  /**
   * Price of the SELL fill that last closed the position — the re-entry
   * guard's reference price. Not derived from `position === null`, since
   * overridePosition can null the position without a SELL. Not updated on
   * BUY or a partial SELL.
   */
  lastExitPrice: number | null
  lastQuote: QuoteSnapshot | null
  updatedAt: string
}

export function emptySymbolState(symbol: string, now: () => Date = () => new Date()): SymbolState {
  return {
    symbol,
    position: null,
    appliedClientOrderIds: [],
    pendingOrder: null,
    lastSignalAt: null,
    cooldownUntil: null,
    settledCash: 0,
    pendingSettlement: [],
    lastExecutedPrice: null,
    lastExitAt: null,
    lastExitPrice: null,
    lastQuote: null,
    updatedAt: now().toISOString(),
  }
}
