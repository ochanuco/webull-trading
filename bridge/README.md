# Bridge

Node bridge process for Webull trade-event gRPC streaming. It keeps a persistent server-streaming subscription open against Webull and forwards normalized trade events to the Worker ingest route.

## Environment

Copy [`.env.example`](/Users/chanu/ghq/github.com/ochanuco/worktrees/dev-grpc-bridge-client/bridge/.env.example) and set:

- `WEBULL_APP_KEY`
- `WEBULL_APP_SECRET`
- `WEBULL_ACCOUNT_ID`
- `WEBULL_GRPC_ENDPOINT` default sandbox target is `events-api.sandbox.webull.hk:443`
- `EVENT_INGEST_URL` full Worker ingest URL such as `https://<staging-worker>/events/trade`
- `EVENT_INGEST_SECRET`

## Run

From [`bridge/`](/Users/chanu/ghq/github.com/ochanuco/worktrees/dev-grpc-bridge-client/bridge):

```bash
pnpm install
pnpm start
```

The bridge uses TLS by default for the Webull endpoint and reconnects indefinitely with exponential backoff if the stream ends or errors.
