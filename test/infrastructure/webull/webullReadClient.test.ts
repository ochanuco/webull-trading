import { describe, expect, it, vi } from 'vitest'
import { WebullReadClient } from '../../../src/infrastructure/webull/WebullReadClient'
import type {
  WebullAccountDto,
  WebullPositionDto,
} from '../../../src/infrastructure/webull/dto'

describe('WebullReadClient', () => {
  // #21: read facade は HTTP client への単純な passthrough。重要なのは
  // **write メソッドが型にも実装にも存在しない** こと。コードレビューで
  // この test を見て「placeOrder が無い」が一目で分かるよう、明示的に確認。
  it('exposes only the read methods and does not expose placeOrder', () => {
    const dummy = {
      listSubscriptions: vi.fn(),
      getAccount: vi.fn(),
      findOrderByClientId: vi.fn(),
      getPositions: vi.fn(),
      getAvailableQtyForSymbol: vi.fn(),
    }
    const client = new WebullReadClient(
      dummy as unknown as ConstructorParameters<typeof WebullReadClient>[0],
    )

    expect(typeof client.listSubscriptions).toBe('function')
    expect(typeof client.getAccount).toBe('function')
    expect(typeof client.findOrderByClientId).toBe('function')
    expect(typeof client.getPositions).toBe('function')
    expect(typeof client.getAvailableQtyForSymbol).toBe('function')

    expect('placeOrder' in client).toBe(false)
  })

  // Forwarding sanity: getPositions must hit the underlying client. Without
  // this the facade could be a no-op and tests of consumers would still pass
  // against mocks.
  it('forwards getPositions to the underlying http client', async () => {
    const positions: WebullPositionDto[] = [
      { symbol: 'AAPL', available_quantity: '5' } as WebullPositionDto,
    ]
    const dummy = {
      listSubscriptions: vi.fn(),
      getAccount: vi.fn(),
      findOrderByClientId: vi.fn(),
      getPositions: vi.fn(async () => positions),
      getAvailableQtyForSymbol: vi.fn(),
    }
    const client = new WebullReadClient(
      dummy as unknown as ConstructorParameters<typeof WebullReadClient>[0],
    )

    const result = await client.getPositions()
    expect(result).toBe(positions)
    expect(dummy.getPositions).toHaveBeenCalledTimes(1)
  })

  it('forwards getAccount to the underlying http client', async () => {
    const account: WebullAccountDto = { account_id: 'acct-1' } as WebullAccountDto
    const dummy = {
      listSubscriptions: vi.fn(),
      getAccount: vi.fn(async () => account),
      findOrderByClientId: vi.fn(),
      getPositions: vi.fn(),
      getAvailableQtyForSymbol: vi.fn(),
    }
    const client = new WebullReadClient(
      dummy as unknown as ConstructorParameters<typeof WebullReadClient>[0],
    )

    const result = await client.getAccount()
    expect(result).toBe(account)
    expect(dummy.getAccount).toHaveBeenCalledTimes(1)
  })
})
