# Bridge

Node bridge process for Webull trade-event gRPC streaming. It keeps a persistent server-streaming subscription open against Webull and forwards normalized trade events to the Worker ingest route.

## Environment

`.env.example` をコピーして設定:

- `WEBULL_APP_KEY`
- `WEBULL_APP_SECRET`
- `WEBULL_ACCOUNT_ID`
- `WEBULL_GRPC_ENDPOINT` default sandbox target is `events-api.sandbox.webull.hk:443`
- `EVENT_INGEST_URL` full Worker ingest URL such as `https://<staging-worker>/events/trade`
- `EVENT_INGEST_SECRET`

## Local run

`bridge/` ディレクトリで:

```bash
pnpm install
pnpm start
```

TLS for the Webull endpoint is on by default; the bridge reconnects indefinitely with exponential backoff if the stream ends or errors.

## Deploy to Fly.io

POC では Fly.io を常駐先に選定 (長寿命 gRPC stream 向け、free allowance 内で運用可能)。`fly.toml` は **リポジトリルート** に置いてある。Dockerfile が `src/` を参照するため build context もルートから。

### 初回セットアップ

```bash
fly auth login                       # 1Password 等から
fly launch --config fly.toml --no-deploy --copy-config
# 既存 fly.toml を利用して app 作成。app 名は fly.toml の `app` を編集 or --name で指定
```

### Secrets 投入 (repo に残さない)

```bash
fly secrets set \
  --config fly.toml \
  WEBULL_APP_KEY="$(op read op://Personal/.../WEBULL_APP_KEY)" \
  WEBULL_APP_SECRET="$(op read op://Personal/.../WEBULL_APP_SECRET)" \
  WEBULL_ACCOUNT_ID="$(op read op://Personal/.../WEBULL_ACCOUNT_ID)" \
  WEBULL_GRPC_ENDPOINT="events-api.sandbox.webull.hk:443" \
  EVENT_INGEST_URL="https://webull-trading-staging.teacatus.workers.dev/events/trade" \
  EVENT_INGEST_SECRET="$(op read op://Personal/.../EVENT_INGEST_SECRET)"
```

### デプロイ

```bash
fly deploy --config fly.toml
```

### ログ監視

```bash
fly logs --config fly.toml
```

### Production

`app` を `webull-trading-bridge-production` に差し替えて同じ手順。

## Why Fly (not Cloudflare Containers / Cloud Run)

- Cloudflare Containers (β): runtime 仕様が流動的、長寿命 stream は時間制限要確認
- Cloud Run: gRPC ストリーミング OK だが常駐 billing が pay-as-you-go で割高、1-CPU 上限制約あり
- Fly.io: 常駐 + gRPC 外向け + NRT region 即配置 + free allowance 内で POC 完結

将来ブリッジ設計が変わって short-lived になれば Cloudflare Workers + Durable Object Alarms に戻す余地あり (現状は gRPC subscribe + reconnect の性質上 Node 常駐が簡潔)。
