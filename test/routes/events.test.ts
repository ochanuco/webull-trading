import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { TRADE_EVENT_INGEST_SECRET_HEADER } from '../../src/infrastructure/webull/TradeEventBridge'

const validPayload = {
  event: {
    eventType: 'ORDER_FILLED',
    orderId: 'ord-123',
    symbol: 'SOXL',
    status: 'FILLED',
    filledQty: 1,
    rawPayload: { eventType: 'ORDER_FILLED' },
    receivedAt: '2026-04-18T10:00:00.000Z',
  },
}

describe('POST /events/trade', () => {
  it('returns 401 without the ingest secret header', async () => {
    const app = createApp()
    const res = await app.request(
      '/events/trade',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validPayload),
      },
      {
        BASIC_AUTH_USER: 'user',
        BASIC_AUTH_PASSWORD: 'pass',
        EVENT_INGEST_SECRET: 'secret',
      },
    )

    expect(res.status).toBe(401)
  })

  it('returns 401 with an incorrect ingest secret header', async () => {
    const app = createApp()
    const res = await app.request(
      '/events/trade',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TRADE_EVENT_INGEST_SECRET_HEADER]: 'wrong-secret',
        },
        body: JSON.stringify(validPayload),
      },
      {
        BASIC_AUTH_USER: 'user',
        BASIC_AUTH_PASSWORD: 'pass',
        EVENT_INGEST_SECRET: 'secret',
      },
    )

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('returns 200 with the correct ingest secret header', async () => {
    const app = createApp()
    const res = await app.request(
      '/events/trade',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TRADE_EVENT_INGEST_SECRET_HEADER]: 'secret',
        },
        body: JSON.stringify(validPayload),
      },
      {
        BASIC_AUTH_USER: 'user',
        BASIC_AUTH_PASSWORD: 'pass',
        EVENT_INGEST_SECRET: 'secret',
      },
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it('returns 400 for a malformed JSON body', async () => {
    const app = createApp()
    const res = await app.request(
      '/events/trade',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TRADE_EVENT_INGEST_SECRET_HEADER]: 'secret',
        },
        body: '{"event":',
      },
      {
        BASIC_AUTH_USER: 'user',
        BASIC_AUTH_PASSWORD: 'pass',
        EVENT_INGEST_SECRET: 'secret',
      },
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'validation_error',
      message: 'event payload is invalid',
      field: 'event',
    })
  })

  it('returns 400 for a schema-invalid JSON body', async () => {
    const app = createApp()
    const res = await app.request(
      '/events/trade',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TRADE_EVENT_INGEST_SECRET_HEADER]: 'secret',
        },
        body: JSON.stringify({
          event: {
            orderId: 'ord-123',
            symbol: 'SOXL',
            status: 'FILLED',
            rawPayload: {},
            receivedAt: '2026-04-18T10:00:00.000Z',
          },
        }),
      },
      {
        BASIC_AUTH_USER: 'user',
        BASIC_AUTH_PASSWORD: 'pass',
        EVENT_INGEST_SECRET: 'secret',
      },
    )

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'validation_error',
      message: 'event payload is invalid',
      field: 'event',
    })
  })
})
