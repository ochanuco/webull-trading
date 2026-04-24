import { describe, expect, it } from 'vitest'
import { localizeReason } from '../../src/routes/dashboard'

describe('localizeReason (unified template, beginner-friendly JP)', () => {
  it('returns "-" for null / undefined / empty', () => {
    expect(localizeReason(null)).toBe('-')
    expect(localizeReason(undefined)).toBe('-')
    expect(localizeReason('')).toBe('-')
  })

  describe('未保有 (様子見 / データ不足)', () => {
    it('50d return unmet', () => {
      expect(localizeReason('50d return 0.0108 <= 0.03 trend threshold')).toBe(
        '様子見: 上昇トレンド不成立 (50日騰落率 +1.08% < 必要 +3.00%)',
      )
    })

    it('price <= sma50', () => {
      expect(localizeReason('price 100 <= sma50 105')).toBe(
        '様子見: 50日移動平均 (SMA50) を下回る (株価 100 < SMA50 105)',
      )
    })

    it('pullback too shallow', () => {
      expect(localizeReason('pullback 0.0023 > -0.01 (not deep enough)')).toBe(
        '様子見: 押し目が浅い (下落率 +0.23% > 必要 -1.00%)',
      )
    })

    it('pullback too deep', () => {
      expect(localizeReason('pullback -0.08 < -0.06 (too deep)')).toBe(
        '様子見: 押し目が深すぎる/下落転換の恐れ (下落率 -8.00% < 許容 -6.00%)',
      )
    })

    it('invalid 20d high', () => {
      expect(localizeReason('invalid 20d high')).toBe(
        'データ不足: 直近20日高値を算出できず',
      )
    })
  })

  describe('保有中 (利食い / 損切り / 時間切れ / 保有継続)', () => {
    it('take-profit hit', () => {
      expect(localizeReason('take-profit hit: pnl 0.08 >= 0.07')).toBe(
        '利食い: 目標到達 (損益 +8.00% ≥ 目標 +7.00%)',
      )
    })

    it('stop-loss hit', () => {
      expect(localizeReason('stop-loss hit: pnl -0.05 <= -0.04')).toBe(
        '損切り: 下限到達 (損益 -5.00% ≤ 下限 -4.00%)',
      )
    })

    it('time-stop', () => {
      expect(localizeReason('time-stop hit: held 10d >= 10d')).toBe(
        '時間切れ: 最大保有期間到達 (保有 10d ≥ 上限 10d)',
      )
    })

    it('holding within envelope', () => {
      expect(localizeReason('holding: pnl 0.02 within (-0.04, 0.07)')).toBe(
        '保有継続: 損益 +2.00% (利食い +7.00% / 損切り -4.00% の範囲内)',
      )
    })
  })

  describe('BUY signal (買い)', () => {
    it('uptrend pullback → 買い', () => {
      expect(localizeReason('pullback -0.03 in uptrend (50d return 0.12)')).toBe(
        '買い: 上昇トレンド中の押し目 (下落率 -3.00%、50日騰落率 +12.00%)',
      )
    })
  })

  describe('発注スキップ / 発注中', () => {
    it('lot-size-round with diagnostics', () => {
      expect(
        localizeReason(
          'sizing rejected: lot-size-round (raw qty 98 < lot 100, stop 203.00, entry 2876)',
        ),
      ).toBe(
        '発注スキップ: 売買単位未満 (リスク許容 98 株 < 1単元 100 株、stop 203.00/株、株価 2876)',
      )
    })

    it('insufficient-risk-budget with diagnostics', () => {
      expect(
        localizeReason('sizing rejected: insufficient-risk-budget (budget 0.00)'),
      ).toBe('発注スキップ: リスク予算が枯渇 (残 0.00)')
    })

    it('invalid-stop with diagnostics', () => {
      expect(localizeReason('sizing rejected: invalid-stop (stopDistance 0)')).toBe(
        '発注スキップ: 損切り幅を算出できず (stopDistance 0)',
      )
    })

    it('atr-floor', () => {
      expect(localizeReason('sizing rejected: atr-floor')).toBe(
        '発注スキップ: ボラティリティ低下 (ATR 下限割れ)',
      )
    })

    it('symbol-cap', () => {
      expect(localizeReason('sizing rejected: symbol-cap')).toBe(
        '発注スキップ: 銘柄別の投資上限超過',
      )
    })

    it('SELL without position', () => {
      expect(localizeReason('SELL without position')).toBe(
        '発注スキップ: 売却対象のポジションなし',
      )
    })

    it('pending order in flight', () => {
      expect(localizeReason('pending order in flight')).toBe(
        '発注中: 直前注文の結果待ち',
      )
    })

    it('cooldown', () => {
      expect(
        localizeReason('cooldown active until 2026-04-25T00:00:00.000Z'),
      ).toBe('様子見: クールダウン中 (2026-04-25T00:00:00.000Z まで取引停止)')
    })

    it('insufficient bars', () => {
      expect(localizeReason('insufficient bars for indicators')).toBe(
        'データ不足: 指標計算に必要な日柄が揃わず',
      )
    })

    it('broker submit error', () => {
      expect(localizeReason('broker submit error: Webull 429')).toBe(
        '発注エラー: 証券会社側で拒否 — Webull 429',
      )
    })
  })

  describe('Bucket cap (セクター枠)', () => {
    it('bucket cap projected over', () => {
      expect(localizeReason('bucket cap: semi projected 500 > 300')).toBe(
        '発注スキップ: セクター枠超過 (semi 合計 500 > 上限 300)',
      )
    })
  })

  it('does not touch unknown strings', () => {
    expect(localizeReason('totally unknown reason text')).toBe(
      'totally unknown reason text',
    )
  })
})
