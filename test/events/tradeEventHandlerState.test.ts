import { afterEach, describe, expect, it, vi } from 'vitest'
import { TradeEventHandler } from '../../src/trading/events/TradeEventHandler'
import { setTradeJournalSink } from '../../src/infrastructure/logger/tradeJournal'
import type { PositionStore } from '../../src/trading/state/PositionStore'
import { emptySymbolState, type PendingOrderLock, type SymbolState } from '../../src/trading/state/types'

const fixedNow = new Date('2026-04-18T10:00:00.000Z')

function makeStore(initial: SymbolState, afterFill: SymbolState): PositionStore & { recordFillCalls: unknown[] } {
  let state = initial
  const recordFillCalls: unknown[] = []
  return {
    recordFillCalls,
    async getState() {
      return state
    },
    async lockPendingOrder() {
      return { ok: true, state }
    },
    async clearPendingOrder() {
      return state
    },
    async recordFill(symbol, fill) {
      recordFillCalls.push({ symbol, fill })
      state = afterFill
      return state
    },
  }
}

describe('TradeEventHandler with PositionStore', () => {
  const lock: PendingOrderLock = {
    clientOrderId: 'coid-1',
    side: 'SELL',
    submittedAt: '2026-04-18T09:59:30.000Z',
    expiresAt: '2026-04-18T10:00:30.000Z',
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('applies recordFill and emits logExit when a SELL closes the position', async () => {
    const pre: SymbolState = {
      ...emptySymbolState('SOXL', () => fixedNow),
      pendingOrder: lock,
      position: { qty: 2, avgPrice: 9, openedAt: '2026-04-15T10:00:00.000Z' },
    }
    const post: SymbolState = { ...pre, position: null, pendingOrder: null }
    const store = makeStore(pre, post)

    const journalLines: string[] = []
    const restore = setTradeJournalSink((line) => journalLines.push(line))

    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => fixedNow })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-1',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 2,
      rawPayload: { client_order_id: 'coid-1', filled_price: 12 },
      receivedAt: fixedNow.toISOString(),
    })
    restore()

    expect(store.recordFillCalls).toEqual([
      { symbol: 'SOXL', fill: { side: 'SELL', qty: 2, price: 12 } },
    ])

    const exit = journalLines.map((l) => JSON.parse(l)).find((r) => r.trade_event_type === 'exit')
    expect(exit).toMatchObject({
      symbol: 'SOXL',
      order_id: 'ord-1',
      client_order_id: 'coid-1',
      realized_pnl: 6,
      hold_days: 3,
      exit_reason: 'OTHER',
    })
  })

  it('skips recordFill when no pending lock exists (stale event)', async () => {
    const state: SymbolState = emptySymbolState('SOXL', () => fixedNow)
    const store = makeStore(state, state)

    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => fixedNow })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-ghost',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 2,
      rawPayload: { filled_price: 12 },
      receivedAt: fixedNow.toISOString(),
    })

    expect(store.recordFillCalls).toEqual([])
  })

  it('does not emit logExit on a BUY fill', async () => {
    const buyLock: PendingOrderLock = { ...lock, side: 'BUY' }
    const pre: SymbolState = {
      ...emptySymbolState('SOXL', () => fixedNow),
      pendingOrder: buyLock,
    }
    const post: SymbolState = {
      ...pre,
      pendingOrder: null,
      position: { qty: 2, avgPrice: 9, openedAt: fixedNow.toISOString() },
    }
    const store = makeStore(pre, post)

    const journalLines: string[] = []
    const restore = setTradeJournalSink((line) => journalLines.push(line))
    const handler = new TradeEventHandler(() => {}, { positionStore: store, now: () => fixedNow })
    await handler.handle({
      eventType: 'ORDER_FILLED',
      orderId: 'ord-2',
      symbol: 'SOXL',
      status: 'FILLED',
      filledQty: 2,
      rawPayload: { client_order_id: 'coid-1', filled_price: 9 },
      receivedAt: fixedNow.toISOString(),
    })
    restore()

    expect(store.recordFillCalls).toHaveLength(1)
    const exit = journalLines.map((l) => JSON.parse(l)).find((r) => r.trade_event_type === 'exit')
    expect(exit).toBeUndefined()
  })
})
