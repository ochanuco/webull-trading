import { describe, expect, it } from 'vitest'
import {
  buildEntrySuppressedSymbols,
  buildHalfEntrySymbols,
  buildMomentumRules,
  buildMomentumSymbols,
  buildSymbolRules,
  ROLE_RULE_PRESETS,
  type SymbolRuleOverrides,
} from '../../../src/trading/strategy/symbolRuleResolution'
import { TEST_DEFAULT_MOMENTUM_RULE } from '../../../src/trading/strategy/strategies/BreakoutMomentumStrategy'
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

describe('momentum role (#momentum)', () => {
  it('momentum は entry-enabled (suppress されない)', () => {
    const ov = emptyOverrides()
    ov.symbolRole = { ICLN: 'momentum', SGOV: 'cash_parking' }
    const suppressed = buildEntrySuppressedSymbols(ov.symbolRole)
    expect(suppressed.ICLN).toBeUndefined()
    expect(suppressed.SGOV).toBeDefined() // cash_parking は従来どおり抑止
  })

  it('momentum は HALF 昇格から除外される', () => {
    const half = buildHalfEntrySymbols({ ICLN: 'momentum', QQQ: 'core_trend' })
    expect(half.has('ICLN')).toBe(false)
    expect(half.has('QQQ')).toBe(true)
  })

  it('buildMomentumSymbols は role===momentum だけ拾う', () => {
    const set = buildMomentumSymbols({ ICLN: 'momentum', SOXL: 'leveraged_trend', TAN: 'momentum' })
    expect([...set].sort()).toEqual(['ICLN', 'TAN'])
  })

  it('buildMomentumRules は momentum symbol に override を重ねる', () => {
    const ov = emptyOverrides()
    ov.symbolRole = { ICLN: 'momentum', SOXL: 'leveraged_trend' }
    ov.symbolStopPctOverride = { ICLN: -0.03 }
    ov.symbolTimeStopDaysOverride = { ICLN: 4 }
    const rules = buildMomentumRules(ov)
    expect(Object.keys(rules)).toEqual(['ICLN']) // momentum のみ
    expect(rules.ICLN!.stopPct).toBe(-0.03) // override 反映
    expect(rules.ICLN!.timeStopDays).toBe(4)
    // override 無い項目は preset 既定。
    expect(rules.ICLN!.takeProfitPct).toBe(TEST_DEFAULT_MOMENTUM_RULE.takeProfitPct)
    expect(rules.ICLN!.breakoutBuffer).toBe(TEST_DEFAULT_MOMENTUM_RULE.breakoutBuffer)
  })
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

describe('buildEntrySuppressedSymbols (#452 / #457)', () => {
  it('suppresses only cash_parking and unknown after #457 enabled the remaining roles', () => {
    const suppressed = buildEntrySuppressedSymbols({
      SGOV: 'cash_parking',
      QQQ: 'core_trend',
      TQQQ: 'leveraged_trend',
      USMV: 'low_volatility',
      SMH: 'sector_trend',
      SQQQ: 'inverse_hedge',
      WEIRD: 'unknown',
    })
    expect(Object.keys(suppressed).sort()).toEqual(['SGOV', 'WEIRD'])
    expect(suppressed.SGOV).toContain('cash_parking')
    expect(suppressed.WEIRD).toContain('unknown role')
  })

  it('returns an empty map when no symbol has a role (従来挙動)', () => {
    expect(buildEntrySuppressedSymbols({})).toEqual({})
  })
})

describe('role presets for low_volatility / sector_trend / inverse_hedge (#457)', () => {
  it('low_volatility rescales both entry and exit sides', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.USMV = 'low_volatility'
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.USMV).toEqual({
      ...TEST_DEFAULT_RULE,
      minReturn50d: 0.015,
      pullbackMax: -0.01,
      pullbackMin: -0.03,
      maxSma50DeviationPct: 0.1,
      maxAtrRatio: 1.3,
      stopPct: -0.015,
      takeProfitPct: 0.025,
      timeStopDays: 15,
    })
  })

  it('sector_trend adjusts the entry side only — exits stay global (回帰保証)', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.SMH = 'sector_trend'
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.SMH!.minReturn50d).toBe(0.04)
    expect(rules.SMH!.pullbackMax).toBe(-0.02)
    expect(rules.SMH!.pullbackMin).toBe(-0.05)
    expect(rules.SMH!.maxSma50DeviationPct).toBe(0.3)
    // exit 据え置き (issue #457: 変更点を entry 4 つに絞る)
    expect(rules.SMH!.stopPct).toBe(TEST_DEFAULT_RULE.stopPct)
    expect(rules.SMH!.takeProfitPct).toBe(TEST_DEFAULT_RULE.takeProfitPct)
    expect(rules.SMH!.timeStopDays).toBe(TEST_DEFAULT_RULE.timeStopDays)
    expect(rules.SMH!.kAtr).toBe(TEST_DEFAULT_RULE.kAtr)
    expect(rules.SMH!.maxAtrRatio).toBe(TEST_DEFAULT_RULE.maxAtrRatio)
  })

  it('inverse_hedge demands a strong down-regime and holds short', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.SQQQ = 'inverse_hedge'
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.SQQQ!.minReturn50d).toBe(0.15)
    expect(rules.SQQQ!.maxSma50DeviationPct).toBe(0.4)
    expect(rules.SQQQ!.timeStopDays).toBe(5)
    expect(rules.SQQQ!.kAtr).toBe(1.5)
    // 据え置き分 (同ボラクラス / fail-closed で緩めない)
    expect(rules.SQQQ!.stopPct).toBe(TEST_DEFAULT_RULE.stopPct)
    expect(rules.SQQQ!.takeProfitPct).toBe(TEST_DEFAULT_RULE.takeProfitPct)
    expect(rules.SQQQ!.pullbackMax).toBe(TEST_DEFAULT_RULE.pullbackMax)
    expect(rules.SQQQ!.pullbackMin).toBe(TEST_DEFAULT_RULE.pullbackMin)
    expect(rules.SQQQ!.requireAboveSma50).toBe(true)
    expect(rules.SQQQ!.maxAtrRatio).toBe(TEST_DEFAULT_RULE.maxAtrRatio)
  })

  it('per-symbol override still beats the new presets (PSQ 等 1x inverse の吸収経路)', () => {
    const overrides = emptyOverrides()
    overrides.symbolRole.PSQ = 'inverse_hedge'
    overrides.symbolMinReturn50dOverride.PSQ = 0.05
    overrides.symbolStopPctOverride.PSQ = -0.015
    const rules = buildSymbolRules(TEST_DEFAULT_RULE, overrides)
    expect(rules.PSQ!.minReturn50d).toBe(0.05)
    expect(rules.PSQ!.stopPct).toBe(-0.015)
    expect(rules.PSQ!.timeStopDays).toBe(5) // override しない field は preset
  })

  it('all three roles are half-entry enabled (#457)', () => {
    const enabled = buildHalfEntrySymbols({
      USMV: 'low_volatility',
      SMH: 'sector_trend',
      SQQQ: 'inverse_hedge',
      SGOV: 'cash_parking',
      WEIRD: 'unknown',
    })
    expect([...enabled].sort()).toEqual(['SMH', 'SQQQ', 'USMV'])
  })
})
