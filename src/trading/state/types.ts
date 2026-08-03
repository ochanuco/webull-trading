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
  /**
   * 建玉を閉じた最後の SELL fill の時刻 (ISO 8601)。#reentry の再エントリー
   * 価格ガードが「前回手仕舞いから何営業日経過したか」の recency 判定に使う。
   * `lastExitPrice` と対で読む。close 以外の fill (BUY / 部分 SELL) では
   * 更新しない。旧 state には無い → undefined は null 相当。
   */
  lastExitAt: string | null
  /**
   * 建玉を閉じた SELL fill の価格。#reentry ガードの基準価格。
   * `state.position === null ? state.lastExecutedPrice : null` という推論には
   * 依存しない — flat = 直近 fill が SELL、という不変条件は syncHoldings 等の
   * position override で壊れうるため (#660)。BUY / 部分 SELL では更新しない。
   * 旧 state には無い → load 時に null へ正規化する。
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
