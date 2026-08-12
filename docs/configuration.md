# Runtime 設定 (global_config / symbol_config)

運用パラメタは **D1 が真値**。`global_config` singleton (`id='default'`) を `UPDATE` すれば **deploy なしで次の cron から反映**される (#118 で確立した方針)。未シード時は `GLOBAL_CONFIG_DEFAULTS` にフォールバックする。

編集手順と SQL レシピは [`db-operations.md`](db-operations.md)、画面からの操作は `/dashboard/config` と `/dashboard/symbols`。変更は `config_audit_log` / `trading_toggle_history` に記録される。

## Kill-switch / gate

| フィールド | 既定 | 意味 |
|---|---|---|
| `dry_run` | `1` | Execution Mock に固定、broker へ送らない |
| `trading_enabled` | `0` | Risk layer が全注文 reject (**exit も止まる** 唯一の停止) |
| `market_hours_check` | `0` | 手動 `/trade` 経路の発注ゲート。銘柄の市場別レギュラーセッション (US/JP・祝日・半日取引対応) 外を reject。cron 経路は `session_window_gate_enabled` が担当 (#656) |
| `session_window_gate_enabled` | `0` | 開場 30 分前〜引けの窓外は戦略 cron の評価自体を skip |
| `drawdown_kill_threshold` | `-0.02` | 日次 realized_pnl / start_equity 比で自動 kill (**entry のみ停止**、#595) |
| `stale_quote_ms` | `900000` | halt 判定 (15 min) |

## 通貨別 cap / 予算 (#76)

| フィールド | 既定 | 意味 |
|---|---|---|
| `max_order_notional_usd` | `2000` | USD 銘柄の 1 注文上限 ($) |
| `max_order_notional_jpy` | `100000` | JPY 銘柄の 1 注文上限 (¥) |
| `total_capital_usd` / `_jpy` | `NULL` | NAV (NULL なら exposure check skip) |
| `max_portfolio_exposure_pct` | `0.6` | total_capital × これを超える open 合計を禁止 |
| `spread_limit_pct_{us,jp}` | `0.0025` / `0.006` | spread guard |
| `gap_reject_pct` | `0.03` | gap 判定 |

## 売買コスト (#trade-cost)

| フィールド | 既定 | 意味 |
|---|---|---|
| `fee_pct_of_notional` | `0` | 約定代金に対する料率。realized PnL を net 化する |
| `fee_fixed_per_order` | `0` | 1 注文あたりの固定費 (銘柄通貨建て) |

> **米国株・ETF の売買手数料は 2026-07-27 17:30 JST 約定分から無料** (ウィブル証券、恒久)。それ以前は 0.20% 税抜 / 片道。残るのは売却時の SEC ($20.60/$1M) と FINRA TAF ($0.000195/株)、CAT Fee、両替時の為替スプレッド (15 銭/USD) だけで、$200 の往復なら約 $0.005。**したがって上記 2 列は 0 のままが実態に一致する**。根拠は `src/trading/domain/tradingCost.ts` の冒頭コメント。

## Pullback 戦略の default rule (#118 / #124)

| フィールド | 既定 | 意味 |
|---|---|---|
| `pullback_default_stop_pct` | `-0.04` | pct-based stop (ATR stop の floor) |
| `pullback_default_take_profit_pct` | `0.07` | take-profit |
| `pullback_default_time_stop_days` | `10` | 保有上限 (営業日) |
| `pullback_default_pullback_{max,min}` | `-0.03` / `-0.06` | entry 窓 (直近 10 営業日高値から) |
| `pullback_default_min_return_50d` | `0.08` | **20 営業日**リターンの uptrend filter (列名の `50d` は #318 以前の名残) |
| `pullback_default_require_above_sma50` | `1` | sma50 超を entry 必須 |
| `pullback_default_k_atr` | `2.0` | ATR 倍率。`stopDistance = max(k_atr × atr20, pct stop)` |
| `pullback_default_max_sma50_deviation_pct` | `0.6` | sma50 からの上方乖離が大きすぎる時は entry 見送り |
| `pullback_default_max_atr_ratio` | `1.1` | 過熱ガードの閾値。`atr20 / baseline` がこれを超えたら entry 見送り |
| `pullback_default_max_stop_to_tp_ratio` | `2.0` | stop 幅の上限 = `take_profit_pct × これ`。R:R に下限を作る (2.0 = R:R 0.5 以上)。`0` で無効 |
| `atr_baseline_exclude_recent` | `0` | baseline ATR から直近 20 本を除外。`1` にすると比率が素直になるが**閾値の再校正が必要** ([#598](https://github.com/ochanuco/webull-trading/pull/598)) |

## Risk gate の動的パラメタ (#23)

| フィールド | 既定 | 意味 |
|---|---|---|
| `risk_base_per_trade_pct` | `0.004` | 1 trade 基準 risk (%) |
| `risk_dd_half_threshold` | `-0.05` | 日次 DD でこれ未満 → size 0.5× |
| `risk_dd_halt_threshold` | `-0.10` | 日次 DD でこれ未満 → size 0 (halt) |
| `vix_warning_threshold` | `25.0` | VIX がこれ超で size scale 適用 |
| `vix_critical_threshold` | `30.0` | VIX がこれ超で新規 entry 停止 |
| `vix_warning_size_scale` | `0.5` | warning 帯での size 倍率 |
| `pair_regime_mode` | `'off'` | ペアレジーム layer (#472)。`off` / `observe` (log のみ) / `enforce` |
| `cash_fallback_orders_enabled` | `0` | 余剰現金の退避先 (SGOV 等) への自動 BUY を許可 (#452) |

## ニュースショック gate

`attention_observation` (GDELT 由来) を baseline と比較して急騰を検知する。

| フィールド | 既定 | 意味 |
|---|---|---|
| `news_shock_mode` | `'off'` | `off` / `observe` (log のみ) / `enforce` |
| `news_shock_warn_ratio` | `2.3` | baseline median 比でこれ超 → warning (12ヶ月実測の p90 由来) |
| `news_shock_block_ratio` | `4.4` | 同、これ超 → BUY block (上位約 1%) |
| `news_shock_warn_size_scale` | `0.5` | warning 帯での size 倍率 |
| `news_shock_tone_drop_threshold` | `1.5` | tone 悪化の閾値 |
| `news_shock_require_tone` | `1` | tone が取れないとき shock 判定を成立させない |
| `news_shock_baseline_days` | `7` | baseline の対象日数 |
| `news_shock_min_samples` | `200` | baseline 成立に必要な最小サンプル数 |
| `news_shock_window_min` | `120` | 評価窓 (分) |
| `news_shock_max_age_min` | `90` | 観測値の許容鮮度 (分) |
| `attention_stale_policy` | `'fail_open'` | 観測が古い時の扱い。`fail_open` / `block_buy` |

baseline median は **非ゼロ値のみ**で算出する。`market_selloff` のような
sparse probe (平時ニュースが無く volume=0 の時間帯が大半) を全点 (ゼロ込み)
で median を取ると常に 0 になり ratio が意味を失う — baseline サンプル数
(`news_shock_min_samples` の判定対象) 自体はゼロ込みのまま、median 計算だけ
非ゼロ値に絞る。

`news_shock_mode` が `off` 以外の間は、regime 遷移時の STATE_CHANGE 通知
(Slack/Discord) に加えて、22:00 UTC の日次 cron (portfolio roll と相乗り) が
合成 regime + probe 別の判定を日本語で配信する。regime 変化が無くて
も毎日届くので、閾値が実データに対して妥当かの校正材料になる。
サマリは push 専用で `notification_emit_log` には残らない (dashboard の
alerts view は異常・約定の記録に限る)。

日次サマリは strategy tick と違い **最新観測時点** (`latest_observation`) で
評価する。GDELT の集計反映は実測 1〜7 時間遅れるため、now 基準だと
`news_shock_max_age_min` (既定 90 分) の鮮度チェックにほぼ常に落ちて
「判定不能」しか出ない — サマリでは観測時刻と遅延を併記し、届いている
データの範囲でどう判定されるかを届ける。strategy tick (発注経路) は従来通り
now 基準で、古い観測では BUY を絞らない (fail-open) まま。

## per-symbol / テーブル由来の制御

- `symbol_config.active = 0` にすれば universe から外れて cron から除外される
- `symbol_config` の override (`stop_pct_override` / `k_atr_override` / `lot_size` / `budget_alloc_pct` / `role` など) が global default に優先する
- `inverse_pairs` で SOXL/SOXS のような同時保有を構造的に禁止する
- `tradable_instrument` は Webull の取扱可能銘柄 allowlist (日次 refresh)

## アクセス制御

- Cloudflare Access JWT で `/trade/*` / `/webull/*` / `/admin/*` / `/dashboard/*` / `/mcp` を保護 (#29)
- state 変更 / admin write / dashboard GET は Workers Rate Limit binding で cap (#285)
