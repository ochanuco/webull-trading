import { describe, expect, it, vi } from 'vitest'
import { TradeEventHandler } from '../../src/trading/events/TradeEventHandler'

describe('TradeEventHandler', () => {
  it('emits a normalized audit log line', async () => {
    const log = vi.fn()
    const handler = new TradeEventHandler(log)

    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: ' ord-123 ',
      symbol: 'soxl',
      status: 'FILLED',
      filledQty: 2,
      rawPayload: { foo: 'bar' },
      receivedAt: '2026-04-18T10:00:00.000Z',
    })

    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '')).toEqual({
      source: 'trade-event',
      eventType: 'ORDER_FILLED',
      orderId: 'ord-123',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 2,
      receivedAt: '2026-04-18T10:00:00.000Z',
    })
  })
})
