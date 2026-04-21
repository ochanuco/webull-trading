import { describe, expect, it } from 'vitest'
import { _internal } from '../../../src/trading/reconciliation/reconcileFills'

describe('reconcileFills internals', () => {
  it('TERMINAL_STATUSES covers the expected Webull statuses', () => {
    expect([...(_internal.TERMINAL_STATUSES as Set<string>)].sort()).toEqual(
      ['CANCELED', 'CANCELLED', 'EXPIRED', 'FILLED', 'REJECTED'],
    )
  })

  it('pickFilledPrice averages item fill prices when present', () => {
    const price = _internal.pickFilledPrice({
      items: [
        { filled_price: '30.10' } as never,
        { filled_price: '30.20' } as never,
      ],
      limit_price: '99',
    })
    expect(price).toBeCloseTo(30.15)
  })

  it('pickFilledPrice falls back to limit_price when no item fill prices', () => {
    const price = _internal.pickFilledPrice({ limit_price: '12.50' })
    expect(price).toBe(12.5)
  })

  it('pickFilledPrice returns null when neither items nor limit_price is usable', () => {
    expect(_internal.pickFilledPrice({})).toBeNull()
    expect(_internal.pickFilledPrice({ limit_price: 'n/a' })).toBeNull()
  })

  it('pickFilledPrice ignores zero-priced items', () => {
    const price = _internal.pickFilledPrice({
      items: [
        { filled_price: '0' } as never,
        { filled_price: '25.00' } as never,
      ],
      limit_price: '99',
    })
    expect(price).toBeCloseTo(25)
  })

  // The guard that sits between pickFilledPrice and the DB write.
  it('resolveFilledPrice returns null when filledQty is zero / null / negative', () => {
    const detail = { limit_price: '30' }
    expect(_internal.resolveFilledPrice(0, detail)).toBeNull()
    expect(_internal.resolveFilledPrice(null, detail)).toBeNull()
    expect(_internal.resolveFilledPrice(-1, detail)).toBeNull()
  })

  it('resolveFilledPrice returns the candidate price when filledQty > 0 and price is finite + positive', () => {
    const detail = { limit_price: '30' }
    expect(_internal.resolveFilledPrice(1, detail)).toBe(30)
  })

  it('resolveFilledPrice returns null when the candidate price is non-positive / non-finite', () => {
    expect(_internal.resolveFilledPrice(1, { limit_price: '0' })).toBeNull()
    expect(_internal.resolveFilledPrice(1, { limit_price: '-5' })).toBeNull()
    expect(_internal.resolveFilledPrice(1, { limit_price: 'NaN' })).toBeNull()
    expect(_internal.resolveFilledPrice(1, {})).toBeNull()
  })
})
