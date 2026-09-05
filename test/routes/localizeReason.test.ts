import { describe, expect, it } from 'vitest'
import { localizeReason } from '../../src/routes/dashboard'

describe('localizeReason (日本株・信用取引の伝統的語彙)', () => {
  it('returns "-" for null / undefined / empty', () => {
    expect(localizeReason(null)).toBe('-')
    expect(localizeReason(undefined)).toBe('-')
    expect(localizeReason('')).toBe('-')
  })

  describe('未保有 (様子見 / データ不足)', () => {
    // #318: trend filter は 20d return (短期 swing 整合化)。historical 行は
    // `50d return ...` を含むので両方の入力を受け、同じ localized 出力を返す。
    it('20d return unmet', () => {
      expect(localizeReason('20d return 0.0108 <= 0.03 trend threshold')).toBe(
        '様子見: 上昇トレンド未成立 (騰落率 +1.08% ≤ 条件 +3.00%)',
      )
    })

    it('legacy 50d return reason still localizes (backward compat)', () => {
      expect(localizeReason('50d return 0.0108 <= 0.03 trend threshold')).toBe(
        '様子見: 上昇トレンド未成立 (騰落率 +1.08% ≤ 条件 +3.00%)',
      )
    })

    it('price <= sma50 → 移動平均線割れ', () => {
      expect(localizeReason('price 100 <= sma50 105')).toBe(
        '様子見: 50日移動平均線割れ (株価 100 ≤ 移動平均 105)',
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

    it('overextended (SMA50 上方乖離過大)', () => {
      expect(localizeReason('sma50 deviation 0.9200 > 0.6 (overextended)')).toBe(
        '様子見: 過熱 (移動平均からの上方乖離 +92.00% > 条件 +60.00%)',
      )
    })

    it('volatility elevated (ATR比過大)', () => {
      expect(localizeReason('atr ratio 2.67 > 1.5 (volatility elevated)')).toBe(
        '様子見: ボラ過熱 (ATR比 2.67倍 > 条件 1.5倍)',
      )
    })

    it('invalid 10d high', () => {
      expect(localizeReason('invalid 10d high')).toBe(
        'データ不足: 直近高値を算出できず',
      )
    })

    it('legacy invalid 20d high still localizes (backward compat)', () => {
      expect(localizeReason('invalid 20d high')).toBe(
        'データ不足: 直近高値を算出できず',
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
    // #318: 20d return into new code path、historical 行は 50d 形式。
    it('uptrend pullback (20d return) → 買い', () => {
      expect(localizeReason('pullback -0.03 in uptrend (20d return 0.12)')).toBe(
        '買い: 上昇トレンド中の押し目買い (下落率 -3.00%、騰落率 +12.00%)',
      )
    })

    it('legacy uptrend pullback (50d return) still localizes (backward compat)', () => {
      expect(localizeReason('pullback -0.03 in uptrend (50d return 0.12)')).toBe(
        '買い: 上昇トレンド中の押し目買い (下落率 -3.00%、騰落率 +12.00%)',
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
        '買付余力不足: 売買単位未満 (98 株 < 1単元 100 株、株価 2876)',
      )
    })

    it('insufficient-risk-budget', () => {
      expect(
        localizeReason('sizing rejected: insufficient-risk-budget (budget 0.00)'),
      ).toBe('買付余力不足: リスク予算残 0.00')
    })

    it('invalid-stop', () => {
      expect(localizeReason('sizing rejected: invalid-stop (stopDistance 0)')).toBe(
        '発注見送り: 損切り幅が算出不能 (0)',
      )
    })

    it('atr-floor', () => {
      expect(localizeReason('sizing rejected: atr-floor')).toBe(
        '発注見送り: ボラティリティ低下 (ATR 下限割れ)',
      )
    })

    it('symbol-cap', () => {
      expect(localizeReason('sizing rejected: symbol-cap')).toBe(
        '発注見送り: 銘柄別投資上限超過',
      )
    })

    it('SELL without position → 手仕舞い対象の保有なし', () => {
      expect(localizeReason('SELL without position')).toBe(
        '発注スキップ: 手仕舞い対象の保有なし',
      )
    })

    it('pending order in flight → 約定待ち', () => {
      expect(localizeReason('pending order in flight')).toBe(
        '発注中: 直前注文の約定待ち',
      )
    })

    it('cooldown → 取引停止中 (JST 表記)', () => {
      // UTC 2026-04-25T00:00:00.000Z → JST 2026-04-25 09:00:00
      expect(
        localizeReason('cooldown active until 2026-04-25T00:00:00.000Z'),
      ).toBe('様子見: 取引停止中 (2026-04-25 09:00:00 JST まで)')
    })

    it('cooldown with unparseable timestamp falls back to raw', () => {
      expect(localizeReason('cooldown active until not-a-date')).toBe(
        '様子見: 取引停止中 (not-a-date まで)',
      )
    })

    it('spread reject (鮮度 suffix 付き) → 休場・閉場中の可能性を明示 (#547)', () => {
      // UTC 2026-07-02T20:00:00.000Z → JST 2026-07-03 05:00:00
      expect(
        localizeReason(
          'spread 15.121% exceeds US limit 0.250% (quote asOf 2026-07-02T20:00:00.000Z, 19.3h stale)',
        ),
      ).toBe(
        '発注スキップ: 気配スプレッド過大 (15.121% > US 上限 0.250%、板情報は 2026-07-03 05:00:00 JST 時点 / 19.3時間前 — 休場・閉場中の可能性)',
      )
    })

    it('spread reject (suffix なしの旧形式) → 数値のみ翻訳', () => {
      expect(localizeReason('spread 15.121% exceeds US limit 0.250%')).toBe(
        '発注スキップ: 気配スプレッド過大 (15.121% > US 上限 0.250%)',
      )
    })

    it('news shock critical (with tone) → 緊急停止', () => {
      expect(localizeReason('risk: news_shock_critical: 5.1x tone-2.3 (block)')).toBe(
        '発注スキップ: ニュース過熱で緊急停止 (報道量 baseline比 5.1倍、論調悪化 2.3)',
      )
    })

    it('news shock critical (no tone, requireTone=false) → 緊急停止', () => {
      expect(localizeReason('risk: news_shock_critical: 5.1x (block)')).toBe(
        '発注スキップ: ニュース過熱で緊急停止 (報道量 baseline比 5.1倍)',
      )
    })

    it('news shock warning (qty successfully scaled) → 数値のみ翻訳', () => {
      expect(localizeReason('risk: news_shock_warning: 2.8x (size x0.5)')).toBe(
        '発注スキップ: ニュース過熱で発注数量縮小 (報道量 baseline比 2.8倍、数量 x0.5)',
      )
    })

    it('news shock warning rounded to 0 → lot 情報も翻訳', () => {
      expect(
        localizeReason('risk: news_shock_warning: 2.8x (size x0.5) (qty rounded to 0, lot=100)'),
      ).toBe('発注スキップ: ニュース過熱で発注数量縮小 (報道量 baseline比 2.8倍、数量 x0.5、売買単位 100 未満で見送り)')
    })

    it('news shock unavailable (block_buy policy) → データ不足', () => {
      expect(localizeReason('risk: news_shock_unavailable_fallback_normal')).toBe(
        '発注スキップ: ニュース観測データ不足 (block_buy 設定により新規買い停止)',
      )
    })

    it('news shock insufficient baseline (block_buy policy) → サンプル不足', () => {
      expect(localizeReason('risk: news_shock_insufficient_baseline: 84/200')).toBe(
        '発注スキップ: ニュース baseline サンプル不足 (84/200件、block_buy 設定により新規買い停止)',
      )
    })

    it('news shock degenerate baseline (block_buy policy) → 全点ゼロ', () => {
      expect(localizeReason('risk: news_shock_degenerate_baseline: all-zero')).toBe(
        '発注スキップ: ニュース baseline が全点ゼロ (block_buy 設定により新規買い停止)',
      )
    })

    it('insufficient bars → 日柄不足', () => {
      expect(localizeReason('insufficient bars for indicators')).toBe(
        'データ不足: 指標計算に必要な日柄不足',
      )
    })

    it('broker submit error → 発注失敗 (確定拒否か一時的かは decision 列が区別)', () => {
      expect(localizeReason('broker submit error: Webull 429')).toBe(
        '発注失敗: 証券会社への発注が成立せず — Webull 429',
      )
    })

    it('capital-unset → 総資産未設定', () => {
      expect(
        localizeReason(
          'sizing rejected: capital-unset (set total_capital_usd / total_capital_jpy for risk-% sizing)',
        ),
      ).toBe('発注見送り: 総資産未設定 (risk-% sizing には total_capital_usd / total_capital_jpy の設定が必要)')
    })

    it('portfolio exposure cap unavailable → 建玉上限データ取得不可', () => {
      expect(
        localizeReason('risk: portfolio exposure cap unavailable (total_capital_jpy unset)'),
      ).toBe('発注スキップ: 建玉上限データ取得不可 (total_capital_jpy unset)')
    })

    it('portfolio exposure cap exceeded → 建玉上限超過 (remaining ベース)', () => {
      expect(
        localizeReason('risk: portfolio exposure cap (notionalJpy 50000 > remaining 30000 of ceiling 600000)'),
      ).toBe('発注スキップ: 建玉上限超過 (発注金額 50000円 > 残枠 30000円 / 上限 600000円)')
    })

    it('stale price (intraday bar unavailable) → 価格データ不足', () => {
      expect(
        localizeReason('stale price: intraday bar unavailable, daily close fallback not accepted for BUY'),
      ).toBe('発注スキップ: 価格データ不足 (直近1時間足が取得できず、日足終値での代用は不可)')
    })

    it('stale price (intraday_60m age exceeded) → 価格データが古い (JST 表記)', () => {
      expect(
        localizeReason('stale price: intraday_60m as of 2026-04-25T00:00:00.000Z exceeds 3600000ms'),
      ).toBe('発注スキップ: 価格データが古い (1時間足時点 2026-04-25 09:00:00 JST が許容 3600000ms を超過)')
    })

    it('exit evaluation unavailable while holding → データ不足 (保有中の手仕舞い判定不能)', () => {
      expect(
        localizeReason('exit evaluation unavailable while holding 5: insufficient bars for indicators'),
      ).toBe('データ不足: 保有中の手仕舞い判定不能 (保有 5 株) — insufficient bars for indicators')
    })

    it('outside regular session (BUY deferred) → 様子見', () => {
      expect(localizeReason('outside regular session: BUY deferred (exits still evaluated)')).toBe(
        '様子見: 通常取引時間外のため新規買い見送り (手仕舞いは継続評価)',
      )
    })

    it('symbol inactive: exit-only → 様子見', () => {
      expect(localizeReason('symbol inactive: exit-only')).toBe(
        '様子見: 銘柄無効化済み (保有分の手仕舞いのみ実施)',
      )
    })

    it('intraday-only no new entry within 30min of US close → 様子見', () => {
      expect(localizeReason('intraday-only: no new entry within 30min of US close')).toBe(
        '様子見: 引け30分前のため新規エントリー見送り (オーバーナイト回避)',
      )
    })

    // #cash-rebalance-skipped: `cash rebalance skipped: ...` は既存 reason への
    // suffix (`${signal.reason}; cash rebalance skipped: ${skipWhy}`) として
    // 付与される。localizeReason のルールは `^...$` の完全一致 (この pullback
    // ルール含む) がほとんどで、suffix が付くと元の reason 部分にもマッチしなく
    // なる — 結果、この compound reason は丸ごと未翻訳のまま画面に出る。
    it('cash rebalance skipped suffix breaks the underlying reason match (left fully untranslated, by design)', () => {
      const compound = 'pullback 0.0023 > -0.01 (not deep enough); cash rebalance skipped: some reason'
      expect(localizeReason(compound)).toBe(compound)
    })
  })

  it('does not touch unknown strings', () => {
    expect(localizeReason('totally unknown reason text')).toBe(
      'totally unknown reason text',
    )
  })
})
