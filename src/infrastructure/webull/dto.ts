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
 * One row of the Webull `/openapi/account/positions` response. Field names
 * follow the official Webull OpenAPI reference
 * (https://developer.webull.com/apis/docs/reference/account-position/) —
 * canonical snake_case + numeric-as-string convention used throughout the
 * OpenAPI surface (mapper layer parses the strings to numbers before they
 * leave infrastructure).
 */
export interface WebullPositionDto {
  /** Ticker. Webull returns it as the canonical form (e.g. `SOXL`, `1570`). */
  symbol?: string
  /** Total holding (informational). */
  quantity_total?: string
  /** Available-to-sell holding. May be < `quantity_total` when shares are
   *  reserved by an in-flight SELL. SELL fallback uses **this** value.
   *  Webull canonical field name (per official reference docs). */
  available_quantity?: string
  /** Average cost basis (informational; not used by SELL fallback). */
  avg_cost?: string
  /** Currency on the position. POC: USD/JPY only. */
  currency?: string
  /** Optional account id (some Webull endpoints echo it back per row). */
  account_id?: string
}

/**
 * Per-fill leg inside a Webull order detail. Field names follow the
 * openapi-java-sdk `v2.OrderHistory.Item` mirror — keep them as free strings
 * (the OpenAPI surface returns numeric-as-string consistently). Only the
 * fields we actually consume are typed; unknown ones are tolerated.
 *
 * Note: the official doc does not formally declare `filled_price` /
 * `filled_quantity` here, but the production US tenant returns them and
 * `pickFilledPrice` averages across them. The JP UAT tenant has been
 * observed returning `filled_price=10` as a stub on otherwise-realistic
 * orders (see `webull_order_detail_raw` log in reconcileFills) — that is
 * the trigger for the sanity-ratio guard in `resolveFilledPrice`.
 */
export interface WebullOrderItemDto {
  order_id?: string
  symbol?: string
  side?: 'BUY' | 'SELL'
  quantity?: string
  filled_quantity?: string
  filled_price?: string
  status?: string
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
  items?: WebullOrderItemDto[]
}
