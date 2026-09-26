import { describe, expect, it, vi } from 'vitest'
import {
  TradeDisabledError,
  WebullTradeClient,
} from '../../../src/infrastructure/webull/WebullTradeClient'
import type { OrderIntent } from '../../../src/trading/domain/OrderIntent'
import type { WebullPlaceOrderResponseDto } from '../../../src/infrastructure/webull/dto'

const intent: OrderIntent = {
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 1,
  price: 200,
  notional: 200,
  clientOrderId: 'test-coid-1',
}

const okResponse: WebullPlaceOrderResponseDto = { order_id: 'ord-1' }

// vitest v4 infers `vi.fn()` as `Mock<Procedure | Constructable>` which does
// not satisfy `Pick<WebullHttpClient, 'placeOrder'>['placeOrder']`. Pin the
// generic to the exact method signature so v4 typecheck accepts the stub and
// v2 keeps working (the generic form is supported by both versions).
type PlaceOrderFn = (intent: OrderIntent) => Promise<WebullPlaceOrderResponseDto>

function fakeHttp(): { placeOrder: ReturnType<typeof vi.fn<PlaceOrderFn>> } {
  return { placeOrder: vi.fn<PlaceOrderFn>(async () => okResponse) }
}

describe('WebullTradeClient', () => {
  // #21: live orders are produced only when ENVIRONMENT="production", set via
  // wrangler.jsonc::env.production.vars.
  it('forwards placeOrder to the underlying client when ENVIRONMENT="production"', async () => {
    const http = fakeHttp()
    const client = new WebullTradeClient(http, { ENVIRONMENT: 'production' })
    expect(client.isLiveTradingEnabled).toBe(true)

    const result = await client.placeOrder(intent)

    expect(result).toEqual(okResponse)
    expect(http.placeOrder).toHaveBeenCalledTimes(1)
    expect(http.placeOrder).toHaveBeenCalledWith(intent)
  })

  // Webull JP is one app per user, so staging and production share the same
  // API key — this in-code gate is the last line of defense before a broker call.
  it.each([
    ['staging', 'staging'],
    ['dev', 'dev'],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
    ['unexpected-value', 'preview'],
  ])(
    'rejects placeOrder with TradeDisabledError when ENVIRONMENT is %s',
    async (_label, value) => {
      const http = fakeHttp()
      const client = new WebullTradeClient(http, { ENVIRONMENT: value })
      expect(client.isLiveTradingEnabled).toBe(false)

      await expect(client.placeOrder(intent)).rejects.toBeInstanceOf(TradeDisabledError)
      // This file's load-bearing assertion: http.placeOrder must never be reached.
      expect(http.placeOrder).not.toHaveBeenCalled()
    },
  )

  it('TradeDisabledError messages include the offending ENVIRONMENT for log clarity', async () => {
    const http = fakeHttp()
    const client = new WebullTradeClient(http, { ENVIRONMENT: 'staging' })

    await expect(client.placeOrder(intent)).rejects.toThrow(/staging/)
  })

  it('trims surrounding whitespace before comparing ENVIRONMENT to "production"', async () => {
    // Deliberately permissive: follows the accident of `wrangler secret put`
    // picking up leading/trailing whitespace, rather than fail-closed on it.
    const http = fakeHttp()
    const client = new WebullTradeClient(http, { ENVIRONMENT: '  production  ' })
    expect(client.isLiveTradingEnabled).toBe(true)

    await client.placeOrder(intent)
    expect(http.placeOrder).toHaveBeenCalledTimes(1)
  })
})
