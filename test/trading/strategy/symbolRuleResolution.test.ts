import { describe, expect, it } from 'vitest'
import {
  buildEntrySuppressedSymbols,
  buildSymbolRules,
  ROLE_RULE_PRESETS,
  type SymbolRuleOverrides,
} from '../../../src/trading/strategy/symbolRuleResolution'
import { TEST_DEFAULT_RULE } from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

const emptyOverrides = (): SymbolRuleOverrides => ({
  symbolTimeStopDaysOverride: {},
  symbolKAtrOverride: {},
  symbolStopPctOverride: {},
  symbolTakeProfitPctOverride: {},
  symbolRole: {},
  symbolPullbackMaxOverride: {},
  symbolPullbackMinOverride: {},
  symbolMinReturn50dOverride: {},
  symbolMaxAtrRatioOverride: {},
  symbolMaxSma50DeviationPctOverride: {},
  symbolRequireAboveSma50Override: {},
})

describe('buildSymbolRules (#452)', () => {
  it('returns an empty map when no symbol has a role or override (regression: role NULL = 従来挙動)', () => {
    // #452 受け入れ条件: 既存 SOXL/SOXS/TQQQ/SQQQ (role NULL・override なし) は
    // rulesMap に現れず defaultRule がそのまま使われる = 挙動変更ゼロ。
    expect(buildSymbolRules(TEST_DEFAULT_RULE, emptyOverrides())).toEqual({})
  })

  it('keeps the legacy exit-override behavior unchanged (#316 / #exit-atr)', () => {
    const overrides = emptyOverrides()
    overrides.symbolTimeStopDaysOverride.SOXL = 5
    overrides.symbolKAtrOverride.SOXL = 3.0
    overrides.symbolStopPctOverride.SOXL = -0.08
    overrides.symbolTakeProfitPctOverride.SOXL = 0.12
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.SOXL).toEqual({
      ...TEST_DEFAULT_RULE,
      timeStopDays: 5,
      kAtr: 3.0,
      stopPct: -0.08,
      takeProfitPct: 0.12,
    })
  })

  it('leveraged_trend role produces a rule identical to the default (現行挙動そのまま)', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.TQQQ = 'leveraged_trend'
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.TQQQ).toEqual(TEST_DEFAULT_RULE)
  })

  it('core_trend role applies the looser non-leveraged preset', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.QQQ = 'core_trend'
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.QQQ).toEqual({
      ...TEST_DEFAULT_RULE,
      ...ROLE_RULE_PRESETS.core_trend,
    })
    // preset は entry 系のみ — exit 系 (stop/TP/time-stop/kAtr) は global のまま。
    expect(rules.QQQ!.stopPct).toBe(TEST_DEFAULT_RULE.stopPct)
    expect(rules.QQQ!.takeProfitPct).toBe(TEST_DEFAULT_RULE.takeProfitPct)
    expect(rules.QQQ!.timeStopDays).toBe(TEST_DEFAULT_RULE.timeStopDays)
  })

  it('per-symbol entry override beats role preset, which beats global default', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.QQQ = 'core_trend'
    overrides.symbolMinReturn50dOverride.QQQ = 0.02
    overrides.symbolMaxAtrRatioOverride.QQQ = 2.0
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    // override 指定: per-symbol 値が勝つ
    expect(rules.QQQ!.minReturn50d).toBe(0.02)
    expect(rules.QQQ!.maxAtrRatio).toBe(2.0)
    // override 未指定: preset が global に勝つ
    expect(rules.QQQ!.pullbackMax).toBe(ROLE_RULE_PRESETS.core_trend!.pullbackMax)
    expect(rules.QQQ!.maxSma50DeviationPct).toBe(ROLE_RULE_PRESETS.core_trend!.maxSma50DeviationPct)
  })

  it('entry overrides work without any role (role NULL + override)', () => {
    const overrides = emptyOverrides()
    overrides.symbolPullbackMaxOverride.SOXL = -0.02
    overrides.symbolPullbackMinOverride.SOXL = -0.09
    overrides.symbolRequireAboveSma50Override.SOXL = false
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.SOXL).toEqual({
      ...TEST_DEFAULT_RULE,
      pullbackMax: -0.02,
      pullbackMin: -0.09,
      requireAboveSma50: false,
    })
  })

  it('requireAboveSma50 override=false is not swallowed by ?? chains (boolean false)', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.QQQ = 'core_trend'
    overrides.symbolRequireAboveSma50Override.QQQ = false
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.QQQ!.requireAboveSma50).toBe(false)
  })

  it("unknown role gets no preset (defaultRule + overrides only)", () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.WEIRD = 'unknown'
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.WEIRD).toEqual(TEST_DEFAULT_RULE)
  })
})

describe('buildEntrySuppressedSymbols (#452)', () => {
  it('suppresses cash_parking / defined-only roles / unknown, keeps trend roles', () => {
    const suppressed = buildEntrySuppressedSymbols({
      SGOV: 'cash_parking',
      QQQ: 'core_trend',
      TQQQ: 'leveraged_trend',
      USMV: 'low_volatility',
      SMH: 'sector_trend',
      SQQQ: 'inverse_hedge',
      WEIRD: 'unknown',
    })
    expect(Object.keys(suppressed).sort()).toEqual(['SGOV', 'SMH', 'SQQQ', 'USMV', 'WEIRD'])
    expect(suppressed.SGOV).toContain('cash_parking')
    expect(suppressed.WEIRD).toContain('unknown role')
  })

  it('returns an empty map when no symbol has a role (従来挙動)', () => {
    expect(buildEntrySuppressedSymbols({})).toEqual({})
  })
})
