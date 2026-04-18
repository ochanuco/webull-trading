import { describe, expect, it } from 'vitest'
import { TradeEventHandler } from '../../src/trading/events/TradeEventHandler'
import type { PositionStore } from '../../src/trading/state/PositionStore'
import { emptySymbolState, type PendingOrderLock, type SymbolState } from '../../src/trading/state/types'

const tuesday = new Date('2026-04-21T14:30:00.000Z')

const sellLock: PendingOrderLock = {
  clientOrderId: 'coid-sell',
  side: 'SELL',
  submittedAt: tuesday.toISOString(),
  expiresAt: new Date(tuesday.getTime() + 60_000).toISOString(),
}

function makeStore(pre: SymbolState, post: SymbolState) {
  const cooldownCalls: Array<{ symbol: string; untilIso: string }> = []
  let state = pre
  const store: PositionStore = {
    async getState() {
      return state
    },
    async lockPendingOrder() {
      return { ok: true, state }
    },
    async clearPendingOrder() {
      return state
    },
    async recordFill() {
      state = post
      return state
    },
    async addPendingSettlement() {
      return state
    },
    async setCooldown(symbol, untilIso) {
      cooldownCalls.push({ symbol, untilIso })
      return state
    },
    async seedSettledCash() {
      return state
    },
  }
  return { store, cooldownCalls }
}

describe('TradeEventHandler stop-out cooldown', () => {
  it('sets cooldownUntil = next business day when SELL closes at a loss', async () => {
    const pre: SymbolState = {
      ...emptySymbolState('SOXL', () => tuesday),
      pendingOrder: sellLock,
      position: { qty: 2, avgPrice: 10, openedAt: '2026-04-18T14:30:00.000Z' },
    }
    const post: SymbolState = { ...pre, position: null, pendingOrder: null }
    const { store, cooldownCalls } = makeStore(pre, post)

    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => tuesday })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-sell',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 2,
      rawPayload: { client_order_id: 'coid-sell', filled_price: 9 }, // loss
      receivedAt: tuesday.toISOString(),
    })

    expect(cooldownCalls).toEqual([
      { symbol: 'SOXL', untilIso: '2026-04-22T14:30:00.000Z' },
    ])
  })

  it('does NOT set a cooldown on a profitable exit', async () => {
    const pre: SymbolState = {
      ...emptySymbolState('SOXL', () => tuesday),
      pendingOrder: sellLock,
      position: { qty: 2, avgPrice: 10, openedAt: '2026-04-18T14:30:00.000Z' },
    }
    const post: SymbolState = { ...pre, position: null, pendingOrder: null }
    const { store, cooldownCalls } = makeStore(pre, post)

    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => tuesday })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-sell',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 2,
      rawPayload: { client_order_id: 'coid-sell', filled_price: 12 }, // gain
      receivedAt: tuesday.toISOString(),
    })

    expect(cooldownCalls).toEqual([])
  })
})
