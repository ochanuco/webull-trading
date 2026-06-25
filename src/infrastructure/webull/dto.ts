export interface WebullAccountDto {
  accountId?: string
  accountType?: string
  secAccountId?: string
  accountNo?: string
  status?: string
}

/**
 * 口座資産・買付余力 (`/openapi/account/balance` v1 / `/openapi/assets/balance` v2、
 * #415)。JP 本番 probe で確認した shape:
 *   { total_asset_currency:'JPY', total_cash_balance:'100000',
 *     account_currency_assets:[{currency:'JPY', cash_balance, buying_power, ...},
 *                              {currency:'USD', ...}] }
 * 数値は全て string-encoded (OpenAPI 共通)。buying_power は **通貨別** に
 * `account_currency_assets[]` に入る。mapper/reader 側で数値化する。
 */
export interface WebullAccountCurrencyAssetDto {
  currency?: string
  cash_balance?: string
  buying_power?: string
  /** v2 (`/openapi/assets/balance`) のみ。v1 では欠落。 */
  market_value?: string
  unrealized_profit_loss?: string
}

export interface WebullAccountBalanceDto {
  /** 口座基準通貨 (例 'JPY')。 */
  total_asset_currency?: string
  total_cash_balance?: string
  /** v2 のみ。 */
  total_market_value?: string
  total_unrealized_profit_loss?: string
  /** 通貨別の現金 / 買付余力。POC: JPY + USD。 */
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
 * Place Order body schema。#251 / #256 で v1 (旧 SDK) と v2 (新 OpenAPI docs)
 * の差分対応のため、両方を許容する shape を持つ。version の選択は env
 * (\`WEBULL_PLACE_ORDER_SCHEMA\`) で行い、mapper が schema 別の body を構築する。
 *
 * v1 (default / 現挙動):
 *   - limit_price 必須 (MARKET orders にも safety cap として送る)
 *   - support_trading_session: 'N'
 *   - combo_type は無し
 *   - account_id は query param 側
 *
 * v2 (新 docs / opt-in):
 *   - limit_price は LIMIT/STOP_LOSS_LIMIT のときのみ required
 *   - support_trading_session enum は \`NIGHT/ALL/CORE/ALL_DAY\` (旧 'N' は廃止)
 *   - combo_type 必須 (\`'NORMAL'\` for non-combo single-leg)
 *   - account_id は body へ
 */
export interface WebullV2OrderEntry {
  client_order_id: string
  symbol: string
  instrument_type: 'EQUITY'
  market: WebullMarket
  order_type: 'LIMIT' | 'MARKET'
  /** v1 必須 (MARKET でも safety cap)、v2 で MARKET は省略可。 */
  limit_price?: string
  quantity: string
  /** v1: 'N'、v2: 'CORE' (新 enum)。 */
  support_trading_session: string
  side: 'BUY' | 'SELL'
  /**
   * ロングの開閉を明示する。v1 / v2 両スキーマで必須。
   * 未送信時に Webull JP が SELL を空売り開始とみなし、キャッシュ口座で
   * 417 CASH_ACCOUNT_NOT_ALLOW_SELL_SHORT を返した実績あり (v1 本番, 2026-06-25)。
   * BUY → 'OPEN'、SELL → 'CLOSE' を常に送る。
   */
  open_or_close: 'OPEN' | 'CLOSE'
  time_in_force: 'DAY'
  entrust_type: 'QTY'
  account_tax_type: 'GENERAL' | 'SPECIFIC'
  /** v2 のみ。combo / multi-leg 未対応 POC では常に 'NORMAL'。 */
  combo_type?: 'NORMAL'
}

export interface WebullPlaceOrderRequestDto {
  /** v2 で account_id を body 側に持つ場合に使用。v1 では未送信。 */
  account_id?: string
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
