# D1 運用メモ

API を介さず `wrangler d1 execute` で DB を直編集する運用。GUI・admin endpoint は当面作らない方針 (POC, #68〜#70 参照)。

## 初回セットアップ

### staging

```bash
pnpm wrangler d1 create webull-trading-staging
# => 出力された database_id を wrangler.jsonc の env.staging.d1_databases[0].database_id に貼る

pnpm wrangler d1 migrations apply webull-trading-staging --env=staging --remote
```

### production

```bash
pnpm wrangler d1 create webull-trading-production
# => 出力された database_id を wrangler.jsonc の env.production.d1_databases[0].database_id に貼る

pnpm wrangler d1 migrations apply webull-trading-production --env=production --remote
```

## Schema 変更

1. `src/infrastructure/db/schema.ts` を編集
2. `pnpm exec drizzle-kit generate --name=<description>` で `drizzle/XXXX_<name>.sql` を生成
3. レビュー → merge → staging/production で `wrangler d1 migrations apply` を順に走らせる

## 運用クエリ例

### 振り返り

```sql
-- 直近 1 週間の trade イベント集計
SELECT trade_event_type, COUNT(*) AS n
FROM trade_journal
WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
GROUP BY trade_event_type
ORDER BY n DESC;

-- symbol 別 realized PnL
SELECT symbol, COUNT(*) AS n_exits, SUM(realized_pnl) AS sum_pnl, AVG(realized_pnl) AS avg_pnl
FROM trade_journal
WHERE trade_event_type = 'exit' AND realized_pnl IS NOT NULL
GROUP BY symbol
ORDER BY sum_pnl DESC;

-- reject 理由分布 (strategy tuning ヒント)
SELECT risk_reasons, COUNT(*) AS n
FROM trade_journal
WHERE trade_event_type = 'decision' AND risk_allowed = 0
GROUP BY risk_reasons
ORDER BY n DESC
LIMIT 20;
```

### ad hoc 実行

```bash
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "SELECT trade_event_type, COUNT(*) FROM trade_journal GROUP BY trade_event_type"
```

`--remote` 無しだと local の開発 DB (`wrangler dev` 用の SQLite ファイル) に当たるので注意。

## symbol_config / inverse_pairs 運用 (#69 Phase B)

### 初期シード

```bash
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --file=docs/seed/symbol_config.sql
```

### よく使う編集

```sql
-- 新 symbol を universe に追加 (US)
INSERT INTO symbol_config (symbol, name, market, active, max_notional, updated_at)
VALUES ('GLD', 'SPDR Gold Shares', 'US', 1, 5000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- JP 個別
INSERT INTO symbol_config (symbol, name, market, active, max_notional, updated_at)
VALUES ('7203', 'トヨタ自動車', 'JP', 1, 100000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 一時停止 (ALLOWED_SYMBOLS から外れる / 次 cron から反映)
UPDATE symbol_config SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE symbol = 'SOXS';

-- 上限変更
UPDATE symbol_config SET max_notional = 3000, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE symbol = 'SOXL';

-- 銘柄名だけ更新
UPDATE symbol_config SET name = 'Direxion Daily Semiconductor Bull 3X', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE symbol = 'SOXL';

-- 逆相関ペア (単方向で書けば bidirectional に展開される)
INSERT INTO inverse_pairs (symbol, inverse, updated_at)
VALUES ('TQQQ', 'SQQQ', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

### 現状確認

```bash
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "SELECT symbol, name, market, active, max_notional FROM symbol_config ORDER BY symbol"

pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "SELECT * FROM inverse_pairs"
```

## global_config 運用 (#70 Phase D)

singleton row (`id = 'default'`) で runtime な risk / lifecycle knob を保持。env var 側からは削除済み。

### 初期シード

```bash
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --file=docs/seed/global_config.sql
```

### 運用サンプル

```sql
-- 実発注 ON に切替 (慎重に)
UPDATE global_config SET dry_run = 0, trading_enabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'default';

-- 緊急 kill-switch
UPDATE global_config SET trading_enabled = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'default';

-- drawdown 閾値を -3% に緩和
UPDATE global_config SET drawdown_kill_threshold = -0.03, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'default';

-- bridge を週末も常駐させる (値: auto / always-on / disabled)
UPDATE global_config SET bridge_run_mode = 'always-on', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'default';

-- 現状確認
SELECT dry_run, trading_enabled, max_order_notional, drawdown_kill_threshold, bridge_run_mode
FROM global_config WHERE id = 'default';
```

## currency + budget (#76 Phase E)

`symbol_config.currency` と `global_config.max_order_notional_{usd,jpy}` で通貨別の注文上限を管理する。`TradingConfig.maxOrderNotional` は route handler で symbol の currency に応じて USD 値か JPY 値を選ぶ。

### 銘柄追加時は currency を明示

```sql
-- US 銘柄 (default 'USD' でも可だが明示推奨)
INSERT INTO symbol_config (symbol, name, market, currency, active, max_notional, updated_at)
VALUES ('SOXL', 'Direxion Daily Semiconductor Bull 3X', 'US', 'USD', 1, 650,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- JP 銘柄
INSERT INTO symbol_config (symbol, name, market, currency, active, max_notional, updated_at)
VALUES ('6301', '小松製作所', 'JP', 'JPY', 1, 100000,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

### 通貨別 cap 調整

```sql
-- USD 1 注文上限を $700 に
UPDATE global_config SET max_order_notional_usd = 700,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'default';

-- JPY 1 注文上限を ¥15万に
UPDATE global_config SET max_order_notional_jpy = 150000,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'default';
```

### 総資本 (future: exposure tracking と連動)

```sql
-- 予算 20万円 × 2 (海外 + JP)
UPDATE global_config SET
  total_capital_usd = 1333,     -- ≒ ¥20万 / 150
  total_capital_jpy = 200000,
  max_portfolio_exposure_pct = 0.6,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'default';
```

**注: `total_capital_*` / `max_portfolio_exposure_pct` は schema に入れてあるが、現時点で exposure tracking 側 (PortfolioStateDO の open_exposure) が未実装。gate に反映されるのは follow-up issue 完了後。**
