# Production deployment runbook (#21 / #24)

webull-trading を本番口座 (`webull-trading-production`) に投入する手順。`docs/env-separation.md` の env 設計を前提に、staging から production に切替えるときに **1 つの doc を見れば全 step が分かる** よう checklist 化したもの。

POC 段階を脱して live trade を有効化するときの "推奨フロー" は:

```text
[A] 事前準備 (D1 / secret 投入 + DO seed)
    ↓
[B] deploy + probe で疎通確認
    ↓
[C] 数日間 paper trading 観察 (dryRun=true 維持)
    ↓
[D] live 有効化 (dryRun=false + TRADING_ENABLED 解除)
```

途中で問題が出たら `[D] → [C]` に戻す (= dryRun を true に戻す) のは即時可能 (再 deploy 不要、D1 update のみ)。

## [A] 事前準備

### A1. D1 (production) を発行 + migration

```bash
# D1 database 発行
pnpm wrangler d1 create webull-trading-production
# → 出力された database_id を wrangler.jsonc env.production.d1_databases[0].database_id に貼る
# (現状は REPLACE_WITH_PRODUCTION_ID プレースホルダ)

# Migration を流す
pnpm wrangler d1 migrations apply webull-trading-production --env=production --remote
```

### A2. Secret を production env に投入

すべて `pnpm wrangler secret put <KEY> --env=production` で 1 件ずつ:

| Key | 値の取得方法 |
|---|---|
| `WEBULL_APP_KEY` | 本番 OpenAPI app の App Key (1Password から取得、staging と同一値) |
| `WEBULL_APP_SECRET` | 同上 |
| `WEBULL_ACCOUNT_ID_JP_CASH` | **`1253777401159155712`** (本番口座、`pnpm run accounts` で再確認可能) |
| `CF_ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Zero Trust application AUD tag |
| `TRADING_ENABLED` | **`false`** (初期は強制 OFF、deploy-gate 保険) |
| `SLACK_WEBHOOK_URL` | (任意) production 通知用 webhook |
| `DISCORD_WEBHOOK_URL` | (任意) 同上 |
| `DASHBOARD_BASE_URL` | `https://trading.chanu.co` |

**禁止**: `ACCESS_DEV_BYPASS_USER` は deployed env で絶対に投入しない (middleware は `CF_ACCESS_TEAM_DOMAIN` 立っていれば bypass を honor しないが、二重防御で secret 自体を投入しない運用)。

### A3. wrangler secret list で投入完了を確認

```bash
pnpm wrangler secret list --env=production
# → 上記 7-9 件 (任意 secret 含む) が並んでいることを確認
```

## [B] Deploy + 疎通確認

### B1. Deploy

```bash
pnpm deploy:production
# = wrangler d1 migrations apply webull-trading-production --env=production --remote
#   && wrangler deploy --env=production
```

deploy 出力で次を確認:

- worker name: `webull-trading-production`
- D1 binding: `webull-trading-production` (DB)
- DO bindings: `SYMBOL_STATE` / `PORTFOLIO_STATE` / `WEBULL_TOKEN_STATE` の 3 つ
- cron triggers: `*/5` / `*/15` / `0 22` (= staging と同じ)
- custom domain: `trading.chanu.co`

### B2. CF Access 認証で dashboard を開けるか確認

browser で `https://trading.chanu.co/dashboard` を開く。Cloudflare Access の login flow を経て dashboard top が表示される事を確認。

### B3. Token を発行 + DO に seed

```bash
# 手元 CLI で token 発行
op run -- pnpm run issue-token
# → PENDING token 表示後、Webull モバイルアプリで 5 分以内に 2FA SMS verify
# → status NORMAL に遷移、stdout に長い英数字 token が 1 行で出力
```

取得した token を browser から DO に seed:

1. `https://trading.chanu.co/dashboard/webull-token` を開く
2. 「📋 何を貼ればいい?」を展開して例示を確認
3. terminal 出力丸ごとを form に貼り付け → 「seed」ボタン
4. ページ更新後の「現在の状態」に `status: NORMAL`, `tokenHint: xxx...yyy`, `expires: ...` が出れば完了

### B4. probe で疎通確認

`https://trading.chanu.co/admin/broker/probe?symbol=AAPL&category=US_STOCK` を browser で開く。期待される結果:

