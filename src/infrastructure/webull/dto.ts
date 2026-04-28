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
 * One row of the Webull positions response. Spec ambiguity #251: the older
 * `/openapi/account/positions` SDK returned `quantity_total` / `avg_cost`,
 * but the new docs (`/openapi/assets/positions` →
 * https://developer.webull.co.jp/apis/docs/reference/account-position.md)
 * use `quantity` / `cost_price`. JP UAT は実際の probe で **新名前** で返す。
 *
 * 旧 SDK 互換のため両方 optional として持ち、reader 側 (`parseBrokerAvg`,
 * `parseBrokerQty` 等) は新→旧の順で読む defensive parsing にする。新規 reader
 * を書くときも同じヘルパを通すこと。
 *
 * 全 field は string-encoded number / string (= OpenAPI 共通の数値文字列方針)。
 * mapper 層で数値化してから infrastructure 層を出る。
 */
export interface WebullPositionDto {
  /** Ticker. Webull returns it as the canonical form (e.g. `SOXL`, `1570`). */
  symbol?: string
  /** 新 docs: total holding (informational). */
  quantity?: string
  /** 旧 SDK 互換: 新 docs では `quantity` に rename。 */
  quantity_total?: string
  /** Available-to-sell holding. May be < total when shares are reserved by
   *  an in-flight SELL. SELL fallback uses **this** value. 新旧 docs 共通。 */
  available_quantity?: string
  /** 新 docs: average cost basis (informational; not used by SELL fallback). */
  cost_price?: string
  /** 旧 SDK 互換: 新 docs では `cost_price` に rename。 */
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
 * Shape returned by GET /openapi/account/orders/detail (v1) — flat 形式。
 * Fields mirror openapi-java-sdk's `v2.OrderHistory`.
 *
 * 新 docs (#251 / #253) では order-history / order-detail が wrapper 形式に
 * なる:
 *   { client_order_id, combo_type, orders: [...inner...] }
 * ここでは `findOrderByClientId` 内で wrapper を正規化して同じ flat 形式に
 * 落とし込むため、callers (reconcileFills 等) の signature は変えない。
 * 新名前 `total_quantity` は `quantity` に正規化される。
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
  /** 新 docs での名前。normalizer が `quantity` にコピーするので consumer は
   *  従来通り `quantity` を読めば良い (両方持ってても矛盾しない)。 */
  total_quantity?: string
  filled_quantity?: string
  /** 新 docs では top-level に持つ。flat 表現でも optional として持っておき、
   *  items[] が空のケースで `resolveFilledPrice` が参照できるよう保持。 */
  filled_price?: string
  // Webull order lifecycle statuses: NEW, PARTIALLY_FILLED, FILLED,
  // CANCELLED, REJECTED, EXPIRED, etc. Keep as free string for forward-compat.
  status?: string
  support_trading_session?: string
  items?: WebullOrderItemDto[]
}

/**
 * 新 docs (#251) の order-history / order-detail wrapper shape:
 *   { client_order_id, combo_type, orders: [WebullOrderDetailDto] }
 *
 * 通常 1 つの client_order_id に対し orders[] は単一エントリ (combo / leg は
 * POC スコープ外)。\`findOrderByClientId\` 内の \`normalizeOrderHistoryRow\` で
 * 平坦化して \`WebullOrderDetailDto\` として扱う。
 */
export interface WebullOrderHistoryWrapperDto {
  client_order_id?: string
  combo_type?: string
  orders?: WebullOrderDetailDto[]
}
