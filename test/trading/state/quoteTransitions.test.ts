import { describe, expect, it } from 'vitest'
import { isQuoteStale, setQuote } from '../../../src/trading/state/stateTransitions'
import { emptySymbolState, type QuoteSnapshot } from '../../../src/trading/state/types'

const fixedNow = (iso: string) => () => new Date(iso)

const quote: QuoteSnapshot = {
  price: 10,
  asOf: '2026-04-18T10:00:00.000Z',
  fetchedAt: '2026-04-18T10:00:01.000Z',
  source: 'webull-snapshot',
}

describe('setQuote', () => {
  it('stores the latest quote on state', () => {
    const state = emptySymbolState('SOXL', fixedNow('2026-04-18T09:00:00.000Z'))
    const next = setQuote(state, quote, { now: fixedNow('2026-04-18T10:00:02.000Z') })
    expect(next.lastQuote).toEqual(quote)
    expect(next.updatedAt).toBe('2026-04-18T10:00:02.000Z')
  })

  it('replaces an older quote when called twice', () => {
    let state = emptySymbolState('SOXL', fixedNow('2026-04-18T09:00:00.000Z'))
    state = setQuote(state, quote, { now: fixedNow('2026-04-18T10:00:02.000Z') })
    const newer: QuoteSnapshot = { ...quote, price: 11, asOf: '2026-04-18T10:05:00.000Z' }
    const next = setQuote(state, newer, { now: fixedNow('2026-04-18T10:05:01.000Z') })
    expect(next.lastQuote?.price).toBe(11)
  })
})

describe('isQuoteStale', () => {
  it('returns true when no quote is present', () => {
    expect(isQuoteStale(null, '2026-04-18T10:00:00.000Z', 60_000)).toBe(true)
  })

  it('returns false when quote is within maxAgeMs', () => {
    expect(isQuoteStale(quote, '2026-04-18T10:00:30.000Z', 60_000)).toBe(false)
  })

  it('returns true when quote is older than maxAgeMs', () => {
    expect(isQuoteStale(quote, '2026-04-18T10:05:00.000Z', 60_000)).toBe(true)
  })

  it('returns true when asOfIso is unparseable', () => {
    expect(isQuoteStale(quote, 'not-a-date', 60_000)).toBe(true)
  })
})
