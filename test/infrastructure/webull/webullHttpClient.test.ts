import { describe, expect, it, vi } from 'vitest'
import { WebullAuth } from '../../../src/infrastructure/webull/WebullAuth'
import { WebullHttpClient } from '../../../src/infrastructure/webull/WebullHttpClient'
import type { OrderIntent } from '../../../src/trading/domain/OrderIntent'

const intent: OrderIntent = {
  symbol: 'SOXL',
  side: 'BUY',
  quantity: 2,
  price: 9.5,
  notional: 19,
}

describe('WebullHttpClient', () => {
  it('places an order with the expected method, URL, body, and auth header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          orderId: 'ord-123',
          status: 'SUBMITTED',
          symbol: 'SOXL',
          side: 'BUY',
          quantity: 2,
          limitPrice: 9.5,
        }),
        { status: 200 },
      ),
    )
    const client = new WebullHttpClient({
      auth: new WebullAuth({
        appKey: 'app-key',
        appSecret: 'app-secret',
        accountId: 'acct-1',
      }),
      baseUrl: 'https://broker.example.test',
      fetchFn: fetchMock,
    })

    await client.placeOrder(intent)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://broker.example.test/order/place')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({
      symbol: 'SOXL',
      side: 'BUY',
      quantity: 2,
      limitPrice: 9.5,
    }))
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Webull-App-Key': 'app-key',
      'X-Webull-Account-Id': 'acct-1',
    })
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^HMAC app-key:/)
  })

  it('times out when fetch does not complete before the deadline', async () => {
    const fetchMock = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    })
    const client = new WebullHttpClient({
      auth: new WebullAuth({
        appKey: 'app-key',
        appSecret: 'app-secret',
        accountId: 'acct-1',
      }),
      timeoutMs: 20,
      fetchFn: fetchMock,
    })

    await expect(client.placeOrder(intent)).rejects.toThrow('Webull request timed out after 20ms')
  })
})
