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
  clientOrderId: 'test-coid',
}

function createClient(fetchFn: typeof fetch, timeoutMs?: number): WebullHttpClient {
  return new WebullHttpClient({
    auth: new WebullAuth({
      appKey: 'app-key',
      appSecret: 'app-secret',
    }),
    accountId: 'acct-1',
    baseUrl: 'https://broker.example.test',
    timeoutMs,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 0,
      multiplier: 2,
      jitter: 0,
    },
    fetchFn,
  })
}

describe('WebullHttpClient', () => {
  it('signs using pathname only (query stays in canonical sorted pairs, not the path prefix)', async () => {
    // Regression: previously we passed `pathname + search` to auth.createHeaders,
    // which duplicated `account_id` in the canonical string (once inside the path,
    // once in the sorted pairs) and triggered Webull 401 UNAUTHORIZED.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ client_order_id: 'c', order_id: 'o' }), { status: 200 }),
    )
    const auth = new WebullAuth({ appKey: 'app-key', appSecret: 'app-secret' })
    const spy = vi.spyOn(auth, 'createHeaders')
    const client = new WebullHttpClient({
      auth,
      accountId: 'acct-1',
      baseUrl: 'https://broker.example.test',
      retry: { maxAttempts: 1, baseDelayMs: 0, multiplier: 2, jitter: 0 },
      fetchFn: fetchMock,
    })

    await client.placeOrder(intent)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toMatchObject({
      path: '/openapi/account/orders/place',
      query: { account_id: 'acct-1' },
    })
  })

  it('places an order via the v2 endpoint with the expected body and auth headers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          client_order_id: 'cli-123',
          order_id: 'ord-123',
        }),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)

    await client.placeOrder(intent)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://broker.example.test/openapi/account/orders/place?account_id=acct-1')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toMatchObject({
      new_orders: [
        {
          client_order_id: expect.any(String),
          symbol: 'SOXL',
          instrument_type: 'EQUITY',
          market: 'US',
          order_type: 'LIMIT',
          limit_price: '9.500',
          quantity: '2',
          support_trading_session: 'N',
          side: 'BUY',
          time_in_force: 'DAY',
          entrust_type: 'QTY',
          account_tax_type: 'GENERAL',
        },
      ],
    })
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      host: 'broker.example.test',
      'x-app-key': 'app-key',
      'x-signature-algorithm': 'HMAC-SHA1',
      'x-signature-version': '1.0',
      'x-signature-nonce': expect.any(String),
      'x-timestamp': expect.any(String),
      'x-version': 'v1',
      'x-signature': expect.any(String),
    })
  })

  it('infers JP market for 4-digit numeric tickers', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ client_order_id: 'cli', order_id: 'ord' }), { status: 200 }),
    )
    const client = createClient(fetchMock)

    await client.placeOrder({
      symbol: '1570',
      side: 'BUY',
      quantity: 1,
      price: 25000,
      notional: 25000,
      clientOrderId: 'test-coid-jp',
    })

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)
    expect(body.new_orders[0].market).toBe('JP')
    expect(body.new_orders[0].symbol).toBe('1570')
  })

  it('findOrderByClientId fetches orders/history and filters client-side', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { client_order_id: 'other-1', status: 'PENDING' },
          { client_order_id: 'coid-123', order_id: 'ord-abc', symbol: 'SOXL', status: 'FILLED', filled_quantity: '1' },
          { client_order_id: 'other-2', status: 'CANCELLED' },
        ]),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)

    const detail = await client.findOrderByClientId('coid-123')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    const u = new URL(url as string)
    // History endpoint — the JP UAT tenant does not expose /orders/detail.
    expect(u.pathname).toBe('/openapi/account/orders/history')
    expect(u.searchParams.get('account_id')).toBe('acct-1')
    expect(u.searchParams.get('page_size')).toBe('50')
    expect(init?.method).toBe('GET')
    expect(detail?.status).toBe('FILLED')
  })

  it('findOrderByClientId returns undefined when the coid is not in the history page', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ client_order_id: 'unrelated' }]), { status: 200 }),
    )
    const client = createClient(fetchMock)
    expect(await client.findOrderByClientId('missing')).toBeUndefined()
  })

  it('requests account details from the documented profile endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          accountId: 'acct-1',
          status: 'OPEN',
        }),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)

    await client.getAccount()

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://broker.example.test/account/profile?account_id=acct-1')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toMatchObject({
      Accept: 'application/json',
      host: 'broker.example.test',
      'x-app-key': 'app-key',
      'x-signature': expect.any(String),
    })
  })

  it('retries a transient 500 response and succeeds on the next attempt', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('server error', { status: 500 }))
      .mockResolvedValueOnce(
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
    const client = createClient(fetchMock)

    await expect(client.placeOrder(intent)).resolves.toMatchObject({
      orderId: 'ord-123',
      status: 'SUBMITTED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws BrokerRequestError with the last status after exhausting retries on 500 responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('server error', { status: 500 }))
    const client = createClient(fetchMock)

    await expect(client.placeOrder(intent)).rejects.toThrow(
      'Webull request failed after 3 attempts with last status 500',
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails fast on 4xx responses without retrying', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad request', { status: 400 }))
    const client = createClient(fetchMock)

    await expect(client.placeOrder(intent)).rejects.toThrow(
      'Webull request failed permanently with status 400',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries AbortError failures', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            orderId: 'ord-456',
            status: 'SUBMITTED',
            symbol: 'SOXL',
            side: 'BUY',
            quantity: 2,
            limitPrice: 9.5,
          }),
          { status: 200 },
        ),
      )
    const client = createClient(fetchMock, 20)

    await expect(client.placeOrder(intent)).resolves.toMatchObject({
      orderId: 'ord-456',
      status: 'SUBMITTED',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('listSubscriptions hits /app/subscriptions/list and returns the array', async () => {
    const subscriptions = [
      { subscription_id: 'sub-1', user_id: 'u-1', account_id: 'acct-abc', account_number: '123' },
    ]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(subscriptions), { status: 200 }))
    const client = createClient(fetchMock)

    const result = await client.listSubscriptions()

    expect(result).toEqual(subscriptions)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/app/subscriptions/list')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
  })
})
