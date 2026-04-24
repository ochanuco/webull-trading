import { describe, expect, it } from 'vitest'
import { localizeReason } from '../../src/routes/dashboard'

describe('localizeReason (日本株・信用取引の伝統的語彙)', () => {
  it('returns "-" for null / undefined / empty', () => {
    expect(localizeReason(null)).toBe('-')
    expect(localizeReason(undefined)).toBe('-')
    expect(localizeReason('')).toBe('-')
  })

  describe('未保有 (様子見 / データ不足)', () => {
    it('50d return unmet', () => {
      expect(localizeReason('50d return 0.0108 <= 0.03 trend threshold')).toBe(
        '様子見: 上昇トレンド未成立 (50日騰落率 +1.08% < 条件 +3.00%)',
      )
    })

    it('price <= sma50 → 移動平均線割れ', () => {
      expect(localizeReason('price 100 <= sma50 105')).toBe(
        '様子見: 50日移動平均線割れ (株価 100 < 移動平均 105)',
      )
    })

    it('pullback too shallow', () => {
      expect(localizeReason('pullback 0.0023 > -0.01 (not deep enough)')).toBe(
        '様子見: 押し目が浅い (下落率 +0.23% > 条件 -1.00%)',
      )
    })

    it('pullback too deep', () => {
      expect(localizeReason('pullback -0.08 < -0.06 (too deep)')).toBe(
        '様子見: 押し目が深すぎる/下落転換懸念 (下落率 -8.00% < 許容 -6.00%)',
      )
    })

    it('invalid 20d high', () => {
      expect(localizeReason('invalid 20d high')).toBe(
        'データ不足: 直近20日高値を算出できず',
      )
    })
  })

  describe('保有中 (利食い / 損切り / 時間切れ / 保有継続)', () => {
    it('take-profit hit → 利食い (利確目標到達)', () => {
      expect(localizeReason('take-profit hit: pnl 0.08 >= 0.07')).toBe(
        '利食い: 利確目標到達 (含み損益 +8.00% ≥ 目標 +7.00%)',
      )
    })

    it('stop-loss hit → 損切り (損切りライン到達)', () => {
      expect(localizeReason('stop-loss hit: pnl -0.05 <= -0.04')).toBe(
        '損切り: 損切りライン到達 (含み損益 -5.00% ≤ ライン -4.00%)',
      )
    })

    it('time-stop → 保有期限到達', () => {
      expect(localizeReason('time-stop hit: held 10d >= 10d')).toBe(
        '時間切れ: 保有期限到達 (保有 10d ≥ 上限 10d)',
      )
    })

    it('holding within envelope', () => {
      expect(localizeReason('holding: pnl 0.02 within (-0.04, 0.07)')).toBe(
        '保有継続: 含み損益 +2.00% (利食い +7.00% / 損切り -4.00% の範囲内)',
      )
    })
  })

  describe('BUY (押し目買い)', () => {
    it('uptrend pullback → 買い', () => {
      expect(localizeReason('pullback -0.03 in uptrend (50d return 0.12)')).toBe(
        '買い: 上昇トレンド中の押し目買い (下落率 -3.00%、50日騰落率 +12.00%)',
      )
    })
  })

  describe('発注スキップ / 発注中', () => {
    it('lot-size-round with diagnostics → 建玉可 / 1単元', () => {
      expect(
        localizeReason(
          'sizing rejected: lot-size-round (raw qty 98 < lot 100, stop 203.00, entry 2876)',
        ),
      ).toBe(
        '発注スキップ: 売買単位未満 (建玉可 98 株 < 1単元 100 株、損切り幅 203.00/株、株価 2876)',
      )
    })

    it('insufficient-risk-budget → リスク予算枯渇', () => {
      expect(
        localizeReason('sizing rejected: insufficient-risk-budget (budget 0.00)'),
      ).toBe('発注スキップ: リスク予算枯渇 (残 0.00)')
    })

    it('invalid-stop', () => {
      expect(localizeReason('sizing rejected: invalid-stop (stopDistance 0)')).toBe(
        '発注スキップ: 損切り幅が算出不能 (0)',
      )
    })

    it('atr-floor', () => {
      expect(localizeReason('sizing rejected: atr-floor')).toBe(
        '発注スキップ: ボラティリティ低下 (ATR 下限割れ)',
      )
    })

    it('symbol-cap', () => {
      expect(localizeReason('sizing rejected: symbol-cap')).toBe(
        '発注スキップ: 銘柄別投資上限超過',
      )
    })

    it('SELL without position → 手仕舞い対象の建玉なし', () => {
      expect(localizeReason('SELL without position')).toBe(
        '発注スキップ: 手仕舞い対象の建玉なし',
      )
    })

    it('pending order in flight → 約定待ち', () => {
      expect(localizeReason('pending order in flight')).toBe(
        '発注中: 直前注文の約定待ち',
      )
    })

    it('cooldown → 取引停止中', () => {
      expect(
        localizeReason('cooldown active until 2026-04-25T00:00:00.000Z'),
      ).toBe('様子見: 取引停止中 (2026-04-25T00:00:00.000Z まで)')
    })

    it('insufficient bars → 日柄不足', () => {
      expect(localizeReason('insufficient bars for indicators')).toBe(
        'データ不足: 指標計算に必要な日柄不足',
      )
    })

    it('broker submit error → 証券会社側で拒否', () => {
      expect(localizeReason('broker submit error: Webull 429')).toBe(
        '発注エラー: 証券会社側で拒否 — Webull 429',
      )
    })
  })

  describe('同グループ建玉上限 (bucket)', () => {
    it('bucket cap projected over', () => {
      expect(localizeReason('bucket cap: semi projected 500 > 300')).toBe(
        '発注スキップ: 同グループ建玉上限超過 (semi 合計 500 > 上限 300)',
      )
    })
  })

  it('does not touch unknown strings', () => {
    expect(localizeReason('totally unknown reason text')).toBe(
      'totally unknown reason text',
    )
  })
})
