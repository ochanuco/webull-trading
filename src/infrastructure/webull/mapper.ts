import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullMarket, WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

/** Place Order body shape: 'v1' is the legacy SDK shape (default); 'v2' is the newer OpenAPI-documented shape (opt-in). */
export type PlaceOrderSchemaVersion = 'v1' | 'v2'

export function toWebullPlaceOrderRequest(
  intent: OrderIntent,
  schema: PlaceOrderSchemaVersion = 'v1',
  accountId?: string,
): WebullPlaceOrderRequestDto {
  const symbol = intent.symbol.toUpperCase()
  const isMarket = true // MARKET is the only order type strategies submit today
  const baseEntry = {
    client_order_id: intent.clientOrderId,
    symbol,
    instrument_type: 'EQUITY' as const,
    market: inferWebullMarket(symbol),
    order_type: 'MARKET' as const,
    quantity: String(intent.quantity),
    side: intent.side,
    // Required in both schemas: omitted, Webull treats a SELL as opening a short and 417s a cash account.
    open_or_close: (intent.side === 'BUY' ? 'OPEN' : 'CLOSE') as 'OPEN' | 'CLOSE',
    time_in_force: 'DAY' as const,
    entrust_type: 'QTY' as const,
    account_tax_type: 'SPECIFIC' as const,
  }
  if (schema === 'v2') {
    return {
      ...(accountId !== undefined ? { account_id: accountId } : {}),
      new_orders: [
        {
          ...baseEntry,
          combo_type: 'NORMAL',
          // v2 enum has no 'N'; CORE is the regular-hours session (vs NIGHT/ALL/ALL_DAY).
          support_trading_session: 'CORE',
          // v2 requires limit_price only for LIMIT/STOP_LOSS_LIMIT, not MARKET.
          ...(isMarket ? {} : { limit_price: intent.price.toFixed(3) }),
        },
      ],
    }
  }
  return {
    new_orders: [
      {
        ...baseEntry,
        // v1 requires limit_price even for MARKET; doubles as a safety cap since the sandbox never fills LIMIT orders.
        limit_price: intent.price.toFixed(3),
        support_trading_session: 'N',
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
