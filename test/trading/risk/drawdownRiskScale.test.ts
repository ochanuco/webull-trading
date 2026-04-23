import { describe, expect, it } from 'vitest'
import {
  computeDrawdownRiskScale,
  type DrawdownRiskScaleParams,
} from '../../../src/trading/risk/drawdownRiskScale'

const defaultParams: DrawdownRiskScaleParams = {
  baseRiskPct: 0.004,
  halfThreshold: -0.05,
  haltThreshold: -0.10,
}

describe('computeDrawdownRiskScale', () => {
  it('returns scale 1.0 when at or above start-of-day equity', () => {
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: 10_000, dailyRealizedPnl: 100 },
      defaultParams,
    )
    expect(r.scale).toBe(1)
    expect(r.step).toBe('normal')
    expect(r.drawdown).toBe(0)
  })

  it('returns scale 1.0 when drawdown is shallower than halfThreshold', () => {
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: 10_000, dailyRealizedPnl: -300 },
      defaultParams,
    )
    expect(r.scale).toBe(1)
    expect(r.step).toBe('normal')
  })

  it('returns scale 0.5 when drawdown is in [haltThreshold, halfThreshold)', () => {
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: 10_000, dailyRealizedPnl: -600 },
      defaultParams,
    )
    expect(r.scale).toBe(0.5)
    expect(r.step).toBe('half')
  })

  it('returns scale 0.0 when drawdown is below haltThreshold', () => {
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: 10_000, dailyRealizedPnl: -1_200 },
      defaultParams,
    )
    expect(r.scale).toBe(0)
    expect(r.step).toBe('halt')
  })

  it('returns halt (fail-closed) when dailyStartEquity is uninitialized', () => {
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: 0, dailyRealizedPnl: -100 },
      defaultParams,
    )
    expect(r.scale).toBe(0)
    expect(r.step).toBe('halt')
  })

  it('returns halt (fail-closed) when fields are non-finite', () => {
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: Number.NaN, dailyRealizedPnl: -100 },
      defaultParams,
    )
    expect(r.scale).toBe(0)
    expect(r.step).toBe('halt')
  })

  it('boundary: exactly halfThreshold stays normal, exactly haltThreshold is half', () => {
    expect(
      computeDrawdownRiskScale(
        { dailyStartEquity: 10_000, dailyRealizedPnl: -500 },
        defaultParams,
      ).step,
    ).toBe('normal')
    expect(
      computeDrawdownRiskScale(
        { dailyStartEquity: 10_000, dailyRealizedPnl: -1_000 },
        defaultParams,
      ).step,
    ).toBe('half')
  })

  it('respects caller-provided thresholds', () => {
    const relaxed = { baseRiskPct: 0.004, halfThreshold: -0.10, haltThreshold: -0.20 }
    const r = computeDrawdownRiskScale(
      { dailyStartEquity: 10_000, dailyRealizedPnl: -600 },
      relaxed,
    )
    expect(r.step).toBe('normal') // -6% DD is shallower than -10% threshold
  })

  it('throws on invalid baseRiskPct', () => {
    expect(() =>
      computeDrawdownRiskScale(
        { dailyStartEquity: 10_000, dailyRealizedPnl: 0 },
        { ...defaultParams, baseRiskPct: 0 },
      ),
    ).toThrow(/baseRiskPct/)
  })

  it('throws on non-negative thresholds', () => {
    expect(() =>
      computeDrawdownRiskScale(
        { dailyStartEquity: 10_000, dailyRealizedPnl: 0 },
        { ...defaultParams, halfThreshold: 0 },
      ),
    ).toThrow(/halfThreshold/)
    expect(() =>
      computeDrawdownRiskScale(
        { dailyStartEquity: 10_000, dailyRealizedPnl: 0 },
        { ...defaultParams, haltThreshold: 0.1 },
      ),
    ).toThrow(/haltThreshold/)
  })

  it('throws when haltThreshold is shallower than halfThreshold', () => {
    expect(() =>
      computeDrawdownRiskScale(
        { dailyStartEquity: 10_000, dailyRealizedPnl: 0 },
        { baseRiskPct: 0.004, halfThreshold: -0.10, haltThreshold: -0.05 },
      ),
    ).toThrow(/haltThreshold.*halfThreshold/)
  })
})
