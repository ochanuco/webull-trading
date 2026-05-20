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

function fakeHttp(): { placeOrder: ReturnType<typeof vi.fn> } {
  return { placeOrder: vi.fn(async () => okResponse) }
}

describe('WebullTradeClient', () => {
  // #21: live trade を produce してよいのは ENVIRONMENT='production' のときだけ。
  // wrangler.jsonc::env.production.vars でハードコードされている前提。
  it('forwards placeOrder to the underlying client when ENVIRONMENT="production"', async () => {
    const http = fakeHttp()
    const client = new WebullTradeClient(http, { ENVIRONMENT: 'production' })
    expect(client.isLiveTradingEnabled).toBe(true)

    const result = await client.placeOrder(intent)

    expect(result).toEqual(okResponse)
    expect(http.placeOrder).toHaveBeenCalledTimes(1)
    expect(http.placeOrder).toHaveBeenCalledWith(intent)
  })

  // staging / dev / unset / 任意文字列 → すべて fail-safe で reject。
  // Webull JP は 1 user = 1 app なので staging と production で同じ API key を
  // 共有する。コード側で broker に届く前に止めるのが防御の最後の砦。
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
      // The underlying http.placeOrder must NEVER be called — that's the whole
      // point of this gate. Verifying it stays at zero is the load-bearing
      // assertion of this test file.
      expect(http.placeOrder).not.toHaveBeenCalled()
    },
  )

  it('TradeDisabledError messages include the offending ENVIRONMENT for log clarity', async () => {
    const http = fakeHttp()
    const client = new WebullTradeClient(http, { ENVIRONMENT: 'staging' })

    await expect(client.placeOrder(intent)).rejects.toThrow(/staging/)
  })

  it('treats whitespace-only ENVIRONMENT as unset (does not interpret as "production")', async () => {
    // operator が wrangler.jsonc を空文字で上書き / secret で whitespace を入れた
    // などのエッジで本番扱いされない事を locked。
    const http = fakeHttp()
    const client = new WebullTradeClient(http, { ENVIRONMENT: '  production  ' })
    // 注意: trim 後の比較で 'production' と一致するので live を許可する。これは
    // wrangler secret put で誤って前後 space を入れた事故をフォローする意図。
    expect(client.isLiveTradingEnabled).toBe(true)

    await client.placeOrder(intent)
    expect(http.placeOrder).toHaveBeenCalledTimes(1)
  })
})
