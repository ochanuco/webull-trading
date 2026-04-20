import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullMarket, WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

export function toWebullPlaceOrderRequest(intent: OrderIntent): WebullPlaceOrderRequestDto {
  const symbol = intent.symbol.toUpperCase()
  return {
    new_orders: [
      {
        client_order_id: intent.clientOrderId,
        symbol,
        instrument_type: 'EQUITY',
        market: inferWebullMarket(symbol),
        order_type: 'LIMIT',
        limit_price: intent.price.toFixed(3),
        quantity: String(intent.quantity),
        support_trading_session: 'N',
        side: intent.side,
        time_in_force: 'DAY',
        entrust_type: 'QTY',
        account_tax_type: 'GENERAL',
      },
    ],
  }
}

export function toExecutionResult(dto: WebullPlaceOrderResponseDto): ExecutionResult {
  const brokerOrderId = dto.order_id

  return {
    mode: 'LIVE',
    submitted: typeof brokerOrderId === 'string' && brokerOrderId.trim().length > 0,
    brokerOrderId,
    errorReason: dto.message,
  }
}

// TSE codes are 4 chars. Historically all-numeric (e.g. 7203), but since
// 2024 TSE issues alphanumeric codes where the 4th character can be a letter
// (e.g. 285A = Kioxia HD). Match "3 digits + [0-9A-Z]".
export function inferWebullMarket(symbol: string): WebullMarket {
  return /^\d{3}[0-9A-Z]$/.test(symbol) ? 'JP' : 'US'
}
