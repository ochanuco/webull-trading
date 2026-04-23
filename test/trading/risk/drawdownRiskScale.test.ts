import { describe, expect, it } from 'vitest'
import { computeDrawdownRiskScale } from '../../../src/trading/risk/drawdownRiskScale'

describe('computeDrawdownRiskScale', () => {
  it('returns scale 1.0 when at or above start-of-day equity', () => {
    const r = computeDrawdownRiskScale({ dailyStartEquity: 10_000, dailyRealizedPnl: 100 })
    expect(r.scale).toBe(1)
    expect(r.step).toBe('normal')
    expect(r.drawdown).toBe(0) // clipped at 0
  })

  it('returns scale 1.0 when drawdown is shallower than -5%', () => {
    const r = computeDrawdownRiskScale({ dailyStartEquity: 10_000, dailyRealizedPnl: -300 })
    expect(r.scale).toBe(1)
    expect(r.step).toBe('normal')
  })

  it('returns scale 0.5 when drawdown is in [-10%, -5%)', () => {
    const r = computeDrawdownRiskScale({ dailyStartEquity: 10_000, dailyRealizedPnl: -600 })
    expect(r.scale).toBe(0.5)
    expect(r.step).toBe('half')
  })

  it('returns scale 0.0 when drawdown is below -10%', () => {
    const r = computeDrawdownRiskScale({ dailyStartEquity: 10_000, dailyRealizedPnl: -1_200 })
    expect(r.scale).toBe(0)
    expect(r.step).toBe('halt')
  })

  it('returns normal with dd=0 when dailyStartEquity is uninitialized', () => {
    const r = computeDrawdownRiskScale({ dailyStartEquity: 0, dailyRealizedPnl: -100 })
    expect(r.scale).toBe(1)
    expect(r.drawdown).toBe(0)
  })

  it('treats non-finite fields as uninitialized (fail-open)', () => {
    const r = computeDrawdownRiskScale({ dailyStartEquity: Number.NaN, dailyRealizedPnl: -100 })
    expect(r.scale).toBe(1)
  })

  it('boundary: exactly -5% stays normal, exactly -10% is half', () => {
    expect(computeDrawdownRiskScale({ dailyStartEquity: 10_000, dailyRealizedPnl: -500 }).step).toBe('normal')
    expect(computeDrawdownRiskScale({ dailyStartEquity: 10_000, dailyRealizedPnl: -1_000 }).step).toBe('half')
  })
})
