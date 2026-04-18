import { describe, expect, it } from 'vitest'
import {
  addPendingSettlement,
  clearPendingOrder,
  lockPendingOrder,
  recordFill,
  recordSignal,
  rollSettlements,
  setCooldown,
} from '../../../src/trading/state/stateTransitions'
import { emptySymbolState, type PendingOrderLock } from '../../../src/trading/state/types'

const fixedNow = (iso: string) => () => new Date(iso)

const lock: PendingOrderLock = {
  clientOrderId: 'coid-1',
  side: 'BUY',
  submittedAt: '2026-04-18T10:00:00.000Z',
  expiresAt: '2026-04-18T10:05:00.000Z',
}

describe('lockPendingOrder', () => {
  it('accepts a fresh lock when no pending order exists', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T09:59:59.000Z'))
    const res = lockPendingOrder(state, lock, { now: fixedNow('2026-04-18T10:00:00.000Z') })

    expect(res.ok).toBe(true)
    expect(res.state.pendingOrder).toEqual(lock)
  })

  it('rejects a second lock while the first has not expired', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = lockPendingOrder(state, lock, { now: fixedNow('2026-04-18T10:00:00.000Z') }).state

    const res = lockPendingOrder(
      state,
      { ...lock, clientOrderId: 'coid-2' },
      { now: fixedNow('2026-04-18T10:02:00.000Z') },
    )

    expect(res.ok).toBe(false)
    expect(res.state.pendingOrder?.clientOrderId).toBe('coid-1')
  })

  it('accepts a new lock after the previous one has expired', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = lockPendingOrder(state, lock, { now: fixedNow('2026-04-18T10:00:00.000Z') }).state

    const res = lockPendingOrder(
      state,
      { ...lock, clientOrderId: 'coid-next' },
      { now: fixedNow('2026-04-18T10:10:00.000Z') },
    )

    expect(res.ok).toBe(true)
    expect(res.state.pendingOrder?.clientOrderId).toBe('coid-next')
  })

  it('rejects lock with invalid expiresAt (fail-closed)', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    const invalidLock = { ...lock, expiresAt: 'invalid-date' }
    const res = lockPendingOrder(state, invalidLock, { now: fixedNow('2026-04-18T10:00:00.000Z') })

    expect(res.ok).toBe(false)
    expect(res.state.pendingOrder).toBeNull()
  })

  it('rejects lock with empty expiresAt', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    const invalidLock = { ...lock, expiresAt: '' }
    const res = lockPendingOrder(state, invalidLock, { now: fixedNow('2026-04-18T10:00:00.000Z') })

    expect(res.ok).toBe(false)
    expect(res.state.pendingOrder).toBeNull()
  })
})

describe('recordFill', () => {
  it('opens a long position from flat on BUY', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    const next = recordFill(
      state,
      { side: 'BUY', qty: 2, price: 9 },
      { now: fixedNow('2026-04-18T10:05:00.000Z') },
    )

    expect(next.position).toEqual({
      qty: 2,
      avgPrice: 9,
      openedAt: '2026-04-18T10:05:00.000Z',
    })
    expect(next.pendingOrder).toBeNull()
    expect(next.lastExecutedPrice).toBe(9)
  })

  it('averages the fill price on a subsequent BUY', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = recordFill(state, { side: 'BUY', qty: 2, price: 9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    state = recordFill(state, { side: 'BUY', qty: 2, price: 11 }, { now: fixedNow('2026-04-18T11:00:00.000Z') })

    expect(state.position?.qty).toBe(4)
    expect(state.position?.avgPrice).toBe(10)
  })

  it('closes the position on a SELL that matches the qty', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = recordFill(state, { side: 'BUY', qty: 2, price: 9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    state = recordFill(state, { side: 'SELL', qty: 2, price: 12 }, { now: fixedNow('2026-04-18T11:00:00.000Z') })

    expect(state.position).toBeNull()
    expect(state.lastExecutedPrice).toBe(12)
  })

  it('keeps the opened_at timestamp when scaling in', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = recordFill(state, { side: 'BUY', qty: 2, price: 9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    state = recordFill(state, { side: 'BUY', qty: 1, price: 10 }, { now: fixedNow('2026-04-18T12:00:00.000Z') })

    expect(state.position?.openedAt).toBe('2026-04-18T10:05:00.000Z')
  })

  it('rejects fill with invalid qty (NaN)', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      recordFill(state, { side: 'BUY', qty: NaN, price: 9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    }).toThrow('Invalid fill.qty')
  })

  it('rejects fill with zero qty', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      recordFill(state, { side: 'BUY', qty: 0, price: 9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    }).toThrow('Invalid fill.qty')
  })

  it('rejects fill with negative qty', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      recordFill(state, { side: 'BUY', qty: -1, price: 9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    }).toThrow('Invalid fill.qty')
  })

  it('rejects fill with invalid price (NaN)', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      recordFill(state, { side: 'BUY', qty: 2, price: NaN }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    }).toThrow('Invalid fill.price')
  })

  it('rejects fill with zero price', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      recordFill(state, { side: 'BUY', qty: 2, price: 0 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    }).toThrow('Invalid fill.price')
  })

  it('rejects fill with negative price', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      recordFill(state, { side: 'BUY', qty: 2, price: -9 }, { now: fixedNow('2026-04-18T10:05:00.000Z') })
    }).toThrow('Invalid fill.price')
  })
})

