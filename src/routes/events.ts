import { Hono } from 'hono'
import type { AppBindings } from '../app'
import type { TradeEventIngestRequest } from '../infrastructure/webull/TradeEventBridge'
import { ValidationError } from '../shared/errors'
import { TradeEventService } from '../trading/application/TradeEventService'
import { isTradeEventType, isTradeStatus, type TradeEvent } from '../trading/domain/TradeEvent'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'

export const events = new Hono<AppBindings>().post('/trade', async (c) => {
  const payload = (await c.req.json().catch(() => null)) as unknown

  if (!isTradeEventIngestRequest(payload)) {
    throw new ValidationError('event payload is invalid', { field: 'event' })
  }

  const service = new TradeEventService({
    positionStore: c.env.SYMBOL_STATE ? new SymbolStateClient(c.env.SYMBOL_STATE) : undefined,
    portfolioStore: c.env.PORTFOLIO_STATE
      ? new PortfolioStateClient(c.env.PORTFOLIO_STATE)
      : undefined,
  })
  await service.handle(payload.event)

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

  if (!isTradeEventType(value.eventType) || !isTradeStatus(value.status)) {
    return false
  }

  if ('filledQty' in value && value.filledQty !== undefined && typeof value.filledQty !== 'number') {
    return false
  }

  return 'rawPayload' in value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
