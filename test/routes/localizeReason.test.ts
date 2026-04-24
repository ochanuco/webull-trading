import { describe, expect, it } from 'vitest'
import { localizeReason } from '../../src/routes/dashboard'

describe('localizeReason', () => {
  it('returns "-" for null / undefined / empty', () => {
    expect(localizeReason(null)).toBe('-')
    expect(localizeReason(undefined)).toBe('-')
    expect(localizeReason('')).toBe('-')
  })

  it('prefixes entry-side HOLD reasons with "entry 見送り:" and converts ratios to %', () => {
    // The dashboard reason that confused the operator in #132 (6971 HOLD).
    expect(
      localizeReason('50d return 0.0108 <= 0.03 trend threshold'),
    ).toBe('entry 見送り: 50日 return 1.08% ≤ 必要値 3.00% (上昇トレンド filter)')
    expect(localizeReason('price 100 <= sma50 105')).toBe(
      'entry 見送り: 価格 100 ≤ SMA50 105 (上昇トレンド filter)',
    )
    expect(
      localizeReason('pullback 0.0023 > -0.01 (not deep enough)'),
    ).toBe('entry 見送り: 押し目 0.23% が浅すぎる (閾値 -1.00%)')
    expect(
      localizeReason('pullback -0.08 < -0.06 (too deep)'),
    ).toBe('entry 見送り: 押し目 -8.00% が深すぎる (閾値 -6.00%)')
  })

  it('suffixes exit-side reasons with "(exit)"', () => {
    expect(localizeReason('take-profit hit: pnl 0.08 >= 0.07')).toBe(
      '利確到達 (pnl 8.00% ≥ 7.00%) (exit)',
    )
    expect(localizeReason('stop-loss hit: pnl -0.05 <= -0.04')).toBe(
      '損切到達 (pnl -5.00% ≤ -4.00%) (exit)',
    )
    expect(localizeReason('time-stop hit: held 10d >= 10d')).toBe(
      '時間切れ (保有 10d ≥ 10d) (exit)',
    )
    expect(localizeReason('holding: pnl 0.02 within (-0.04, 0.07)')).toBe(
      '保有継続 (pnl 2.00%、範囲 -4.00% 〜 7.00%) (exit)',
    )
  })

  it('translates BUY signal reason with % formatting', () => {
    expect(
      localizeReason('pullback -0.03 in uptrend (50d return 0.12)'),
    ).toBe('BUY 判定: 押し目 -3.00%、上昇トレンド継続 (50日 return 12.00%)')
  })

  it('keeps sizing / scheduler / bucket reasons as-is (already clear)', () => {
    expect(localizeReason('sizing rejected: lot-size-round')).toBe(
      'サイジング拒否: ロット丸め後に最小取引単位未満',
    )
    expect(localizeReason('sizing rejected: insufficient-risk-budget')).toBe(
      'サイジング拒否: リスク予算不足',
    )
    expect(localizeReason('SELL without position')).toBe('SELL 対象ポジションなし')
    expect(
      localizeReason('bucket cap: semi projected 500 > 300'),
    ).toBe('バケット cap: semi 合計 500 が上限 300 を超過')
  })

  it('does not touch unknown strings (forward-compat for new reason formats)', () => {
    expect(localizeReason('totally unknown reason text')).toBe(
      'totally unknown reason text',
    )
  })
})
