export interface WebullAccountDto {
  accountId?: string
  accountType?: string
  secAccountId?: string
  accountNo?: string
  status?: string
}

export interface WebullSubscriptionDto {
  subscription_id?: string
  user_id?: string
  account_id?: string
  account_number?: string
}

export type WebullMarket = 'US' | 'JP'

export interface WebullV2OrderEntry {
  client_order_id: string
  symbol: string
  instrument_type: 'EQUITY'
  market: WebullMarket
  order_type: 'LIMIT' | 'MARKET'
  /** MARKET orders still carry limit_price as a safety cap (Webull schema). */
  limit_price: string
  quantity: string
  support_trading_session: 'N'
  side: 'BUY' | 'SELL'
  time_in_force: 'DAY'
  entrust_type: 'QTY'
  account_tax_type: 'GENERAL'
}

export interface WebullPlaceOrderRequestDto {
  new_orders: [WebullV2OrderEntry]
}

export interface WebullPlaceOrderResponseDto {
  client_order_id?: string
  order_id?: string
  message?: string
}

/**
 * Shape returned by GET /openapi/account/orders/detail (v1).
 * Fields mirror openapi-java-sdk's `v2.OrderHistory`.
 */
export interface WebullOrderDetailDto {
  client_order_id?: string
  order_id?: string
  symbol?: string
  side?: 'BUY' | 'SELL'
  order_type?: string
  time_in_force?: string
  limit_price?: string
  stop_price?: string
  quantity?: string
  filled_quantity?: string
  // Webull order lifecycle statuses: NEW, PARTIALLY_FILLED, FILLED,
  // CANCELLED, REJECTED, EXPIRED, etc. Keep as free string for forward-compat.
  status?: string
  support_trading_session?: string
  items?: Array<{
    order_id?: string
    symbol?: string
    quantity?: string
    filled_quantity?: string
    status?: string
  }>
}
