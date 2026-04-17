import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

export function toWebullPlaceOrderRequest(intent: OrderIntent): WebullPlaceOrderRequestDto {
  return {
    symbol: intent.symbol.toUpperCase(),
    side: intent.side,
    quantity: intent.quantity,
    limitPrice: intent.price,
  }
}

export function toExecutionResult(dto: WebullPlaceOrderResponseDto): ExecutionResult {
  return {
    mode: 'LIVE',
    submitted: dto.orderId.trim().length > 0,
    brokerOrderId: dto.orderId,
    errorReason: dto.message,
  }
}
