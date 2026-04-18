import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

export function toWebullPlaceOrderRequest(intent: OrderIntent): WebullPlaceOrderRequestDto {
  return {
    stock_order: {
      client_order_id: crypto.randomUUID().replaceAll('-', ''),
      symbol: intent.symbol.toUpperCase(),
      side: intent.side,
      tif: 'DAY',
      order_type: 'LIMIT',
      limit_price: intent.price.toFixed(3),
      qty: String(intent.quantity),
      extended_hours_trading: false,
    },
  }
}

export function toExecutionResult(dto: WebullPlaceOrderResponseDto): ExecutionResult {
  const brokerOrderId = dto.orderId ?? dto.order_id ?? dto.client_order_id

  return {
    mode: 'LIVE',
    submitted: typeof brokerOrderId === 'string' && brokerOrderId.trim().length > 0,
    brokerOrderId,
    errorReason: dto.message,
  }
}
