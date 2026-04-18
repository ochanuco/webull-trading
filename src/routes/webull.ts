import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { parseBooleanEnv } from '../config/env'
import { createWebullHttpClient } from '../infrastructure/webull/WebullHttpClient'
import type { WebullPlaceOrderResponseDto } from '../infrastructure/webull/dto'
import { logPostSubmit, logPreSubmit } from '../infrastructure/logger/tradeJournal'
import { ValidationError } from '../shared/errors'
import type { OrderIntent, OrderSide } from '../trading/domain/OrderIntent'

export const webull = new Hono<AppBindings>().post('/order/place', async (c) => {
  const intent = await parseOrderIntent(c.req.json())
  const requestId = c.get('requestId')

  logPreSubmit({ requestId, clientOrderId: intent.clientOrderId, intent })

  if (parseBooleanEnv(c.env.DRY_RUN, true)) {
    const dto = createDryRunResponse(intent)
    logPostSubmit({
      requestId,
      clientOrderId: intent.clientOrderId,
      symbol: intent.symbol,
      result: { mode: 'DRY_RUN', submitted: true, brokerOrderId: dto.order_id },
      latencyMs: 0,
    })
    return c.json(dto)
  }

  const client = createWebullHttpClient(c.env)
  const startedAt = Date.now()
  let dto: WebullPlaceOrderResponseDto | undefined
  let error: Error | undefined
  try {
    dto = await client.placeOrder(intent)
    return c.json(dto)
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err))
    throw err
  } finally {
    logPostSubmit({
      requestId,
      clientOrderId: intent.clientOrderId,
      symbol: intent.symbol,
      result: dto
        ? { mode: 'LIVE', submitted: !!dto.order_id, brokerOrderId: dto.order_id, errorReason: dto.message }
        : undefined,
      latencyMs: Date.now() - startedAt,
      error,
    })
  }
})

async function parseOrderIntent(payload: Promise<unknown>): Promise<OrderIntent> {
  const body = asRecord(await payload)
  const symbol = readSymbol(body.symbol)
  const side = readSide(body.side)
  const quantity = readPositiveNumber(body.quantity, 'quantity')
  const price = readPositiveNumber(body.price, 'price')

  return {
    symbol,
    side,
    quantity,
    price,
    notional: quantity * price,
    clientOrderId: crypto.randomUUID().replaceAll('-', ''),
  }
}

function createDryRunResponse(intent: OrderIntent): WebullPlaceOrderResponseDto {
  return {
    client_order_id: intent.clientOrderId,
    order_id: `dry-run-${crypto.randomUUID()}`,
    message: 'DRY_RUN=true, broker request skipped',
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>
  }
  return {}
}

function readSymbol(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError('symbol must be a non-empty string', { field: 'symbol' })
  }

  return value.trim().toUpperCase()
}

function readSide(value: unknown): OrderSide {
  if (value === 'BUY' || value === 'SELL') {
    return value
  }

  throw new ValidationError('side must be BUY or SELL', { field: 'side' })
}

function readPositiveNumber(value: unknown, field: 'price' | 'quantity'): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }

  throw new ValidationError(`${field} must be a finite number greater than 0`, { field })
}
