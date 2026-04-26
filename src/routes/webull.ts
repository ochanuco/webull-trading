import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import type { WebullPlaceOrderResponseDto } from '../infrastructure/webull/dto'
import { logPostSubmit, logPreSubmit } from '../infrastructure/logger/tradeJournal'
import { ValidationError } from '../shared/errors'
import type { OrderIntent, OrderSide } from '../trading/domain/OrderIntent'

/**
 * Low-level Webull connectivity endpoint. Intentionally limited to dry-run
 * mode so it cannot bypass the TradingService risk gate (allowed_symbols /
 * max_order_notional / pending lock / spread / drawdown kill, etc).
 *
 * Live execution must go through `/trade/execute` or `/admin/strategy/run`,
 * which run the full risk pipeline before talking to the broker. See
 * issue #137 for the rationale.
 */
export const webull = new Hono<AppBindings>().post('/order/place', async (c) => {
  const intent = await parseOrderIntent(c.req.json())
  const requestId = c.get('requestId')

  logPreSubmit({ requestId, clientOrderId: intent.clientOrderId, intent })

  const global = await loadGlobalConfigFrom(c.env)
  if (!global.dryRun) {
    logPostSubmit({
      requestId,
      clientOrderId: intent.clientOrderId,
      symbol: intent.symbol,
      result: { mode: 'LIVE', submitted: false, errorReason: 'webull_place_blocked_live' },
      latencyMs: 0,
    })
    console.log(
      JSON.stringify({
        event: 'webull_place_blocked_live',
        request_id: requestId,
        client_order_id: intent.clientOrderId,
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        notional: intent.notional,
      }),
    )
    return c.json(
      {
        error: 'live_execution_forbidden',
        message:
          'low-level live execution is forbidden; use /trade/execute or /admin/strategy/run',
      },
      403,
    )
  }

  const dto = createDryRunResponse(intent)
  logPostSubmit({
    requestId,
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    result: { mode: 'DRY_RUN', submitted: true, brokerOrderId: dto.order_id },
    latencyMs: 0,
  })
  return c.json(dto)
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
