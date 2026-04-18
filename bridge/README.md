# Bridge

Node bridge process for Webull trade-event gRPC streaming. It keeps a persistent server-streaming subscription open against Webull and forwards normalized trade events to the Worker ingest route.

Runs as a **Cloudflare Container** attached to the `webull-trading` Worker (class `BridgeContainer`). Single instance (`max_instances: 1`), started on demand by the Worker's cron handler (`*/5 * * * *` → `keepBridgeAlive(env)`).

## Environment

### Secrets (`wrangler secret put`)

- `WEBULL_APP_KEY` (required)
- `WEBULL_APP_SECRET` (required)
- `WEBULL_ACCOUNT_ID` (required)
- `WEBULL_GRPC_ENDPOINT` (required) — Webull gRPC 疎通先 host:port。`keepBridgeAlive` は未設定だと skip するので必ず投入する。値は 1Password / Webull vendor 資料を参照
- `EVENT_INGEST_URL` (required) — Worker `/events/trade` の完全 URL。deploy 先 subdomain に合わせる
- `EVENT_INGEST_SECRET` (required)

### Plain vars (`wrangler.jsonc` の `vars`)

- `BRIDGE_RUN_MODE` — `auto` (default, 平日 JST のみ起動) / `always-on` / `disabled`。秘匿情報ではないので source-controlled。

Secrets flow Worker `env` (投入は `wrangler secret put`) → `container.start({ envVars })` → container process env。image には焼き込まない。

## Local run

`bridge/` ディレクトリで (Cloudflare Container でなく素の Node で動かす):

```bash
pnpm install
pnpm start
```

TLS for the Webull endpoint is on by default; reconnects indefinitely with exponential backoff if the stream ends or errors.

## Deploy (Cloudflare Container 経由)

### 前提

- Docker Desktop (or Colima) が起動していること — `wrangler deploy` が build / push に Docker CLI を呼ぶ
- Workers Paid plan (Containers は Free tier 非対応)

### Secrets 投入 (staging)

```bash
for key in WEBULL_APP_KEY WEBULL_APP_SECRET WEBULL_ACCOUNT_ID \
           WEBULL_GRPC_ENDPOINT EVENT_INGEST_URL EVENT_INGEST_SECRET; do
  echo "enter $key:"
  pnpm wrangler secret put "$key" --env=staging
done
```

もしくは 1Password + stdin:

```bash
op read op://Personal/<item>/WEBULL_APP_KEY \
  | pnpm wrangler secret put WEBULL_APP_KEY --env=staging
# ...同じく他の key
```

### Deploy

```bash
pnpm wrangler deploy --env=staging
```

`wrangler.jsonc` の `containers[0].image = "./bridge/Dockerfile"` により、build context が repo root 扱いで Docker image が build → Cloudflare Registry に push → `BridgeContainer` DO class にアタッチされる。

### 動作確認

```bash
pnpm wrangler tail --env=staging --format=pretty
```

次 cron (`*/5 * * * *`) で以下が順に出れば成功:

1. `{"event":"bridge_keep_alive_ok"}` — Worker が container start を指示
2. `{"event":"bridge_container_started"}` — Container が立ち上がった
3. bridge (`grpc/index.ts`) の `console.log` — gRPC subscribe 確立
4. 実発注 → bridge が fill event を POST → Worker `/events/trade` 200 応答

## 選定理由

- **Cloudflare Containers**: ログが Workers Logs に集約、Workers と 1 dashboard で完結
- **Fly.io / Cloud Run 不採用**: ログ管理が分散する
- 注意: Cloudflare Containers (β) は host restart がたまに発生する (日次レベル) 前提。Bridge 側の reconnect loop + Worker cron keep-alive でカバー
