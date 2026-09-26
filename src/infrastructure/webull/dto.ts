export interface WebullAccountDto {
  accountId?: string
  accountType?: string
  secAccountId?: string
  accountNo?: string
  status?: string
}

/**
 * Balance response (`/openapi/account/balance` v1 or `/openapi/assets/balance`
 * v2). Numbers are string-encoded (OpenAPI convention); buying_power is
 * per-currency, inside `account_currency_assets[]`.
 */
interface WebullAccountCurrencyAssetDto {
  currency?: string
  cash_balance?: string
  buying_power?: string
  /** v2 only; absent in v1. */
  market_value?: string
  unrealized_profit_loss?: string
}

export interface WebullAccountBalanceDto {
  /** Account base currency (e.g. 'JPY'). */
  total_asset_currency?: string
  total_cash_balance?: string
  /** v2 only. */
  total_market_value?: string
  total_unrealized_profit_loss?: string
  /** Per-currency cash / buying power. POC: JPY + USD. */
  account_currency_assets?: WebullAccountCurrencyAssetDto[]
}

export interface WebullSubscriptionDto {
  subscription_id?: string
  user_id?: string
  account_id?: string
  account_number?: string
}

export type WebullMarket = 'US' | 'JP'

/**
 * Covers both v1 and v2 Place Order body shapes; see
 * {@link toWebullPlaceOrderRequest} in mapper.ts for which fields each
 * version sends.
 */
interface WebullV2OrderEntry {
  client_order_id: string
  symbol: string
  instrument_type: 'EQUITY'
  market: WebullMarket
  order_type: 'LIMIT' | 'MARKET'
  /** v1: required even for MARKET (safety cap). v2: omitted for MARKET. */
  limit_price?: string
  quantity: string
  /** v1: 'N'. v2: 'CORE' (new enum). */
  support_trading_session: string
  side: 'BUY' | 'SELL'
  /**
   * Required in both schemas — omitted, Webull JP treats a SELL as opening a
   * short and rejects it with 417 CASH_ACCOUNT_NOT_ALLOW_SELL_SHORT in a cash account.
   */
  open_or_close: 'OPEN' | 'CLOSE'
  time_in_force: 'DAY'
  entrust_type: 'QTY'
  account_tax_type: 'GENERAL' | 'SPECIFIC'
  /** v2 only; always 'NORMAL' since combo/multi-leg orders are out of scope. */
  combo_type?: 'NORMAL'
}

export interface WebullPlaceOrderRequestDto {
  /** v2 only — account_id lives in the body; v1 sends it via query instead. */
  account_id?: string
  new_orders: [WebullV2OrderEntry]
}

export interface WebullPlaceOrderResponseDto {
  client_order_id?: string
  order_id?: string
  message?: string
}

/**
 * One row of the positions response (all fields are string-encoded numbers,
 * per OpenAPI convention). The old SDK returned `quantity_total` /
 * `avg_cost`; the new docs use `quantity` / `cost_price`, and JP UAT returns
 * the new names. Both are kept optional — readers like `parseBrokerAvg` /
 * `parseBrokerQty` parse new-then-old for compatibility; follow the same
 * pattern for new readers.
 */
export interface WebullPositionDto {
  /** Ticker. Webull returns it as the canonical form (e.g. `SOXL`, `1570`). */
  symbol?: string
  /** New docs: total holding (informational). */
  quantity?: string
  /** Legacy SDK name; renamed to `quantity` in the new docs. */
  quantity_total?: string
  /** Available-to-sell holding; may be less than total when shares are
   *  reserved by an in-flight SELL. Used by the SELL fallback. */
  available_quantity?: string
  /** New docs: average cost basis (informational; not used by SELL fallback). */
  cost_price?: string
  /** Legacy SDK name; renamed to `cost_price` in the new docs. */
  avg_cost?: string
  /** Currency on the position. POC: USD/JPY only. */
  currency?: string
  /** Optional account id (some Webull endpoints echo it back per row). */
  account_id?: string
}

/**
 * Per-fill leg inside an order detail. Field names follow the
 * openapi-java-sdk `v2.OrderHistory.Item` mirror; only consumed fields are
 * typed, others are tolerated. The JP UAT tenant has been seen returning a
 * stub `filled_price=10` on otherwise-realistic fills — see the sanity-ratio
 * guard in `resolveFilledPrice`.
 */
interface WebullOrderItemDto {
  order_id?: string
  symbol?: string
  side?: 'BUY' | 'SELL'
  quantity?: string
  filled_quantity?: string
  filled_price?: string
  status?: string
}

/**
 * Shape returned by `GET /openapi/account/orders/detail` (v1, flat). Fields
 * mirror openapi-java-sdk's `v2.OrderHistory`. The newer order-history/detail
 * endpoints wrap this in `{client_order_id, combo_type, orders: [...]}` —
 * `findOrderByClientId` normalizes both shapes into this flat DTO, so callers
 * (reconcileFills etc.) keep the same signature.
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
  /** New docs' name for quantity; the normalizer copies it into `quantity`. */
  total_quantity?: string
  filled_quantity?: string
  /** Present at top level in the new docs; kept here too so `resolveFilledPrice` can read it when `items[]` is empty. */
  filled_price?: string
  // Webull order lifecycle statuses: NEW, PARTIALLY_FILLED, FILLED,
  // CANCELLED, REJECTED, EXPIRED, etc. Keep as free string for forward-compat.
  status?: string
  support_trading_session?: string
  items?: WebullOrderItemDto[]
}

/**
 * Wrapper shape from the newer order-history/detail endpoints;
 * `findOrderByClientId` flattens it into {@link WebullOrderDetailDto} via
 * `normalizeOrderHistoryRow`.
 */
export interface WebullOrderHistoryWrapperDto {
  client_order_id?: string
  combo_type?: string
  orders?: WebullOrderDetailDto[]
}
