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
  order_type: 'LIMIT'
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
