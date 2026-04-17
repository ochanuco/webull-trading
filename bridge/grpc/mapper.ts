import type { TradeEvent } from '../../src/trading/domain/TradeEvent'

export function mapWebullTradeEvent(rawPayload: unknown, receivedAt: string = new Date().toISOString()): TradeEvent {
  const payload = asRecord(rawPayload)
  const order = asOptionalRecord(payload.order)

  const eventType = readRequiredString(payload, ['eventType', 'event_type', 'type'])
  const orderId = readRequiredString(payload, ['orderId', 'order_id'], order)
  const symbol = readRequiredString(payload, ['symbol', 'ticker'], order)
  const status = readRequiredString(payload, ['status', 'orderStatus'], order)
  const filledQty = readOptionalNumber(payload, ['filledQty', 'filled_qty', 'filledQuantity'], order)

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

function readOptionalNumber(
  payload: Record<string, unknown>,
  keys: string[],
  nested?: Record<string, unknown>,
): number | undefined {
  for (const key of keys) {
    const value = payload[key] ?? nested?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsedValue = Number(value)
      if (Number.isFinite(parsedValue)) {
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
