import { describe, expect, it } from 'vitest'
import { deriveEntryStatusFromIndicators } from '../../../src/trading/strategy/entryStatus'
import {
  TEST_DEFAULT_RULE,
  type PullbackIndicators,
  type SymbolRule,
} from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

// 全 gate 通過するベース指標 (TEST_DEFAULT_RULE 比):
//   trend: 0.20 > 0.08 / above_sma50: 100 > 90 / overextension: 0.111 <= 0.6
//   volatility: 1.0 <= 1.5 / high20d_valid: 104 > 0
//   pullback: (100-104)/104 = -0.0385 ∈ [-0.06, -0.03]
const baseIndicators = (): PullbackIndicators => ({
  price: 100,
  sma50: 90,
  return50d: 0.2,
  high20d: 104,
  atr20: 1.0,
  baselineAtr20: 1.0,
})

const rule = (overrides: Partial<SymbolRule> = {}): SymbolRule => ({
  ...TEST_DEFAULT_RULE,
  ...overrides,
})

describe('deriveEntryStatus (#452 段階判定)', () => {
  it('ENTRY when all gates pass (multiplier 1.0)', () => {
    const result = deriveEntryStatusFromIndicators(baseIndicators(), rule())
    expect(result.status).toBe('ENTRY')
    expect(result.positionMultiplier).toBe(1)
    expect(result.failedGates).toHaveLength(0)
  })

  it('WATCH when the only failing gate is volatility, even within the ×1.2 tolerance band (regime gate, #659)', () => {
    // atrRatio 1.65 > max 1.5、閾値の 1.2 倍 (1.8) 以内でも volatility はレジーム
    // gate なので HALF にせず WATCH のまま (#659)。
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), atr20: 1.65 },
      rule(),
    )
    expect(result.status).toBe('WATCH')
    expect(result.positionMultiplier).toBe(0)
    expect(result.halfGate).toBeNull()
  })

  it('HALF when the only failing gate is pullback depth within the tolerance band', () => {
    // pullback = (100-107)/107 = -0.0654、min -0.06 より深いが -0.072 以内 → HALF。
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), high20d: 107 },
      rule(),
    )
    expect(result.status).toBe('HALF')
    expect(result.halfGate?.key).toBe('pullback_deep')
  })

  it('WATCH when a single degree gate fails beyond the tolerance band', () => {
    // pullback = (100-110)/110 = -0.0909、min -0.06 の許容バンド -0.072 を
    // 超えて外れる → HALF にせず WATCH (監視のみ、発注なし)。
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), high20d: 110 },
      rule(),
    )
    expect(result.status).toBe('WATCH')
    expect(result.positionMultiplier).toBe(0)
  })

  it('WATCH when the single failing gate is a regime gate (trend), even if marginal', () => {
    // 「程度もの」以外 (トレンド / SMA50 / 過伸長 / high20d) は僅差でも HALF にしない。
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), return50d: 0.079 },
      rule(),
    )
    expect(result.status).toBe('WATCH')
    expect(result.positionMultiplier).toBe(0)
  })

  it('WATCH when two gates fail', () => {
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), return50d: 0.05, atr20: 1.65 },
      rule(),
    )
    expect(result.status).toBe('WATCH')
    expect(result.failedGates).toHaveLength(2)
  })

  it('NG when three or more gates fail', () => {
    // trend / above_sma50 / pullback_deep が同時に落ちる局面。
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), price: 80, return50d: 0.05 },
      rule(),
    )
    expect(result.status).toBe('NG')
    expect(result.positionMultiplier).toBe(0)
    expect(result.failedGates.length).toBeGreaterThanOrEqual(3)
  })

  it('does not grant HALF when the degree-gate threshold is 0 (degenerate band, fail-closed)', () => {
    // pullbackMax=0 だと許容バンド幅も 0。押し目ゼロでの部分 entry は認めない。
    const result = deriveEntryStatusFromIndicators(
      { ...baseIndicators(), price: 104.5, high20d: 104, sma50: 95 },
      rule({ pullbackMax: 0 }),
    )
    expect(result.status).not.toBe('HALF')
  })
})
