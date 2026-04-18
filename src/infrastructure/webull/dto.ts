export interface WebullAccountDto {
  accountId?: string
  accountType?: string
  secAccountId?: string
  accountNo?: string
  status?: string
}

export interface WebullPlaceOrderRequestDto {
  stock_order: {
    client_order_id: string
    symbol: string
    side: 'BUY' | 'SELL'
    tif: 'DAY'
    order_type: 'LIMIT'
    limit_price: string
    qty: string
    extended_hours_trading: boolean
  }
}

export interface WebullPlaceOrderResponseDto {
  orderId?: string
  order_id?: string
  client_order_id?: string
  status?: string
  symbol?: string
  side?: 'BUY' | 'SELL'
  quantity?: number
  qty?: number | string
  limitPrice?: number
  limit_price?: string
  message?: string
  submittedAt?: string
}
