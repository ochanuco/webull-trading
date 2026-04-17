import {
  isTradeEventType,
  isTradeStatus,
  type TradeEvent,
  type TradeEventType,
  type TradeStatus,
} from '../../src/trading/domain/TradeEvent'

export function mapWebullTradeEvent(rawPayload: unknown, receivedAt: string = new Date().toISOString()): TradeEvent {
  const payload = asRecord(rawPayload)
  const order = asOptionalRecord(payload.order)

  const eventType = readRequiredEnum(payload, ['eventType', 'event_type', 'type'], isTradeEventType)
  const orderId = readRequiredString(payload, ['orderId', 'order_id'], order)
  const symbol = readRequiredString(payload, ['symbol', 'ticker'], order)
  const status = readRequiredEnum(payload, ['status', 'orderStatus'], isTradeStatus, order)
  const filledQty = readOptionalNonNegativeNumber(payload, ['filledQty', 'filled_qty', 'filledQuantity'], order)

  return {
    eventType,
    orderId,
    symbol,
    status,
    ...(filledQty === undefined ? {} : { filledQty }),
    rawPayload,
    receivedAt,
  }
}

function readRequiredString(
  payload: Record<string, unknown>,
  keys: string[],
  nested?: Record<string, unknown>,
): string {
  for (const key of keys) {
    const value = payload[key] ?? nested?.[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }
  }

  throw new Error(`Missing required trade event field: ${keys.join(', ')}`)
}

function readRequiredEnum<T extends string>(
  payload: Record<string, unknown>,
  keys: string[],
  predicate: (value: string) => value is T,
  nested?: Record<string, unknown>,
): T {
  const value = readRequiredString(payload, keys, nested)
  if (predicate(value)) {
    return value
  }

  throw new Error(`Invalid trade event field: ${keys.join(', ')}`)
}

function readOptionalNonNegativeNumber(
  payload: Record<string, unknown>,
  keys: string[],
  nested?: Record<string, unknown>,
): number | undefined {
  for (const key of keys) {
    const value = payload[key] ?? nested?.[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsedValue = Number(value)
      if (Number.isFinite(parsedValue) && parsedValue >= 0) {
        return parsedValue
      }
    }
  }

  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Trade event payload must be an object')
  }

  return value as Record<string, unknown>
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  return value as Record<string, unknown>
}
