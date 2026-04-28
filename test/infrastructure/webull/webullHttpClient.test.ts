import { describe, expect, it, vi } from 'vitest'
import {
  BrokerAuthError,
  BrokerClientError,
  BrokerRateLimitError,
  BrokerServerError,
} from '../../../src/shared/errors'
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
          order_type: 'MARKET',
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

  it('findOrderByClientId queries orders/history and filters the target coid client-side', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { client_order_id: 'other-1', status: 'PENDING' },
          { client_order_id: 'coid-123', symbol: 'SOXL', status: 'FILLED', filled_quantity: '1' },
        ]),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)
    const detail = await client.findOrderByClientId('coid-123')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const u = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(u.pathname).toBe('/openapi/account/orders/history')
    expect(u.searchParams.get('account_id')).toBe('acct-1')
    expect(u.searchParams.get('page_size')).toBe('50')
    expect(detail?.status).toBe('FILLED')
  })

  it('findOrderByClientId throws BrokerRequestError when no account id is configured', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new WebullHttpClient({
      auth: new WebullAuth({ appKey: 'app-key', appSecret: 'app-secret' }),
      baseUrl: 'https://broker.example.test',
      retry: { maxAttempts: 1, baseDelayMs: 0, multiplier: 1, jitter: 0 },
      fetchFn: fetchMock,
    })
    await expect(client.findOrderByClientId('whatever')).rejects.toThrow(/Missing Webull account ID/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('findOrderByClientId returns undefined when the coid is not on the recent history page', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ client_order_id: 'unrelated' }]), { status: 200 }),
    )
    const client = createClient(fetchMock)
    expect(await client.findOrderByClientId('missing')).toBeUndefined()
  })

  // #251 / #253: 新 OpenAPI docs では order-history が wrapper 形式
  // ({client_order_id, combo_type, orders[]}) で返るので、normalizer が
  // wrapper を flat 形式に projection することを確認。
  it('findOrderByClientId handles new wrapper response shape ({client_order_id, orders: [...]})', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            client_order_id: 'wrapped-1',
            combo_type: 'NORMAL',
            orders: [
              {
                symbol: 'SOXL',
                side: 'BUY',
                status: 'FILLED',
                total_quantity: '4',
                filled_quantity: '4',
                filled_price: '125.00',
              },
            ],
          },
        ]),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)
    const detail = await client.findOrderByClientId('wrapped-1')
    expect(detail).toBeDefined()
    expect(detail?.client_order_id).toBe('wrapped-1')
    expect(detail?.symbol).toBe('SOXL')
    expect(detail?.status).toBe('FILLED')
    expect(detail?.filled_quantity).toBe('4')
    expect(detail?.filled_price).toBe('125.00')
    // total_quantity → quantity に正規化されてること
    expect(detail?.quantity).toBe('4')
    expect(detail?.total_quantity).toBe('4')
  })

  it('findOrderByClientId handles legacy flat response shape (no orders[] wrapper)', async () => {
    // 旧 shape は normalizer が pass-through すること (= 既存 callers が引き
    // 続き動く backward compat)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { client_order_id: 'flat-1', symbol: 'AAPL', status: 'FILLED', quantity: '8', filled_quantity: '8' },
        ]),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)
    const detail = await client.findOrderByClientId('flat-1')
    expect(detail?.symbol).toBe('AAPL')
    expect(detail?.quantity).toBe('8')
    expect(detail?.status).toBe('FILLED')
  })

  // CodeRabbit #261 finding 1: wrapper の `orders[]` が空のケース。
  // partial detail (client_order_id だけ持つ) を返すと incomplete data が
  // caller に渡るので、normalizer は空オブジェクト → find で skip される。
  it('findOrderByClientId returns undefined when wrapper has empty orders[]', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          { client_order_id: 'empty-wrapper', combo_type: 'NORMAL', orders: [] },
          { client_order_id: 'unrelated', symbol: 'NVDA', status: 'PENDING' },
        ]),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)
    expect(await client.findOrderByClientId('empty-wrapper')).toBeUndefined()
  })

  // CodeRabbit #261 finding 2: top-level に client_order_id が無く inner 側
  // にあるパターン。normalizer は inner.client_order_id を fallback として使う。
  it('findOrderByClientId falls back to inner client_order_id when top-level is missing', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            // top-level に client_order_id が無いケース (新 docs で稀にあり得る)
            combo_type: 'NORMAL',
            orders: [
              {
                client_order_id: 'inner-only-1',
                symbol: 'SOXL',
                side: 'SELL',
                status: 'FILLED',
                total_quantity: '8',
                filled_quantity: '8',
              },
            ],
          },
        ]),
        { status: 200 },
      ),
    )
    const client = createClient(fetchMock)
    const detail = await client.findOrderByClientId('inner-only-1')
    expect(detail).toBeDefined()
    expect(detail?.client_order_id).toBe('inner-only-1')
    expect(detail?.symbol).toBe('SOXL')
    expect(detail?.quantity).toBe('8') // total_quantity → quantity 正規化
    expect(detail?.status).toBe('FILLED')
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

  it('maps 401 to BrokerAuthError (and does not retry)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('unauth', { status: 401 }))
    const client = createClient(fetchMock)
    await expect(client.placeOrder(intent)).rejects.toBeInstanceOf(BrokerAuthError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps 429 to BrokerRateLimitError (and does not retry inside the 4xx branch)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('slow down', { status: 429 }))
    const client = createClient(fetchMock)
    await expect(client.placeOrder(intent)).rejects.toBeInstanceOf(BrokerRateLimitError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a non-auth 4xx to BrokerClientError', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 400 }))
    const client = createClient(fetchMock)
    await expect(client.placeOrder(intent)).rejects.toBeInstanceOf(BrokerClientError)
  })

  it('maps a retried-out 5xx to BrokerServerError with brokerStatus set', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 503 }))
    const client = createClient(fetchMock)
    const err = await client.placeOrder(intent).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerServerError)
    expect((err as BrokerServerError).brokerStatus).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('includes the JSON response body in the 4xx error message (Webull reject reason)', async () => {
    // 417 with a typical Webull error envelope. Without this the operator only
    // sees "status 417" in cron logs and cannot tell whether the rejection is
    // ORDER_INVALID_QTY, MARKET_CLOSED, etc.
    const body = JSON.stringify({
      code: 'ORDER_INVALID_QTY',
      message: 'requested quantity exceeds available holding',
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 417 }))
    const client = createClient(fetchMock)

    const err = await client.placeOrder(intent).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerClientError)
    expect((err as Error).message).toContain('status 417')
    expect((err as Error).message).toContain('ORDER_INVALID_QTY')
    expect((err as Error).message).toContain('requested quantity exceeds available holding')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('includes the plain-text response body in the 5xx retried-out error message', async () => {
    // A fresh Response per call — `Response.text()` consumes the body, so
    // returning the same instance across retries would make later attempts
    // see `<failed to read body>` instead of the real upstream message.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('Internal Server Error', { status: 500 }))
    const client = createClient(fetchMock)

    const err = await client.placeOrder(intent).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerServerError)
    expect((err as Error).message).toContain('Internal Server Error')
    expect((err as Error).message).toContain('after 3 attempts with last status 500')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('truncates oversized error bodies to keep log lines bounded', async () => {
    // 10KB HTML page from a CDN — we keep at most 1000 chars + the truncation
    // marker so the log line cannot blow up.
    const huge = 'A'.repeat(10_000)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(huge, { status: 502 }))
    const client = createClient(fetchMock)

    const err = await client.placeOrder(intent).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerServerError)
    const msg = (err as Error).message
    expect(msg).toContain('...[truncated]')
    // The truncated body itself ends at 1000 'A's; the full message has
    // additional surrounding text but should not contain anywhere near the
    // original 10K characters.
    expect(msg).not.toContain('A'.repeat(1100))
    expect(msg).toContain('A'.repeat(1000))
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

  it('embeds the response body snippet in the error message on 4xx (so SELL_QTY_EXCEED can be detected)', async () => {
    const errBody = JSON.stringify({
      code: 'OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY',
      msg: 'available_qty=4 < requested_qty=8',
    })
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(errBody, { status: 417 }))
    const client = createClient(fetchMock)
    const err = await client
      .placeOrder({ ...intent, side: 'SELL' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerClientError)
    expect((err as BrokerClientError).brokerStatus).toBe(417)
    expect((err as Error).message).toContain('OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY')
    expect((err as Error).message).toContain('status 417')
  })

  it('truncates an oversized error body in the message (no log explosion)', async () => {
    const huge = 'X'.repeat(2000)
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(huge, { status: 400 }))
    const client = createClient(fetchMock)
    const err = await client.placeOrder(intent).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerClientError)
    // The body is embedded after `status 400: ` and `readErrorBody` caps it
    // at ERROR_BODY_MAX_CHARS (=1000) plus a `...[truncated]` marker so the
    // upstream Webull error code stays visible without log explosion.
    const message = (err as Error).message
    const bodyIdx = message.indexOf('status 400: ')
    expect(bodyIdx).toBeGreaterThan(-1)
    const bodyPart = message.slice(bodyIdx + 'status 400: '.length)
    expect(bodyPart).toContain('...[truncated]')
    // 1000-char cap + the literal "...[truncated]" suffix (14 chars).
    expect(bodyPart.length).toBeLessThanOrEqual(1000 + '...[truncated]'.length)
  })

  it('getPositions hits /openapi/account/positions and returns the array', async () => {
    const positions = [
      {
        symbol: 'SOXL',
        quantity_total: '8',
        available_quantity: '4',
        avg_cost: '124.95',
        currency: 'USD',
      },
    ]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(positions), { status: 200 }))
    const client = createClient(fetchMock)
    const result = await client.getPositions()
    expect(result).toEqual(positions)
    const [url, init] = fetchMock.mock.calls[0]!
    const u = new URL(String(url))
    expect(u.pathname).toBe('/openapi/account/positions')
    expect(u.searchParams.get('account_id')).toBe('acct-1')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
  })

  it('getPositions throws BrokerRequestError when accountId is not configured', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const client = new WebullHttpClient({
      auth: new WebullAuth({ appKey: 'app-key', appSecret: 'app-secret' }),
      baseUrl: 'https://broker.example.test',
      retry: { maxAttempts: 1, baseDelayMs: 0, multiplier: 1, jitter: 0 },
      fetchFn: fetchMock,
    })
    await expect(client.getPositions()).rejects.toThrow(/Missing Webull account ID/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('getAvailableQtyForSymbol returns the parsed quantity when the symbol is held', async () => {
    const positions = [
      { symbol: 'SOXL', available_quantity: '4', quantity_total: '8' },
      { symbol: 'AAPL', available_quantity: '10', quantity_total: '10' },
    ]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(positions), { status: 200 }))
    const client = createClient(fetchMock)
    // case-insensitive match (broker returns canonical SOXL, caller may pass soxl)
    await expect(client.getAvailableQtyForSymbol('soxl')).resolves.toBe(4)
  })

  it('getAvailableQtyForSymbol returns null when available_quantity is non-numeric', async () => {
    const positions = [{ symbol: 'SOXL', available_quantity: 'NaN' }]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(positions), { status: 200 }))
    const client = createClient(fetchMock)
    await expect(client.getAvailableQtyForSymbol('SOXL')).resolves.toBeNull()
  })

  it('getAvailableQtyForSymbol returns 0 (not null) when available_quantity is "0"', async () => {
    const positions = [{ symbol: 'SOXL', available_quantity: '0' }]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(positions), { status: 200 }))
    const client = createClient(fetchMock)
    await expect(client.getAvailableQtyForSymbol('SOXL')).resolves.toBe(0)
  })

  it('getAvailableQtyForSymbol returns null when the symbol is not on the account', async () => {
    const positions = [{ symbol: 'AAPL', available_quantity: '10' }]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(positions), { status: 200 }))
    const client = createClient(fetchMock)
    await expect(client.getAvailableQtyForSymbol('SOXL')).resolves.toBeNull()
  })

  it('getAvailableQtyForSymbol rethrows when getPositions fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }))
    const client = createClient(fetchMock)
    // 500 retries 3x then surfaces as BrokerServerError — must propagate to caller.
    await expect(client.getAvailableQtyForSymbol('SOXL')).rejects.toThrow(BrokerServerError)
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
