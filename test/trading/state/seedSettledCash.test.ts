import { describe, expect, it } from 'vitest'
import { seedSettledCash } from '../../../src/trading/state/stateTransitions'
import { emptySymbolState } from '../../../src/trading/state/types'

const fixedNow = () => new Date('2026-04-21T10:00:00.000Z')

describe('seedSettledCash', () => {
  it('overwrites settledCash and bumps updatedAt', () => {
    const state = emptySymbolState('SOXL', fixedNow)
    const next = seedSettledCash(state, 100_000, { now: fixedNow })
    expect(next.settledCash).toBe(100_000)
    expect(next.updatedAt).toBe('2026-04-21T10:00:00.000Z')
  })

  it('accepts 0 (explicit reset)', () => {
    const state = { ...emptySymbolState('SOXL', fixedNow), settledCash: 5_000 }
    expect(seedSettledCash(state, 0, { now: fixedNow }).settledCash).toBe(0)
  })

  it('rejects NaN', () => {
    const state = emptySymbolState('SOXL', fixedNow)
    expect(() => seedSettledCash(state, NaN, { now: fixedNow })).toThrow('Invalid seedSettledCash')
  })

  it('rejects negative amount', () => {
    const state = emptySymbolState('SOXL', fixedNow)
    expect(() => seedSettledCash(state, -1, { now: fixedNow })).toThrow('Invalid seedSettledCash')
  })
})
