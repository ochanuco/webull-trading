import { describe, expect, it, vi } from 'vitest'
import { BrokerRequestError } from '../../../src/shared/errors'
import { WebullExecution } from '../../../src/trading/execution/WebullExecution'
import type { OrderIntent } from '../../../src/trading/domain/OrderIntent'

const intent: OrderIntent = {
  symbol: 'SOXL',
  side: 'BUY',
  quantity: 2,
  price: 9,
  notional: 18,
  clientOrderId: 'test-coid',
}

describe('WebullExecution', () => {
  it('maps the Webull response into an ExecutionResult', async () => {
    const client = {
      placeOrder: vi.fn().mockResolvedValue({
        client_order_id: 'cli-123',
        order_id: 'ord-123',
      }),
    }
    // test 用に WebullTradeClient の `placeOrder` のみ実装した minimal mock を
    // 型 cast で渡す。`isLiveTradingEnabled` getter は WebullExecution が読まないので不要。
    const execution = new WebullExecution(
      client as unknown as ConstructorParameters<typeof WebullExecution>[0],
    )

    await expect(execution.execute(intent)).resolves.toEqual({
      mode: 'LIVE',
      submitted: true,
      brokerOrderId: 'ord-123',
      errorReason: undefined,
    })
    expect(client.placeOrder).toHaveBeenCalledWith(intent)
  })

  it('wraps broker failures in BrokerRequestError', async () => {
    const client = {
      placeOrder: vi.fn().mockRejectedValue(new Error('network down')),
    }
    // test 用に WebullTradeClient の `placeOrder` のみ実装した minimal mock を
    // 型 cast で渡す。`isLiveTradingEnabled` getter は WebullExecution が読まないので不要。
    const execution = new WebullExecution(
      client as unknown as ConstructorParameters<typeof WebullExecution>[0],
    )

    await expect(execution.execute(intent)).rejects.toBeInstanceOf(BrokerRequestError)
    await expect(execution.execute(intent)).rejects.toMatchObject({
      operation: 'placeOrder',
      cause: expect.any(Error),
    })
  })
})
