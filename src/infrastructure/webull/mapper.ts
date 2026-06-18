import type { ExecutionResult } from '../../trading/domain/ExecutionResult'
import type { OrderIntent } from '../../trading/domain/OrderIntent'
import type { WebullMarket, WebullPlaceOrderRequestDto, WebullPlaceOrderResponseDto } from './dto'

/**
 * Place Order body schema version (#251 / #256)。
 *
 * - 'v1' (default / 現挙動): 旧 SDK shape。\`support_trading_session='N'\`、
 *   \`limit_price\` は MARKET にも送る、\`account_id\` は query param 側、
 *   \`combo_type\` 無し。
 * - 'v2' (新 OpenAPI docs / opt-in): \`combo_type='NORMAL'\` 必須、
 *   \`support_trading_session='CORE'\` (旧 'N' は新 enum に無い)、MARKET 注文では
 *   \`limit_price\` を送らない、\`account_id\` を body へ。
 */
export type PlaceOrderSchemaVersion = 'v1' | 'v2'

export function toWebullPlaceOrderRequest(
  intent: OrderIntent,
  schema: PlaceOrderSchemaVersion = 'v1',
  accountId?: string,
): WebullPlaceOrderRequestDto {
  const symbol = intent.symbol.toUpperCase()
  const isMarket = true // 現状 strategy は MARKET 注文のみ
  const baseEntry = {
    client_order_id: intent.clientOrderId,
    symbol,
    instrument_type: 'EQUITY' as const,
    market: inferWebullMarket(symbol),
    order_type: 'MARKET' as const,
    quantity: String(intent.quantity),
    side: intent.side,
    time_in_force: 'DAY' as const,
    entrust_type: 'QTY' as const,
    account_tax_type: 'SPECIFIC' as const,
  }
  if (schema === 'v2') {
    return {
      // v2: account_id は body 側
      ...(accountId !== undefined ? { account_id: accountId } : {}),
      new_orders: [
        {
          ...baseEntry,
          combo_type: 'NORMAL',
          // v2 enum: NIGHT/ALL/CORE/ALL_DAY ('N' は廃止)。POC は通常時間帯のみ → CORE。
          support_trading_session: 'CORE',
          // v2 + MARKET: limit_price 不要 (LIMIT/STOP_LOSS_LIMIT のみ required)。
          // 安全 cap が欲しい場合は order_type を LIMIT に変える別 PR 案件。
          ...(isMarket ? {} : { limit_price: intent.price.toFixed(3) }),
        },
      ],
    }
  }
  // v1: 現行挙動。MARKET でも safety cap として limit_price を必ず送る。
  return {
    new_orders: [
      {
        ...baseEntry,
        // sandbox の fill simulator が limit 注文を通さないので POC は MARKET。
        // v1 schema は MARKET でも limit_price 必須 (safety cap)。
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
