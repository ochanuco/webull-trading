import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullMarket, WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

export function toWebullPlaceOrderRequest(intent: OrderIntent): WebullPlaceOrderRequestDto {
  const symbol = intent.symbol.toUpperCase()
  return {
    new_orders: [
      {
        client_order_id: crypto.randomUUID().replaceAll('-', ''),
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

// 4-digit numeric codes are Japanese exchange tickers (TYO / TSE). Anything else
// is treated as US by default. Extend this when adding other markets.
export function inferWebullMarket(symbol: string): WebullMarket {
  return /^\d{4}$/.test(symbol) ? 'JP' : 'US'
}
