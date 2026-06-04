import { describe, expect, it } from 'vitest'
import {
  buyingPowerJpyFromBalance,
  createBuyingPowerLedger,
  createUnavailableBuyingPowerLedger,
  DEFAULT_BUYING_POWER_BUFFER_PCT,
} from '../../src/trading/strategy/buyingPower'
import type { WebullAccountBalanceDto } from '../../src/infrastructure/webull/dto'

const balance = (assets: Array<{ currency: string; buying_power: string }>): WebullAccountBalanceDto => ({
  total_asset_currency: 'JPY',
  account_currency_assets: assets,
})

describe('buyingPowerJpyFromBalance', () => {
  it('sums JPY + USD(×fx) buying power into a JPY base', () => {
    const r = buyingPowerJpyFromBalance(
      balance([
        { currency: 'JPY', buying_power: '100000' },
        { currency: 'USD', buying_power: '200' },
      ]),
      150,
    )
    expect(r).not.toBeNull()
    expect(r!.jpy).toBeCloseTo(100000 + 200 * 150, 4) // 130,000
    expect(r!.byCurrency).toEqual({ JPY: 100000, USD: 200 })
  })

  it('JPY-only account needs no FX', () => {
    const r = buyingPowerJpyFromBalance(
      balance([
        { currency: 'JPY', buying_power: '100000' },
        { currency: 'USD', buying_power: '0.00' },
      ]),
      null,
    )
    expect(r!.jpy).toBe(100000)
  })

  it('fail-closed (null) when USD buying power > 0 but FX missing', () => {
    expect(
      buyingPowerJpyFromBalance(
        balance([
          { currency: 'JPY', buying_power: '100000' },
          { currency: 'USD', buying_power: '200' },
        ]),
        null,
      ),
    ).toBeNull()
  })

  it('fail-closed on anomalous (negative / non-finite) buying power', () => {
    expect(buyingPowerJpyFromBalance(balance([{ currency: 'JPY', buying_power: '-1' }]), 150)).toBeNull()
    expect(buyingPowerJpyFromBalance(balance([{ currency: 'JPY', buying_power: 'abc' }]), 150)).toBeNull()
  })

  it('fail-closed on missing / empty asset array', () => {
    expect(buyingPowerJpyFromBalance({}, 150)).toBeNull()
    expect(buyingPowerJpyFromBalance({ account_currency_assets: [] }, 150)).toBeNull()
  })

  it('fail-closed on an unsupported currency with non-zero buying power', () => {
    expect(
      buyingPowerJpyFromBalance(balance([{ currency: 'HKD', buying_power: '500' }]), 150),
    ).toBeNull()
  })
})

describe('BuyingPowerLedger', () => {
  it('reserves down to zero and rejects over-reservation', () => {
    const l = createBuyingPowerLedger({ availableJpy: 100_000, asOf: '2026-06-05T00:00:00Z', bufferPct: 0 })
    expect(l.status).toBe('ok')
    expect(l.remainingJpy).toBe(100_000)
    expect(l.tryReserve(60_000)).toBe(true)
    expect(l.remainingJpy).toBe(40_000)
    expect(l.tryReserve(60_000)).toBe(false) // exceeds remaining
    expect(l.remainingJpy).toBe(40_000) // unchanged on failed reserve
    expect(l.tryReserve(40_000)).toBe(true)
    expect(l.remainingJpy).toBe(0)
  })

  it('applies the default safety buffer to the initial remaining', () => {
    const l = createBuyingPowerLedger({ availableJpy: 100_000, asOf: null })
    expect(l.remainingJpy).toBeCloseTo(100_000 * (1 - DEFAULT_BUYING_POWER_BUFFER_PCT), 4)
  })

  it('rejects non-finite / non-positive reservations', () => {
    const l = createBuyingPowerLedger({ availableJpy: 100_000, asOf: null, bufferPct: 0 })
    expect(l.tryReserve(0)).toBe(false)
    expect(l.tryReserve(-1)).toBe(false)
    expect(l.tryReserve(Number.NaN)).toBe(false)
    expect(l.remainingJpy).toBe(100_000)
  })

  it('refund restores reserved amount', () => {
    const l = createBuyingPowerLedger({ availableJpy: 100_000, asOf: null, bufferPct: 0 })
    l.tryReserve(30_000)
    l.refund(30_000)
    expect(l.remainingJpy).toBe(100_000)
  })

  it('unavailable ledger always rejects reservations (fail-closed)', () => {
    const l = createUnavailableBuyingPowerLedger('fetch failed')
    expect(l.status).toBe('unavailable')
    expect(l.remainingJpy).toBe(0)
    expect(l.tryReserve(1)).toBe(false)
    expect(l.reason).toBe('fetch failed')
  })
})
