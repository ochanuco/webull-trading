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
