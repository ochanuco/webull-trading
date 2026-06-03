# Env 分離運用 (#277)

dev / staging / production を worker / D1 / DO namespace / secrets で物理的に分離する。本番口座接続前の prod 誤爆 (`webull-trading` 単一 worker に dev も staging も live key も同居) を防ぐ。

## 4 つの実行プロファイル

| Profile | 起動 | Worker name | URL | D1 | cron | 用途 |
|---|---|---|---|---|---|---|
| local | `pnpm dev` (= `wrangler dev`) | top-level (`webull-trading`) | `localhost:8787` | miniflare local SQLite | なし | 開発機での反復実行 |
| dev | `pnpm deploy:dev` | `webull-trading-dev` | `webull-trading-dev.*.workers.dev` | `webull-trading-dev` (要発行) | なし (manual) | remote dev / preview |
| staging | `pnpm deploy:staging` | `webull-trading-staging` | `trading-staging.chanu.co` | `webull-trading-staging` | なし (manual) | sandbox key で integration 検証 |
| production | `pnpm deploy:production` | `webull-trading-production` | `trading.chanu.co` | `webull-trading-production` (要発行) | あり (5/15min/22:00 UTC) | 実マネー |

`wrangler dev` (ローカル) はあえて env を切り替えずに top-level config を使う。cron / D1 ID 設定エラーの影響を受けず手元で立ち上がる事を優先するため。

## env 切替

```bash
# remote dev へ deploy
pnpm deploy:dev

# staging
pnpm deploy:staging

# production
pnpm deploy:production
```

scripts は `wrangler d1 migrations apply --env=<env> --remote` → `wrangler deploy --env=<env>` の 2 段。migration 失敗時は deploy 走らない。
`pnpm deploy` は unqualified top-level deploy 事故を避けるため default では失敗する。
意図して top-level worker を deploy する場合だけ `ALLOW_UNQUALIFIED_DEPLOY=1 pnpm deploy` を使う。
本番の通常 CD は `production` branch への release PR merge を Cloudflare Workers Builds が検知する方式。詳細は [production-cd.md](production-cd.md)。

## ユーザー側の初期作業 (実マネー前)

`wrangler.jsonc` 内の `REPLACE_WITH_DEV_ID` / `REPLACE_WITH_PRODUCTION_ID` は placeholder。実発行は手作業。

### 1. D1 を env ごとに発行

```bash
pnpm wrangler d1 create webull-trading-dev
# => 出力された database_id を wrangler.jsonc env.dev.d1_databases[0].database_id に貼る

pnpm wrangler d1 create webull-trading-production
# => 出力された database_id を wrangler.jsonc env.production.d1_databases[0].database_id に貼る
```

staging の D1 (`cbc199f0-…`) は既に発行済み。

### 2. Migration を流す

```bash
pnpm wrangler d1 migrations apply webull-trading-dev --env=dev --remote
pnpm wrangler d1 migrations apply webull-trading-production --env=production --remote
```

### 3. Secret を env ごとに投入

`wrangler secret put <KEY> --env=<dev|staging|production>` で投入する。`.dev.vars.example` 末尾に key 一覧と例コマンドがある。

最小必須:

