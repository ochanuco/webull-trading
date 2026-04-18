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
}

export interface SymbolState {
  symbol: string
  position: PositionState | null
  pendingOrder: PendingOrderLock | null
  lastSignalAt: string | null
  cooldownUntil: string | null
  settledCash: number
  pendingSettlement: PendingSettlement[]
  lastExecutedPrice: number | null
  lastQuote: QuoteSnapshot | null
  updatedAt: string
}

export function emptySymbolState(symbol: string, now: () => Date = () => new Date()): SymbolState {
  return {
    symbol,
    position: null,
    pendingOrder: null,
    lastSignalAt: null,
    cooldownUntil: null,
    settledCash: 0,
    pendingSettlement: [],
    lastExecutedPrice: null,
    lastQuote: null,
    updatedAt: now().toISOString(),
  }
}
