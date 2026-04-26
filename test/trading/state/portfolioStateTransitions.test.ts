import { describe, expect, it } from 'vitest'
import {
  applyRealizedPnl,
  applyRealizedPnlOnce,
  rollDaily,
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

  describe('applyRealizedPnlOnce', () => {
    it('applies a new clientOrderId once and records it in the ledger', () => {
      const s0 = emptyPortfolioState(fixedNow)
      const result = applyRealizedPnlOnce(s0, 'coid-sell-1', -1_000, { now: fixedNow })

      expect(result.applied).toBe(true)
      expect(result.state.dailyRealizedPnl).toBe(-1_000)
      expect(result.state.appliedClientOrderIds).toEqual(['coid-sell-1'])
    })

    it('skips a duplicate clientOrderId without changing PnL', () => {
      const s0 = {
        ...emptyPortfolioState(fixedNow),
        dailyRealizedPnl: -1_000,
        appliedClientOrderIds: ['coid-sell-1'],
      }
      const result = applyRealizedPnlOnce(s0, 'coid-sell-1', -500, { now: fixedNow })

      expect(result.applied).toBe(false)
      expect(result.state).toBe(s0)
      expect(result.state.dailyRealizedPnl).toBe(-1_000)
    })

    it('rejects an empty clientOrderId', () => {
      expect(() =>
        applyRealizedPnlOnce(emptyPortfolioState(fixedNow), '', 1, { now: fixedNow }),
      ).toThrow('Invalid applyRealizedPnlOnce clientOrderId')
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

  describe('rollDaily', () => {
    it('rolls dailyRealizedPnl into nextStart and stamps lastRolledAt', () => {
      const seeded = {
        ...emptyPortfolioState(fixedNow),
        dailyStartEquity: 10_000,
        dailyRealizedPnl: -250,
      }
      const { before, after } = rollDaily(seeded, { now: fixedNow })
      expect(before).toBe(seeded)
      expect(after.dailyStartEquity).toBe(9_750)
      expect(after.dailyRealizedPnl).toBe(0)
      // issue #140: lastRolledAt は updatedAt と同じ ISO に set される
      expect(after.lastRolledAt).toBe('2026-04-21T10:00:00.000Z')
      expect(after.updatedAt).toBe('2026-04-21T10:00:00.000Z')
    })

    it('preserves tradingDisabledUntil through the roll', () => {
      const armed = {
        ...emptyPortfolioState(fixedNow),
        dailyStartEquity: 10_000,
        dailyRealizedPnl: -100,
        tradingDisabledUntil: '2026-04-22T00:00:00.000Z',
      }
      const { after } = rollDaily(armed, { now: fixedNow })
      expect(after.tradingDisabledUntil).toBe('2026-04-22T00:00:00.000Z')
    })
  })
})
