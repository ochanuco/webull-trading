import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VIX_REGIME_CONFIG,
  evaluateVixRegime,
  type VixRegimeFilterConfig,
} from '../../../src/trading/risk/vixRegimeFilter'

/**
 * Tests for the VIX regime filter (#196 3/3)。
 *
 * 観点:
 *   - 4 ケースの境界 (normal / warning / critical / unavailable)
 *   - 閾値ぴったりは normal 側に倒す (`>` で warning 判定なので等値は normal)
 *   - 取得失敗 (vix=null / NaN / 0 / 負値) は fail-open で normal fallback
 *   - 壊れた config (NaN / 順序逆 / scale 範囲外) は default に倒す (defensive)
 *   - reason 文字列は localizeReason / dashboard の grep で識別可能な canonical 形式
 */

const baseConfig: VixRegimeFilterConfig = { ...DEFAULT_VIX_REGIME_CONFIG }

describe('evaluateVixRegime — happy paths', () => {
  it('returns normal for VIX well below the warning threshold', () => {
    const decision = evaluateVixRegime(18.5, baseConfig)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.vix).toBe(18.5)
    expect(decision.reason).toBe('vix_normal: 18.50')
  })

  it('returns normal exactly at the warning threshold (boundary uses strict >)', () => {
    // VIX === warningThreshold は normal 側に残す (`vix > warning` で判定)。
    const decision = evaluateVixRegime(25.0, baseConfig)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
  })

  it('returns warning between warning (excl.) and critical (incl.) thresholds', () => {
    const decision = evaluateVixRegime(27.3, baseConfig)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
    expect(decision.reason).toBe('vix_warning: 27.30 (size x0.5)')
    expect(decision.vix).toBe(27.3)
  })

  it('returns warning at the critical boundary (=== critical → still warning)', () => {
    // VIX === criticalThreshold は warning 側 (`vix > critical` が false)。
    const decision = evaluateVixRegime(30.0, baseConfig)
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('returns critical when VIX exceeds the critical threshold', () => {
    const decision = evaluateVixRegime(35.1, baseConfig)
    expect(decision.regime).toBe('critical')
    expect(decision.sizeScale).toBe(0)
    expect(decision.reason).toBe('vix_critical: 35.10 (block)')
    expect(decision.vix).toBe(35.1)
  })
})

describe('evaluateVixRegime — fail-open (unavailable)', () => {
  it('falls back to normal when vix is null', () => {
    const decision = evaluateVixRegime(null, baseConfig)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toBe('vix_unavailable_fallback_normal')
    expect(decision.vix).toBeNull()
  })

  it('falls back to normal when vix is NaN', () => {
    const decision = evaluateVixRegime(Number.NaN, baseConfig)
    expect(decision.regime).toBe('normal')
    expect(decision.sizeScale).toBe(1.0)
    expect(decision.reason).toBe('vix_unavailable_fallback_normal')
    expect(decision.vix).toBeNull()
  })

  it('falls back to normal when vix is 0 or negative (data corruption)', () => {
    expect(evaluateVixRegime(0, baseConfig).regime).toBe('normal')
    expect(evaluateVixRegime(-5, baseConfig).regime).toBe('normal')
  })

  it('falls back to normal when vix is Infinity', () => {
    const decision = evaluateVixRegime(Number.POSITIVE_INFINITY, baseConfig)
    expect(decision.regime).toBe('normal')
    expect(decision.reason).toBe('vix_unavailable_fallback_normal')
  })
})

describe('evaluateVixRegime — defensive config sanitize', () => {
  it('clamps invalid warningSizeScale to default (0.5)', () => {
    const decision = evaluateVixRegime(27.3, {
      warningThreshold: 25,
      criticalThreshold: 30,
      warningSizeScale: 2.5, // out of [0, 1]
    })
    expect(decision.sizeScale).toBe(0.5) // clamped to default
  })

  it('falls back to defaults when thresholds are inverted (warning > critical)', () => {
    // warning=30, critical=25 のような逆転は normal/warning/critical 領域が
    // 矛盾するので default (25 / 30) に倒す。
    const decision = evaluateVixRegime(27.3, {
      warningThreshold: 30,
      criticalThreshold: 25,
      warningSizeScale: 0.5,
    })
    expect(decision.regime).toBe('warning')
    expect(decision.sizeScale).toBe(0.5)
  })

  it('falls back to defaults when warningThreshold is NaN', () => {
    const decision = evaluateVixRegime(27.3, {
      warningThreshold: Number.NaN,
      criticalThreshold: 30,
      warningSizeScale: 0.5,
    })
    expect(decision.regime).toBe('warning') // 25 default kicks in
  })

  it('honors a custom warningSizeScale (e.g., 0.25 quarter sizing)', () => {
    const decision = evaluateVixRegime(27.3, {
      warningThreshold: 25,
      criticalThreshold: 30,
      warningSizeScale: 0.25,
    })
    expect(decision.sizeScale).toBe(0.25)
    expect(decision.reason).toBe('vix_warning: 27.30 (size x0.25)')
  })
})