```json
{
  "sandbox": {
    "trade": "https://api.webull.co.jp",
    "quotes": "https://data-api.webull.co.jp"
  },
  "accessToken": {
    "source": "do_normal",
    "length": 32,
    "doStatus": "NORMAL"
  },
  "appKey": { "length": 32, "head": "1f2484" },  // 手元 1Password と一致確認
  "quote": { ... 10s timeout の可能性 (Webull JP market-data 未公開のため) },
  "quoteYahoo": { "phase": "response", "status": 200, ... },
  "positions":      { "phase": "response", "status": 200, "bodyTruncated": "[...]" },
  "positionsNew":   { "phase": "response", "status": 200, ... },
  "orderHistoryOld":{ "phase": "response", "status": 200, "bodyTruncated": "[]" },
  "orderHistoryNew":{ "phase": "response", "status": 200, "bodyTruncated": "[]" }
}
```

- positions / orders 全部 200 → **production live 疎通 OK**
- `quoteYahoo` 200 → Yahoo Finance fallback も動作中
- `quote` (= Webull data-api) は timeout のままで OK (本番 market-data 未公開、Yahoo で代替中)

## [C] Paper trading 観察期

### C1. D1 `global_config` の確認

`https://trading.chanu.co/dashboard/config` を開いて:

| field | 期待値 |
|---|---|
| `dryRun` | **`true`** (default、まだ仮想取引) |
| `tradingEnabled` | `false` (D1) / env=`false` で強制 OFF |
| `marketHoursCheck` | `true` (本番市場時間外で発注しない) |
| `maxOrderNotionalUsd` / `maxOrderNotionalJpy` | 妥当な値 |

### C2. 銘柄 universe を設定

`https://trading.chanu.co/dashboard/symbols` で対象銘柄を active 化。Pullback 戦略適合候補:

- US: AAPL / SOXL / SPY / QQQ 等の流動性高い ETF / 大型株
- JP: 7203 / 6758 等の主要株 (Yahoo で `.T` suffix 自動付与で取得可)

### C3. cron が回ってる事を確認

5min / 15min cron が稼働してれば自動で:

- 5min: quote feed (Yahoo) + reconcile fills
- 15min: strategy 評価 (Pullback)
- 22:00 UTC: portfolio roll + token refresh + Webull market-data 監視

`https://trading.chanu.co/dashboard/cron` で直近 strategy 判定 log を確認。各 active 銘柄について `HOLD / BUY / SELL` の decision + reason が並ぶ事を確認。

### C4. 数日観察

- `dryRun=true` 状態で 3-7 日程度 paper trading
- BUY シグナル発生 → simulated 保有が増える → quote 更新で simulated PnL 動く流れを確認
- `/dashboard/portfolio` で累積 PnL を観察
- 通知 (Slack/Discord) が想定通り飛ぶか確認

## [D] Live 有効化

paper trading で問題なければ、以下 3 step で live trade を有効化:

### D1. D1 `global_config.dryRun` を `false` に

`/dashboard/config` から toggle (audit log に記録される)。この時点ではまだ env override が効いて発注されない (= safety net)。

### D2. D1 `global_config.trading_enabled` を `true` に

同 page から toggle。env override で依然強制 OFF なので発注しない (= 2 重 safety net 維持)。

### D3. env `TRADING_ENABLED` を削除

```bash
pnpm wrangler secret delete TRADING_ENABLED --env=production
# → env override が消える、D1 の値 (= true) を尊重 = **live trade 有効化**
```

これで:
- WebullTradeClient の ENVIRONMENT='production' gate → 通過 (= live order を broker に投げる)
- 全 safety net 解除完了

直後の strategy cron (15min 周期) で BUY/SELL シグナル発生時に **本番口座で実発注** が走る。最初は universe を狭く (1-2 銘柄)、`MAX_ORDER_NOTIONAL` を低く絞って動作確認するのが安全。

## ロールバック

問題発生時は以下のいずれかで即時止めて、原因調査後に再開:

| 操作 | 効果 | 反映速度 |
|---|---|---|
| `/dashboard/config` で `dryRun=true` toggle | 次の cron tick から MockExecution、broker 発注しない | 即時 (deploy 不要) |
| `pnpm wrangler secret put TRADING_ENABLED --env=production` 値 `false` | 環境 override で強制 OFF (D1 が true でも止まる) | 数秒 (secret 反映) |
| `/dashboard/cron` で「取引停止」ボタン | killswitch を D1 に立てる、stop reason 必須 | 即時 |
| `/dashboard/webull-token` で DO token を削除 (= revoke) | broker が token 拒否 → 全 endpoint 401 (= 全停止) | 即時 |

## 関連 doc

- [docs/env-separation.md](env-separation.md): env 分離の元設計
- [docs/db-operations.md](db-operations.md): D1 操作リファレンス
- memory `webull-token-flow.md`: token 取得 / 投入 / 自動 refresh の運用
- memory `webull-invalid-token-account-id.md`: 401 INVALID_TOKEN の hint
- memory `staging-paper-trading-ready.md`: paper trading の動作確認手順
