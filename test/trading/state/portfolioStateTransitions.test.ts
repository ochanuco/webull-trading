import { describe, expect, it } from 'vitest'
import {
  applyRealizedPnl,
  seedDailyStartEquity,
  setTradingDisabledUntil,
} from '../../../src/trading/state/portfolioStateTransitions'
import { emptyPortfolioState } from '../../../src/trading/state/portfolioTypes'

const fixedNow = () => new Date('2026-04-21T10:00:00.000Z')

describe('portfolioStateTransitions', () => {
  describe('seedDailyStartEquity', () => {
    it('overwrites dailyStartEquity, resets realized PnL to 0, bumps updatedAt', () => {
      const seeded = { ...emptyPortfolioState(fixedNow), dailyRealizedPnl: -500 }
      const next = seedDailyStartEquity(seeded, 100_000, { now: fixedNow })
      expect(next.dailyStartEquity).toBe(100_000)
      expect(next.dailyRealizedPnl).toBe(0)
      expect(next.updatedAt).toBe('2026-04-21T10:00:00.000Z')
    })

    it('rejects NaN', () => {
      expect(() =>
        seedDailyStartEquity(emptyPortfolioState(fixedNow), NaN, { now: fixedNow }),
      ).toThrow('Invalid seedDailyStartEquity')
    })

    it('rejects negative amounts', () => {
      expect(() =>
        seedDailyStartEquity(emptyPortfolioState(fixedNow), -1, { now: fixedNow }),
      ).toThrow('Invalid seedDailyStartEquity')
    })
  })

  describe('applyRealizedPnl', () => {
    it('accumulates deltas (losses and gains)', () => {
      const s0 = emptyPortfolioState(fixedNow)
      const s1 = applyRealizedPnl(s0, -1_000, { now: fixedNow })
      const s2 = applyRealizedPnl(s1, -1_500, { now: fixedNow })
      const s3 = applyRealizedPnl(s2, 400, { now: fixedNow })
      expect(s3.dailyRealizedPnl).toBe(-2_100)
    })

    it('rejects non-finite delta', () => {
      expect(() =>
        applyRealizedPnl(emptyPortfolioState(fixedNow), Number.POSITIVE_INFINITY, { now: fixedNow }),
      ).toThrow('Invalid applyRealizedPnl')
    })
  })

  describe('setTradingDisabledUntil', () => {
    it('accepts a valid ISO timestamp', () => {
      const next = setTradingDisabledUntil(
        emptyPortfolioState(fixedNow),
        '2026-04-21T23:59:59.999Z',
        { now: fixedNow },
      )
      expect(next.tradingDisabledUntil).toBe('2026-04-21T23:59:59.999Z')
    })

    it('clears on null', () => {
      const armed = {
        ...emptyPortfolioState(fixedNow),
        tradingDisabledUntil: '2026-04-21T23:59:59.999Z',
      }
      const next = setTradingDisabledUntil(armed, null, { now: fixedNow })
      expect(next.tradingDisabledUntil).toBeNull()
    })

    it('rejects malformed ISO', () => {
      expect(() =>
        setTradingDisabledUntil(emptyPortfolioState(fixedNow), 'not-a-date', { now: fixedNow }),
      ).toThrow('Invalid setTradingDisabledUntil')
    })
  })
})
