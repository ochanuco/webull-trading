import { describe, expect, it } from 'vitest'
import { moreConservativeNewsShockDecision } from '../../../src/trading/risk/newsShockDecision'
import type { NewsShockGateDecision } from '../../../src/trading/risk/newsShockGate'

/**
 * `moreConservativeNewsShockDecision` (probe 別 decision の合成) の単体テスト
 * (news-shock-gate follow-up)。
 *
 * 主眼は rank 変更の回帰ガード: `NEWS_SHOCK_SEVERITY_RANK` が
 * `{ unknown: 0, normal: 1, warning: 2, critical: 3 }` になったことで、
 * sizeScale が同点 (1.0) の unknown と normal では normal が勝つ
 * (= 片方の probe が sparse/degenerate で恒常的に unknown でも、もう片方の
 * probe が normal であれば合成結果が normal になり、regime 変化が観測できる
 * ようになる)。`attentionStalePolicy='block_buy'` の unknown (sizeScale=0) は
 * sizeScale 優先比較で先に勝つため、fail-closed 挙動は変わらない。
 */

const ASOF = '2026-04-25T12:00:00.000Z'

function decision(overrides: Partial<NewsShockGateDecision>): NewsShockGateDecision {
  return {
    regime: 'normal',
    sizeScale: 1.0,
    reason: 'news_shock_normal: 1.0x',
    ratio: 1.0,
    toneDrop: null,
    asOf: ASOF,
    ...overrides,
  }
}

describe('moreConservativeNewsShockDecision', () => {
  it('prefers normal over unknown when both have sizeScale=1.0 (data-backed regime wins the tie)', () => {
    const normal = decision({ regime: 'normal', sizeScale: 1.0, reason: 'news_shock_normal: 1.0x' })
    const unknown = decision({
      regime: 'unknown',
      sizeScale: 1.0,
      reason: 'news_shock_degenerate_baseline: all-zero',
      ratio: null,
    })
    expect(moreConservativeNewsShockDecision(normal, unknown)).toBe(normal)
    expect(moreConservativeNewsShockDecision(unknown, normal)).toBe(normal)
  })

  it('stays unknown when both probes are unknown', () => {
    const a = decision({ regime: 'unknown', sizeScale: 1.0, reason: 'news_shock_unavailable_fallback_normal', ratio: null })
    const b = decision({
      regime: 'unknown',
      sizeScale: 1.0,
      reason: 'news_shock_degenerate_baseline: all-zero',
      ratio: null,
    })
    const combined = moreConservativeNewsShockDecision(a, b)
    expect(combined.regime).toBe('unknown')
  })

  it('prefers warning (lower sizeScale) over normal regardless of the regime rank', () => {
    const warning = decision({
      regime: 'warning',
      sizeScale: 0.5,
      reason: 'news_shock_warning: 2.8x (size x0.5)',
      ratio: 2.8,
    })
    const normal = decision({ regime: 'normal', sizeScale: 1.0, reason: 'news_shock_normal: 1.0x' })
    expect(moreConservativeNewsShockDecision(warning, normal)).toBe(warning)
    expect(moreConservativeNewsShockDecision(normal, warning)).toBe(warning)
  })

  it('prefers unknown+block_buy (sizeScale=0) over normal — fail-closed escape hatch unaffected by the rank change', () => {
    const blockedUnknown = decision({
      regime: 'unknown',
      sizeScale: 0,
      reason: 'news_shock_unavailable_fallback_normal',
      ratio: null,
    })
    const normal = decision({ regime: 'normal', sizeScale: 1.0, reason: 'news_shock_normal: 1.0x' })
    expect(moreConservativeNewsShockDecision(blockedUnknown, normal)).toBe(blockedUnknown)
    expect(moreConservativeNewsShockDecision(normal, blockedUnknown)).toBe(blockedUnknown)
  })
})
