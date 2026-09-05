import { describe, expect, it } from 'vitest'
import {
  createExposureLedger,
  createUnavailableExposureLedger,
} from '../../src/trading/strategy/exposureLedger'

describe('ExposureLedger', () => {
  it('remaining = ceiling - current, and reserves down to zero', () => {
    const l = createExposureLedger({ ceilingJpy: 600_000, currentJpy: 400_000 })
    expect(l.status).toBe('ok')
    expect(l.ceilingJpy).toBe(600_000)
    expect(l.currentJpy).toBe(400_000)
    expect(l.remainingJpy).toBe(200_000)
    expect(l.tryReserve(150_000)).toBe(true)
    expect(l.remainingJpy).toBe(50_000)
    expect(l.tryReserve(50_001)).toBe(false) // exceeds remaining
    expect(l.remainingJpy).toBe(50_000) // unchanged on failed reserve
    expect(l.tryReserve(50_000)).toBe(true)
    expect(l.remainingJpy).toBe(0)
  })

  it('clamps remaining to 0 when current already exceeds ceiling', () => {
    const l = createExposureLedger({ ceilingJpy: 100_000, currentJpy: 250_000 })
    expect(l.remainingJpy).toBe(0)
    expect(l.tryReserve(1)).toBe(false)
  })

  it('rejects non-finite / non-positive reservations', () => {
    const l = createExposureLedger({ ceilingJpy: 100_000, currentJpy: 0 })
    expect(l.tryReserve(0)).toBe(false)
    expect(l.tryReserve(-1)).toBe(false)
    expect(l.tryReserve(Number.NaN)).toBe(false)
    expect(l.remainingJpy).toBe(100_000)
  })

  it('refund restores reserved amount', () => {
    const l = createExposureLedger({ ceilingJpy: 100_000, currentJpy: 0 })
    l.tryReserve(30_000)
    l.refund(30_000)
    expect(l.remainingJpy).toBe(100_000)
  })

  it('unavailable ledger always rejects reservations (fail-closed)', () => {
    const l = createUnavailableExposureLedger('total_capital_jpy unset')
    expect(l.status).toBe('unavailable')
    expect(l.remainingJpy).toBe(0)
    expect(l.ceilingJpy).toBe(0)
    expect(l.currentJpy).toBe(0)
    expect(l.tryReserve(1)).toBe(false)
    expect(l.reason).toBe('total_capital_jpy unset')
  })
})