describe('rollSettlements', () => {
  it('moves matured settlements into settledCash', () => {
    const state = {
      ...emptySymbolState('SOXL', fixedNow('2026-04-17T00:00:00.000Z')),
      settledCash: 100,
      pendingSettlement: [
        { tradeDate: '2026-04-17', settleDate: '2026-04-18', amount: 50 },
        { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: 80 },
      ],
    }

    const next = rollSettlements(state, '2026-04-18T23:59:59.000Z', {
      now: fixedNow('2026-04-18T23:59:59.000Z'),
    })

    expect(next.settledCash).toBe(150)
    expect(next.pendingSettlement).toEqual([
      { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: 80 },
    ])
  })

  it('is a no-op when nothing has matured yet', () => {
    const state = {
      ...emptySymbolState('SOXL', fixedNow('2026-04-18T00:00:00.000Z')),
      settledCash: 100,
      pendingSettlement: [{ tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: 80 }],
    }

    const next = rollSettlements(state, '2026-04-18T23:59:59.000Z', {
      now: fixedNow('2026-04-18T23:59:59.000Z'),
    })

    expect(next).toBe(state)
  })
})

describe('misc transitions', () => {
  it('setCooldown stores the ISO timestamp', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    const next = setCooldown(state, '2026-04-19T10:00:00.000Z', { now: fixedNow('2026-04-18T10:00:00.000Z') })
    expect(next.cooldownUntil).toBe('2026-04-19T10:00:00.000Z')
  })

  it('recordSignal updates lastSignalAt and updatedAt', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T00:00:00.000Z'))
    const next = recordSignal(state, { now: fixedNow('2026-04-18T10:00:00.000Z') })
    expect(next.lastSignalAt).toBe('2026-04-18T10:00:00.000Z')
    expect(next.updatedAt).toBe('2026-04-18T10:00:00.000Z')
  })

  it('clearPendingOrder removes the lock regardless of expiry', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = lockPendingOrder(state, lock, { now: fixedNow('2026-04-18T10:00:00.000Z') }).state
    state = clearPendingOrder(state, { now: fixedNow('2026-04-18T10:00:10.000Z') })
    expect(state.pendingOrder).toBeNull()
  })

  it('addPendingSettlement appends new entries without reordering', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    state = addPendingSettlement(
      state,
      { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: 10 },
      { now: fixedNow('2026-04-18T10:00:00.000Z') },
    )
    state = addPendingSettlement(
      state,
      { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: 5 },
      { now: fixedNow('2026-04-18T10:00:01.000Z') },
    )
    expect(state.pendingSettlement).toHaveLength(2)
    expect(state.pendingSettlement[0]?.amount).toBe(10)
    expect(state.pendingSettlement[1]?.amount).toBe(5)
  })

  it('addPendingSettlement rejects invalid amount (NaN)', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      addPendingSettlement(
        state,
        { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: NaN },
        { now: fixedNow('2026-04-18T10:00:00.000Z') },
      )
    }).toThrow('Invalid settlement.amount')
  })

  it('addPendingSettlement rejects zero amount', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      addPendingSettlement(
        state,
        { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: 0 },
        { now: fixedNow('2026-04-18T10:00:00.000Z') },
      )
    }).toThrow('Invalid settlement.amount')
  })

  it('addPendingSettlement rejects negative amount', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      addPendingSettlement(
        state,
        { tradeDate: '2026-04-18', settleDate: '2026-04-19', amount: -5 },
        { now: fixedNow('2026-04-18T10:00:00.000Z') },
      )
    }).toThrow('Invalid settlement.amount')
  })

  it('addPendingSettlement rejects invalid settleDate format', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      addPendingSettlement(
        state,
        { tradeDate: '2026-04-18', settleDate: 'invalid-date', amount: 10 },
        { now: fixedNow('2026-04-18T10:00:00.000Z') },
      )
    }).toThrow('Invalid settlement.settleDate')
  })

  it('addPendingSettlement rejects settleDate with wrong format (ISO timestamp)', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      addPendingSettlement(
        state,
        { tradeDate: '2026-04-18', settleDate: '2026-04-19T10:00:00.000Z', amount: 10 },
        { now: fixedNow('2026-04-18T10:00:00.000Z') },
      )
    }).toThrow('Invalid settlement.settleDate')
  })

  it('addPendingSettlement rejects empty settleDate', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T10:00:00.000Z'))
    expect(() => {
      addPendingSettlement(
        state,
        { tradeDate: '2026-04-18', settleDate: '', amount: 10 },
        { now: fixedNow('2026-04-18T10:00:00.000Z') },
      )
    }).toThrow('Invalid settlement.settleDate')
  })
})