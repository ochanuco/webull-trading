# webull-trading

Retail auto-trading **POC** on Cloudflare Workers + Hono + TypeScript, speaking Webull OpenAPI directly (no SDK). Trade-event streaming via a Node-runtime gRPC bridge hosted in a Cloudflare Container.

**Status**: POC Phase 1–5 完了 (#1 closed)。以降は follow-up issues (#21-#24) と D1 化 (#68-#70) が merged。

## アーキテクチャ概要

```
 ┌──────────────┐  */5 cron       ┌──────────────────────────┐
 │  Cloudflare  │────────────────▶│  quote feed (DO write)    │
 │   Workers    │                 │  bridge keep-alive        │
 │              │  /trade/* HTTP  └──────────────────────────┘
 │              │────▶ decide / execute → Webull HTTP
 │              │  /events/trade  ◀────── bridge Container
 │              │  /admin/*       operator (Basic Auth)
 └──────┬───────┘
        │
 ┌──────┴────────────────────────────────────────────────────┐
 │              Durable Objects  +  D1                         │
 │  SYMBOL_STATE (per-symbol: position / pending / cooldown)   │
 │  PORTFOLIO_STATE (daily equity / drawdown kill)             │
 │  BRIDGE (Container lifecycle)                               │
 │  DB: trade_journal / symbol_config / inverse_pairs /        │
 │      global_config                                          │
 └─────────────────────────────────────────────────────────────┘
```

## Safety defaults (fail-closed)

`global_config` singleton (D1 `id='default'`) で保持。未シード時は `GLOBAL_CONFIG_DEFAULTS` にフォールバック:

| フィールド | 既定 | 意味 |
|---|---|---|
| `dry_run` | `1` | Execution Mock に固定、broker へ送らない |
| `trading_enabled` | `0` | Risk layer が全注文 reject |
| `market_hours_check` | `0` | UTC 13:30-20:00 Mon-Fri チェック |
| `max_order_notional` | `100` | 1 注文上限 ($ / ¥) |
| `drawdown_kill_threshold` | `-0.02` | 日次 realized_pnl / start_equity 比で自動 kill |
| `stale_quote_ms` | `900000` | halt 判定 (15 min) |
| `spread_limit_pct_{us,jp}` | `0.0025` / `0.006` | spread guard |
| `bridge_run_mode` | `auto` | 平日 JST のみ bridge 稼働 (auto / always-on / disabled) |

加えて:
- `symbol_config.active = 0` にすれば ALLOWED から外れて cron から除外
- `inverse_pairs` で SOXL/SOXS 同時保有を構造的に禁止
- Basic Auth で `/trade/*` / `/webull/*` / `/admin/*` 保護
- `EVENT_INGEST_SECRET` header + timing-safe 比較で `/events/trade` 保護

## Layout

```
src/
  app.ts / index.ts           Hono factory + Workers entry (fetch / scheduled)
  routes/                     health / trade / webull / events / admin
  trading/
    application/              TradingService / TradeEventService
    domain/                   Signal / OrderIntent / RiskDecision / ExecutionResult / TradeEvent
    strategy/                 Strategy + FixedRuleStrategy + PullbackUptrendStrategy + pullbackSizing / indicators / scheduler
    risk/                     RiskPolicy + DefaultRiskPolicy + jpPriceBand + spreadGuard
    execution/                Execution + MockExecution + WebullExecution
    events/                   TradeEventHandler
    state/                    SymbolStateDO / PortfolioStateDO + clients / transitions
    bridge/                   BridgeContainer (Cloudflare Container DO class) + keepAlive + schedule
    quotes/                   quoteScheduler
  infrastructure/
    webull/                   WebullHttpClient / WebullAuth / mapper / TradeEventBridge
    quotes/                   WebullQuoteClient / BarClient
    logger/                   AuditLogger + tradeJournal (console + D1 sink)
    db/                       drizzle schema + tradeJournalRepo / symbolConfigRepo / globalConfigRepo + loaders
  middleware/                 basicAuth
  shared/                     errors
  config/                     env (少数: secret 参照のみ)
Dockerfile                    bridge Container image (repo root context)
bridge/                       Node gRPC subscriber (pnpm start)
drizzle/                      generated D1 migrations (0000_init / 0001_symbol_config / 0002_global_config)
docs/                         db-operations.md / seed/*.sql
test/                         vitest suite (275 cases)
```

## Dev

```bash
pnpm install
pnpm run typecheck                # tsc --noEmit
pnpm test                         # vitest (Worker + bridge)
pnpm dev                          # wrangler dev (ローカル D1 自動作成)
pnpm exec wrangler deploy --dry-run

# bridge 単体 typecheck
cd bridge && pnpm install && pnpm run typecheck
```

`.dev.vars.template` を `.dev.vars` にコピーして 1Password `op inject` で値埋め。

## Endpoints

| method | path | auth | 概要 |
|---|---|---|---|
| GET | `/health` | none | `{status, timestamp}` |
| POST | `/trade/decide` | Basic | Signal + OrderIntent + RiskDecision を返す (発注しない) |
| POST | `/trade/execute` | Basic | 上記 + ExecutionResult (`dry_run=1` で Mock、0 で Webull) |
| POST | `/webull/order/place` | Basic | 低レベル疎通 endpoint (`dry_run=1` で synthetic response) |
| POST | `/events/trade` | secret header | bridge からの trade event ingest |
| POST | `/admin/symbols/:symbol/seed-cash` | Basic | `settled_cash` の初期値投入 (#55) |
| POST | `/admin/portfolio/seed-equity` | Basic | `daily_start_equity` 投入 (#50) |

Cron: `*/5 * * * *` で quote feed + bridge keep-alive。

## Bindings (wrangler.jsonc)

| 種別 | 名前 | 説明 |
|---|---|---|
| Durable Object | `SYMBOL_STATE` | 銘柄ごとの position / pending / cooldown |
| Durable Object | `PORTFOLIO_STATE` | 日次 equity / drawdown kill |
| Durable Object | `BRIDGE` | Cloudflare Container (Node gRPC bridge) のライフサイクル |
| Container | `BridgeContainer` | `./Dockerfile` から build、`max_instances: 1` |
| D1 Database | `DB` | trade_journal / symbol_config / inverse_pairs / global_config |

## Secrets (`wrangler secret put`)

運用可変値は D1 に逃げたので、ここに残るのは **認証情報と非公開 URL のみ**:

| Secret | 用途 |
|---|---|
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | `/trade/*` / `/webull/*` / `/admin/*` 認証 |
| `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_ACCOUNT_ID` | broker 署名・口座 |
| `WEBULL_API_BASE` | sandbox host (非公開) |
| `WEBULL_GRPC_ENDPOINT` | bridge の gRPC 接続先 (非公開) |
| `EVENT_INGEST_URL` | bridge 側から叩く Worker URL (`https://.../events/trade`) |
| `EVENT_INGEST_SECRET` | `/events/trade` header |

```bash
pnpm wrangler secret put BASIC_AUTH_USER --env=staging
# ... 1 件ずつ、誤 env 防止のため loop 化しない
pnpm wrangler secret list --env=staging   # 9 件揃ったか確認
```

### Webull account_id を取得する

Webull sandbox は dashboard で account_id を見られないので、app_key + app_secret だけで API を叩いて取得する:

```bash
WEBULL_APP_KEY="$(op read 'op://Personal/WEBULL_APP_KEY/credential')" \
WEBULL_APP_SECRET="$(op read 'op://Personal/WEBULL_APP_SECRET/credential')" \
WEBULL_API_BASE=https://api.sandbox.webull.hk \
  pnpm run accounts
```

## D1 セットアップ (初回のみ)

staging:

```bash
# 1. DB 作成 → 出力される database_id を wrangler.jsonc に貼る
pnpm wrangler d1 create webull-trading-staging

# 2. migration 適用
pnpm wrangler d1 migrations apply webull-trading-staging --env=staging --remote

# 3. 初期シード
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/symbol_config.sql
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote --file=docs/seed/global_config.sql
```

schema 変更・運用 SQL レシピは [`docs/db-operations.md`](docs/db-operations.md) に集約。

## Deploy

CD (Cloudflare Workers Builds) が main push で `pnpm run deploy:staging` を実行:

```
wrangler d1 migrations apply webull-trading-staging --env=staging --remote
  && wrangler deploy --env=staging
```

手動 deploy:

```bash
pnpm run deploy:staging
pnpm run deploy:production
```

`pnpm run deploy:*` が migration → deploy を `&&` で繋ぐので、migration 失敗時は worker がデプロイされない (壊れた schema に新 code が当たる事故を防ぐ)。

### bridge Container (Cloudflare Containers β)

`wrangler deploy` が Dockerfile を build → Cloudflare Registry push → `BridgeContainer` DO に配置する。前提:

- Workers **Paid** plan ($5/月) — Containers は Free tier 非対応
- ローカル build に Docker CLI 互換環境 (Colima 推奨)
- bridge-specific env (`WEBULL_GRPC_ENDPOINT` / `EVENT_INGEST_URL`) を secret に投入済

詳細は [`bridge/README.md`](bridge/README.md) 参照。

## 運用 (wrangler d1 execute で D1 直編集)

admin API は作らず、wrangler CLI から直接 SQL を叩く運用:

```bash
# 新 symbol 追加
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "INSERT INTO symbol_config (symbol, name, market, active, max_notional, updated_at) \
             VALUES ('GLD', 'SPDR Gold Shares', 'US', 1, 5000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"

# 実発注 ON
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "UPDATE global_config SET dry_run = 0, trading_enabled = 1, \
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'default'"

# 緊急 kill-switch
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "UPDATE global_config SET trading_enabled = 0 WHERE id = 'default'"

# 振り返りクエリ
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "SELECT trade_event_type, COUNT(*) FROM trade_journal GROUP BY trade_event_type"
```

より多くのレシピは [`docs/db-operations.md`](docs/db-operations.md) 参照。

## AI エージェント / レビュー設定

- `CLAUDE.md` — Claude 用エントリ (skill / agent index)
- `AGENTS.md` — Codex 用エントリ
- `.claude/skills/trading-developer/` — 取引コードの safety invariants auto-activate
- `.claude/skills/phase-scope/` — Phase 境界の scope 判定
- `.claude/skills/coderabbit-policy/` — CodeRabbit findings の採用 / 却下基準
- `.claude/agents/trading-strategist.md` — 戦略設計 delegate 用 subagent
- `.coderabbit.yaml` — 自動レビュー設定 (profile: chill + path_instructions)

## 設計書 / POC 履歴

- [#1](https://github.com/ochanuco/webull-trading/issues/1) POC 設計書 (closed)
- Phase 1: PR #2 / Phase 2: PR #3 / Phase 3: PR #4 / Phase 4: PR #5 / Phase 5: PR #6
- D1 化: #68 / #69 / #70
- Bridge (Cloudflare Containers): #33 / PR #65
- Risk hardening: #38 サブ PR 47/59/60/61
