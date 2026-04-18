import { describe, expect, it } from 'vitest'
import { TradeEventHandler, nextBusinessDay } from '../../src/trading/events/TradeEventHandler'
import type { PositionStore } from '../../src/trading/state/PositionStore'
import {
  emptySymbolState,
  type PendingOrderLock,
  type PendingSettlement,
  type SymbolState,
} from '../../src/trading/state/types'

const friday = new Date('2026-04-17T10:00:00.000Z') // Fri
const tuesday = new Date('2026-04-21T10:00:00.000Z') // Tue

const sellLock: PendingOrderLock = {
  clientOrderId: 'coid-sell',
  side: 'SELL',
  submittedAt: tuesday.toISOString(),
  expiresAt: new Date(tuesday.getTime() + 60_000).toISOString(),
}

const buyLock: PendingOrderLock = { ...sellLock, side: 'BUY', clientOrderId: 'coid-buy' }

function makeStore(pre: SymbolState, post: SymbolState) {
  const settlements: Array<{ symbol: string; settlement: PendingSettlement }> = []
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
    async addPendingSettlement(symbol, settlement) {
      settlements.push({ symbol, settlement })
      return state
    },
    async setCooldown() {
      return state
    },
    async seedSettledCash() {
      return state
    },
  }
  return { store, settlements }
}

describe('nextBusinessDay', () => {
  it('rolls Fri → Mon', () => {
    expect(nextBusinessDay(friday).toISOString().slice(0, 10)).toBe('2026-04-20')
  })
  it('rolls Sat → Mon', () => {
    const sat = new Date('2026-04-18T10:00:00.000Z')
    expect(nextBusinessDay(sat).toISOString().slice(0, 10)).toBe('2026-04-20')
  })
  it('rolls Tue → Wed', () => {
    expect(nextBusinessDay(tuesday).toISOString().slice(0, 10)).toBe('2026-04-22')
  })
})

describe('TradeEventHandler SELL → addPendingSettlement', () => {
  it('pushes a T+1 settlement row for a SELL fill', async () => {
    const pre: SymbolState = {
      ...emptySymbolState('SOXL', () => tuesday),
      pendingOrder: sellLock,
      position: { qty: 3, avgPrice: 8, openedAt: '2026-04-15T10:00:00.000Z' },
    }
    const post: SymbolState = { ...pre, position: null, pendingOrder: null }
    const { store, settlements } = makeStore(pre, post)

    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => tuesday })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-sell',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 3,
      rawPayload: { client_order_id: 'coid-sell', filled_price: 12 },
      receivedAt: tuesday.toISOString(),
    })

    expect(settlements).toEqual([
      {
        symbol: 'SOXL',
        settlement: { tradeDate: '2026-04-21', settleDate: '2026-04-22', amount: 36 },
      },
    ])
  })

  it('does not add a settlement row on a BUY fill', async () => {
    const pre: SymbolState = {
      ...emptySymbolState('SOXL', () => tuesday),
      pendingOrder: buyLock,
    }
    const post: SymbolState = {
      ...pre,
      position: { qty: 3, avgPrice: 9, openedAt: tuesday.toISOString() },
      pendingOrder: null,
    }
    const { store, settlements } = makeStore(pre, post)

    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => tuesday })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-buy',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 3,
      rawPayload: { client_order_id: 'coid-buy', filled_price: 9 },
      receivedAt: tuesday.toISOString(),
    })

    expect(settlements).toEqual([])
  })
})
