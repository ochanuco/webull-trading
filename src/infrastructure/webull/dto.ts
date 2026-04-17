export interface WebullAccountDto {
  accountId: string
  accountType: string
  status: string
}

export interface WebullPlaceOrderRequestDto {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  limitPrice: number
}

export interface WebullPlaceOrderResponseDto {
  orderId: string
  status: string
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  limitPrice: number
  message?: string
  submittedAt?: string
}
