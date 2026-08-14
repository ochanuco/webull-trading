import { describe, expect, it } from 'vitest'
import {
  buildNewsShockRegimeHeadline,
  moreConservativeNewsShockDecision,
} from '../../../src/trading/risk/newsShockDecision'
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

describe('buildNewsShockRegimeHeadline', () => {
  it('describes a warning entry with the ratio and the observe no-op note', () => {
    const d = decision({ regime: 'warning', sizeScale: 0.5, ratio: 2.8 })
    expect(buildNewsShockRegimeHeadline('normal', 'warning', d, 'observe')).toBe(
      'ニュース報道量が急増 (平時の2.8倍) — observe中のため発注は変更しません',
    )
  })

  it('describes a warning entry in enforce mode with the size scale action', () => {
    const d = decision({ regime: 'warning', sizeScale: 0.5, ratio: 2.8 })
    expect(buildNewsShockRegimeHeadline('normal', 'warning', d, 'enforce')).toBe(
      'ニュース報道量が急増 (平時の2.8倍) — 新規買い数量を縮小します (x0.5)',
    )
  })

  it('describes a critical entry with tone deterioration and the mode-dependent action', () => {
    const d = decision({ regime: 'critical', sizeScale: 0, ratio: 5.1, toneDrop: 2.3 })
    expect(buildNewsShockRegimeHeadline('warning', 'critical', d, 'observe')).toContain(
      '本来は新規買い停止 (observe中: 発注は変更しません)',
    )
    expect(buildNewsShockRegimeHeadline('warning', 'critical', d, 'enforce')).toContain(
      '新規買いを停止します',
    )
  })

  it('describes easing back to normal from warning/critical as 解除', () => {
    const d = decision({ regime: 'normal', ratio: 1.3 })
    expect(buildNewsShockRegimeHeadline('warning', 'normal', d, 'observe')).toBe(
      'ニュース過熱シグナル解除 — 平常に戻りました (現在平時の1.3倍)',
    )
  })

  it('returns undefined for unknown→normal (データ欠測回復は通知自体を抑制する前提)', () => {
    const d = decision({ regime: 'normal', ratio: 1.3 })
    expect(buildNewsShockRegimeHeadline('unknown', 'normal', d, 'observe')).toBeUndefined()
  })
})
