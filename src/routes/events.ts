import { Hono } from 'hono'
import type { TradeEventIngestRequest } from '../infrastructure/webull/TradeEventBridge'
import { TradeEventService } from '../trading/application/TradeEventService'
import type { TradeEvent } from '../trading/domain/TradeEvent'

const tradeEventService = new TradeEventService()

export const events = new Hono().post('/trade', async (c) => {
  const payload = (await c.req.json().catch(() => null)) as unknown

  if (!isTradeEventIngestRequest(payload)) {
    return c.json({ error: 'Bad Request' }, 400)
  }

  await tradeEventService.handle(payload.event)

  return c.json({ ok: true })
})

function isTradeEventIngestRequest(value: unknown): value is TradeEventIngestRequest {
  if (!isRecord(value)) {
    return false
  }

  return isTradeEvent(value.event)
}

function isTradeEvent(value: unknown): value is TradeEvent {
  if (!isRecord(value)) {
    return false
  }

  if (
    typeof value.eventType !== 'string' ||
    typeof value.orderId !== 'string' ||
    typeof value.symbol !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.receivedAt !== 'string'
  ) {
    return false
  }

  if ('filledQty' in value && value.filledQty !== undefined && typeof value.filledQty !== 'number') {
    return false
  }

  return 'rawPayload' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
