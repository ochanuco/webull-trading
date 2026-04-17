import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'

const baseEnv = {
  BASIC_AUTH_USER: 'admin',
  BASIC_AUTH_PASSWORD: 'secret',
  DRY_RUN: 'true',
  TRADING_ENABLED: 'true',
  ALLOWED_SYMBOLS: 'SOXL,SOXS',
  MAX_ORDER_NOTIONAL: '100',
  EVENT_INGEST_SECRET: 'change-me',
}

const authHeader = {
  Authorization: `Basic ${btoa('admin:secret')}`,
}

describe('webull routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns 401 for /webull/* without auth', async () => {
    const app = createApp()

    const response = await app.request(
      '/webull/order/place',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          side: 'BUY',
          quantity: 2,
          price: 9,
        }),
      },
      baseEnv,
    )

    expect(response.status).toBe(401)
  })

  it('returns a synthetic response when DRY_RUN=true', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const app = createApp()

    const response = await app.request(
      '/webull/order/place',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'soxl',
          side: 'BUY',
          quantity: 2,
          price: 9,
        }),
      },
      baseEnv,
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      status: string
      orderId: string
      symbol: string
    }
    expect(body.status).toBe('DRY_RUN')
    expect(body.orderId).toMatch(/^dry-run-/)
    expect(body.symbol).toBe('SOXL')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls Webull and returns the raw broker DTO on success', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          orderId: 'ord-123',
          status: 'SUBMITTED',
          symbol: 'SOXL',
          side: 'BUY',
          quantity: 2,
          limitPrice: 9,
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = createApp()

    const response = await app.request(
      '/webull/order/place',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
        },
        body: JSON.stringify({
          symbol: 'SOXL',
          side: 'BUY',
          quantity: 2,
          price: 9,
        }),
      },
      {
        ...baseEnv,
        DRY_RUN: 'false',
        WEBULL_APP_KEY: 'app-key',
        WEBULL_APP_SECRET: 'app-secret',
        WEBULL_ACCOUNT_ID: 'acct-1',
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      orderId: 'ord-123',
      status: 'SUBMITTED',
      symbol: 'SOXL',
      side: 'BUY',
      quantity: 2,
      limitPrice: 9,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
