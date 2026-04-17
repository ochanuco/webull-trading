import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppBindings } from '../app'
import { parseBooleanEnv } from '../config/env'
import { createWebullHttpClient } from '../infrastructure/webull/WebullHttpClient'
import type { WebullPlaceOrderResponseDto } from '../infrastructure/webull/dto'
import type { OrderIntent, OrderSide } from '../trading/domain/OrderIntent'

export const webull = new Hono<AppBindings>().post('/order/place', async (c) => {
  const intent = await parseOrderIntent(c.req.json())

  if (parseBooleanEnv(c.env.DRY_RUN, true)) {
    return c.json(createDryRunResponse(intent))
  }

  const client = createWebullHttpClient(c.env)
  return c.json(await client.placeOrder(intent))
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
  }
}

function createDryRunResponse(intent: OrderIntent): WebullPlaceOrderResponseDto {
  return {
    orderId: `dry-run-${crypto.randomUUID()}`,
    status: 'DRY_RUN',
    symbol: intent.symbol,
    side: intent.side,
    quantity: intent.quantity,
    limitPrice: intent.price,
    message: 'DRY_RUN=true, broker request skipped',
    submittedAt: new Date().toISOString(),
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
    throw new HTTPException(400, { message: 'symbol must be a non-empty string' })
  }

  return value.trim().toUpperCase()
}

function readSide(value: unknown): OrderSide {
  if (value === 'BUY' || value === 'SELL') {
    return value
  }

  throw new HTTPException(400, { message: 'side must be BUY or SELL' })
}

function readPositiveNumber(value: unknown, field: 'price' | 'quantity'): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }

  throw new HTTPException(400, { message: `${field} must be a finite number greater than 0` })
}