- `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` (#29 Access auth)
- `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_ACCOUNT_ID`

`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` / `EVENT_INGEST_SECRET` は #29 で
廃止。既存 deploy は `wrangler secret delete <key> --env=<env>` で除去する。
deployed env では `ACCESS_DEV_BYPASS_USER` を絶対に投入しない (middleware は
`CF_ACCESS_TEAM_DOMAIN` が立っていれば bypass を honor しないが、二重防御で
secret 自体を投入しない運用にする)。

**production の Webull credentials は staging/dev と別物にする**。staging は JP UAT key (`jp-openapi-alb.uat.webullbroker.com` — ALB が trade/quotes/events を 1 ホストに束ねてる)、production は JP live key で 3 API が分離されている (下表)。

host 系 env var は **未設定なら JP prod default に fallback** する (値は SDK の公開 region 定義に書かれており隠す価値なし)。staging / UAT は 3 var とも ALB URL に override 必要、production は env 投入不要 (default が prod を指す)。

| API | 本番 host (= default 値) | 環境変数 (override 用) |
|---|---|---|
| trade (account / assets / orders) | `api.webull.co.jp` | `WEBULL_TRADE_API_BASE` |
| quotes (snapshot / bars) | `data-api.webull.co.jp` | `WEBULL_QUOTES_API_BASE` |
| events (consumer 未実装、SDK 定義のみ) | `events-api.webull.co.jp` | `WEBULL_EVENTS_API_BASE` |

### `x-access-token` (#21、2FA supplemental auth)

signature とは直交する 2FA-backed token。`WEBULL_ACCESS_TOKEN` env var に値を入れると各 client が `x-access-token` ヘッダを request に付与する。

- **取得**: operator が Webull 公式ツールで token 発行 → モバイルアプリで 2FA SMS verify (5 min 以内) → status `NORMAL` 化した token 文字列を `wrangler secret put WEBULL_ACCESS_TOKEN --env=<env>` で投入
- **テスト環境**: 2FA 不要で auto-`NORMAL`、staging では未設定でも動く可能性あり
- **production**: 設定漏れだと 401 で発覚する設計 (fail-closed throw ではない、broker error で気付く)
- **inactivity 15 日**: API call が 15 日途絶えると `INVALID` 化、再 verify 必要 → 期限切れ監視 / 自動再発行は別 issue (#21 follow-up) で扱う

### 4. DO namespace

`durable_objects.bindings` は `class_name` ベース。env ごとに worker name が違うので Cloudflare が自動的に別 namespace を割り当てる (`namespace_id` 手動指定不要)。データ移行 / 共有が必要になったら明示的に `script_name` を切る事を検討する (現状不要)。

## Secret rotation

```bash
# 既存 secret を上書き
pnpm wrangler secret put WEBULL_APP_SECRET --env=production

# 削除
pnpm wrangler secret delete WEBULL_APP_SECRET --env=production
```

rotation 後は対応する env を再 deploy せず即時反映される (Cloudflare 側で worker に re-bind される)。ただし production rotation 時は `pnpm wrangler deploy --env=production --dry-run` で binding 一覧が崩れていない事を確認する (`pnpm deploy:production` は先頭で `wrangler d1 migrations apply --remote` を実行するので dry-run 確認には使えない)。

## Cron triggers (重要な非自明仕様)

wrangler 4 は `env.*` block が存在すると **top-level の `triggers` を継承しない**。`wrangler.jsonc` top-level の `triggers.crons` は `wrangler deploy` (`--env=""`) でしか発火しない。各 env に出したい場合はその env block 内に `triggers` を再宣言する。

issue #277 の仕様 (cron は prod のみ) に従い、本リポジトリでは:

- `env.production.triggers.crons` のみ宣言 (5min / 15min / 22:00 UTC)
- `env.dev` / `env.staging` には `triggers` を置かない (= manual run)
- top-level `triggers` は `wrangler dev` (ローカル) でのみ評価される

staging で cron を試したい場合は `env.staging` に `triggers` を一時的に足してから revert する。

## 確認コマンド

```bash
pnpm exec wrangler deploy --env=dev        --dry-run
pnpm exec wrangler deploy --env=staging    --dry-run
pnpm exec wrangler deploy --env=production --dry-run
pnpm verify:production-d1
```

dry-run 出力に出る binding 一覧 (D1 name / DO class) と cron 一覧を見て、env ごとに分離されている事を確認する。`REPLACE_WITH_*` のまま deploy しようとすると `wrangler d1 migrations apply` が先に失敗する設計。

## 既知の制約 (Out of scope)

- CI/CD auto deploy: #24 で扱う
- Secret rotation 自動化 (1Password Connect / Vault 連携): out of scope
- Per-env DRY_RUN / TRADING_ENABLED の デフォルト切替: `wrangler.jsonc` vars には現状未配置 (top-level `vars` 既定で fail-closed `DRY_RUN=true`)、必要時に `env.<env>.vars` に append する
