import { describe, expect, it } from 'vitest'
import { mapWebullTradeEvent } from './mapper'

describe('mapWebullTradeEvent', () => {
  it('maps a raw Webull payload into a domain TradeEvent', () => {
    const receivedAt = '2026-04-18T10:00:00.000Z'
    const rawPayload = {
      event_type: 'ORDER_FILLED',
      order: {
        orderId: 'ord-123',
        symbol: 'soxl',
        status: 'FILLED',
      },
      filled_qty: '12.5',
    }

    expect(mapWebullTradeEvent(rawPayload, receivedAt)).toEqual({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-123',
      symbol: 'soxl',
      status: 'FILLED',
      filledQty: 12.5,
      rawPayload,
      receivedAt,
    })
  })
})
