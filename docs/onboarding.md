# オンボーディング

このリポジトリで開発を始めるまでの手順。設計の全体像は [`architecture.md`](architecture.md)、運用パラメタは [`configuration.md`](configuration.md)。

## 前提

- pnpm 11+ / Node 24 / TypeScript strict (`moduleResolution: Bundler`)
- **実マネーが流れる前提**で書く。安全既定は fail-closed (`dry_run=1` / `trading_enabled=0`)
- ブランチは `dev/<topic>`。`main` 直接編集は禁止。merge 方式は ruleset で強制済み (`main`=merge commit / `production`=squash)

## ローカル開発

```bash
pnpm install
pnpm run typecheck                # tsc --noEmit
pnpm test                         # vitest
pnpm dev                          # wrangler dev (ローカル D1 自動作成)
pnpm exec wrangler deploy --dry-run
```

`.dev.vars.example` を `.dev.vars` にコピーし、1Password 参照 (`op://...`) を埋める。`op run --env-file=.dev.vars -- <cmd>` で解決される。key の一覧と用途は `.dev.vars.example` のコメントを参照。

ローカルは `ENVIRONMENT` が production 以外なので `WebullTradeClient.placeOrder` が throw する。実発注は production からしか出ない。

## D1 セットアップ

初回のみ。手順と運用 SQL は [`db-operations.md`](db-operations.md) に集約している。

```bash
pnpm wrangler d1 create webull-trading-staging     # → database_id を wrangler.jsonc に貼る
pnpm wrangler d1 migrations apply webull-trading-staging --env=staging --remote
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/symbol_config.sql
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/global_config.sql
```

## Secrets

運用可変値は D1 に逃がしてあるので、secret に残るのは **認証情報と非公開 URL のみ**。

| Secret | 用途 |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | Cloudflare Access JWT 検証 (#29)。旧 `BASIC_AUTH_*` は廃止 |
| `CF_ACCESS_MCP_AUD` | `/mcp` 専用 Access application の AUD (#553)。未設定なら `CF_ACCESS_AUD` に fallback |
| `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_ACCOUNT_ID_JP_CASH` | broker 署名・口座 (JP_CASH 単一口座、#109) |
| `WEBULL_TRADE_API_BASE` | trade API host override (#21)。未設定なら JP prod default (`https://api.webull.co.jp`) |
| `WEBULL_QUOTES_API_BASE` | quotes API host override。未設定なら `https://data-api.webull.co.jp` |
| `WEBULL_EVENTS_API_BASE` | events API host override (consumer 未実装)。未設定なら `https://events-api.webull.co.jp` |
| `WEBULL_ACCESS_TOKEN` | `x-access-token` の bootstrap fallback。通常運用では DO seed 後に自動 refresh される |
| `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` | 通知先 webhook (#199)。未設定ならその channel は無効 |
| `DASHBOARD_BASE_URL` | 通知に添える dashboard link の base URL |

```bash
pnpm wrangler secret put CF_ACCESS_AUD --env=staging
# ... 1 件ずつ。誤 env 防止のため loop 化しない
pnpm wrangler secret list --env=staging
```

env ごとの分離方針は [`env-separation.md`](env-separation.md)。

## Webull 口座まわりの初期作業

### account_id を取得する

dashboard から確認できないので、app_key + app_secret で API を叩いて取得する。host は未設定なら JP prod default (`api.webull.co.jp`)。

```bash
WEBULL_APP_KEY="$(op read 'op://Personal/WEBULL_APP_KEY/credential')" \
WEBULL_APP_SECRET="$(op read 'op://Personal/WEBULL_APP_SECRET/credential')" \
  pnpm run accounts

# UAT で叩く場合は ALB URL を override
WEBULL_APP_KEY=... WEBULL_APP_SECRET=... \
WEBULL_TRADE_API_BASE=https://jp-openapi-alb.uat.webullbroker.com \
  pnpm run accounts
```

### `x-access-token` を発行する (#21)

JP 本番では signature に加えて 2FA-backed の `x-access-token` が必須。`pnpm run issue-token` が PENDING token を発行し、モバイルアプリでの 2FA verify 完了を poll で待ち、NORMAL になった token を stdout に出す。

```bash
# 1. script を起動
WEBULL_APP_KEY="$(op read 'op://Personal/WEBULL_APP_KEY/credential')" \
WEBULL_APP_SECRET="$(op read 'op://Personal/WEBULL_APP_SECRET/credential')" \
  pnpm run issue-token

# 2. 表示された PENDING token を確認し、Webull モバイルアプリで 5 分以内に 2FA SMS verify
#    (script は 30 秒毎に check_token を poll する)

# 3. status=NORMAL になると token 文字列が stdout に出る

# refresh (既存 token を引き継ぐ場合)
WEBULL_APP_KEY=... WEBULL_APP_SECRET=... WEBULL_EXISTING_TOKEN=<old token> \
  pnpm run issue-token
```

取得した token は `POST /admin/webull-token/seed` (または `/dashboard/webull-token` 画面) で `WEBULL_TOKEN_STATE` DO に投入する。以降は `0 22 * * *` cron が expires 残り 7 days を切ると自動 refresh し、失敗時は critical 通知が飛ぶ。15 days inactivity で `INVALID` 化する。

## デプロイの流れ

deploy は Cloudflare Workers Builds の CD 任せで、手動 `wrangler deploy` は通常不要 (migration も CD に含まれる)。

| Branch | deploy 先 | build command |
|---|---|---|
| `main` | staging | `pnpm deploy:staging` |
| `production` | production | `pnpm deploy:production` |

リリースは release-please が切り、その GitHub Release を起点に production 昇格 PR が作られる。詳細は [`production-cd.md`](production-cd.md)、初回の本番投入手順は [`production-deployment.md`](production-deployment.md)。

## 迷ったら

- 安全側に倒す (実発注しない / エラーを返す / ログだけ残す)
- Risk チェックを迂回する "便利" helper は作らない
- POC scope 外の議論は別 issue に切り出す
