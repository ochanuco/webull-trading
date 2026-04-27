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
 * One row of the Webull `account/positions/get` response. Field names are
 * the Webull canonical snake_case + numeric-as-string convention used
 * throughout the OpenAPI surface (mapper layer parses the strings to
 * numbers before they leave infrastructure).
 *
 * TODO(#21): the live JP UAT tenant has not yet been probed for this
 * endpoint — the field set is inferred from `WebullSubscriptionDto` /
 * `WebullOrderDetailDto` conventions. Treat shape as "best effort" until
 * confirmed against a real response. See follow-up issue #21.
 */
export interface WebullPositionDto {
  /** Ticker. Webull returns it as the canonical form (e.g. `SOXL`, `1570`). */
  symbol?: string
  /** Total holding (informational). */
  quantity_total?: string
  /** Available-to-sell holding. May be < `quantity_total` when shares are
   *  reserved by an in-flight SELL. SELL fallback uses **this** value. */
  quantity_available?: string
  /** Average cost basis (informational; not used by SELL fallback). */
  avg_cost?: string
  /** Currency on the position. POC: USD/JPY only. */
  currency?: string
  /** Optional account id (some Webull endpoints echo it back per row). */
  account_id?: string
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
