import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullMarket, WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

export function toWebullPlaceOrderRequest(intent: OrderIntent): WebullPlaceOrderRequestDto {
  const symbol = intent.symbol.toUpperCase()
  const market = inferWebullMarket(symbol)
  return {
    new_orders: [
      {
        client_order_id: intent.clientOrderId,
        symbol,
        instrument_type: 'EQUITY',
        market,
        order_type: 'LIMIT',
        limit_price: intent.price.toFixed(3),
        quantity: String(intent.quantity),
        support_trading_session: 'N',
        side: intent.side,
        time_in_force: 'DAY',
        entrust_type: 'QTY',
        account_tax_type: 'GENERAL',
        // US orders on the JP UAT tenant's US_MARGIN account require a
        // margin_type. The Webull enum exposes ONE_DAY (intraday) and
        // INDEFINITE (can hold overnight). Pullback is a swing strategy →
        // INDEFINITE. Leveraged securities (SOXL / SOXS) are rejected with
        // OPENAPI_SECURITY_NOT_SUPPORT_MARGIN_TRADE regardless of value;
        // exclude them from the cron universe rather than trying to work
        // around it here.
        // JP orders go through the CASH account (JPY, non-margin) and must
        // NOT carry margin_type.
        ...(market === 'US' ? { margin_type: 'INDEFINITE' } : {}),
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
