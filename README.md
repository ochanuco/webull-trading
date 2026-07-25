# webull-trading

Retail auto-trading system on Cloudflare Workers + Hono + TypeScript, speaking Webull OpenAPI directly (no SDK).

**Current scope**: POC (issue #1、Phase 1–5) は完了。production で Pullback / BreakoutMomentum 戦略が 15 分 cron で実発注稼働中 (Webull JP 本番口座)。US + JP 両通貨対応 (JP は `symbol_config.lot_size` で丸め)。Risk: kill-switch / drawdown kill / ATR stop / drawdown-scaled size / VIX regime filter / earnings・macro event gate / spread guard / ticker deny guard。Cloudflare Access で保護した read-only dashboard + read-only MCP server 有り。

## アーキテクチャ概要

```
 ┌──────────────┐  */5  * * * *   ┌────────────────────────────────────┐
 │  Cloudflare  │────────────────▶│ quote feed + reconcileFills         │
 │   Workers    │  */15 * * * * ─▶│ strategy cron (Pullback / Breakout) │
 │              │  0 22  * * * ──▶│ portfolio roll + token refresh +    │
 │              │                 │ market data health + allowlist 更新  │
 │              │                 └────────────────────────────────────┘
 │              │  /trade/*     ──▶ decide / execute → Webull HTTP
 │              │  /admin/*        operator 操作 (Cloudflare Access)
 │              │  /dashboard/*    read-only SSR  (Cloudflare Access)
 │              │  /mcp            read-only MCP  (Access service token)
 └──────┬───────┘
        │
 ┌──────┴────────────────────────────────────────────────────┐
 │              Durable Objects  +  D1                         │
 │  SYMBOL_STATE (per-symbol: position / pending / cooldown)   │
 │  PORTFOLIO_STATE (daily equity / drawdown kill)             │
 │  WEBULL_TOKEN_STATE (x-access-token + 自動 refresh)          │
 │  DB: trade_journal / symbol_config / global_config /        │
 │      strategy_decision_log / earnings_calendar /            │
 │      macro_event_calendar / config_audit_log /              │
 │      portfolio_equity_snapshot / tradable_instrument ...    │
 └─────────────────────────────────────────────────────────────┘
```

> gRPC bridge (Node Container) は PR #110 で撤去済。SELL 後処理は `reconcileFills` に統合され、`/events/trade` ingest も廃止された。

## Safety defaults (fail-closed)

`global_config` singleton (D1 `id='default'`) で保持。未シード時は `GLOBAL_CONFIG_DEFAULTS` にフォールバック。`UPDATE global_config SET ...` で runtime 即反映、deploy 不要 (#118 で確立した POC 方針)。

**Kill-switch / gate:**

| フィールド | 既定 | 意味 |
|---|---|---|
| `dry_run` | `1` | Execution Mock に固定、broker へ送らない |
| `trading_enabled` | `0` | Risk layer が全注文 reject |
| `market_hours_check` | `0` | UTC 13:30-20:00 Mon-Fri チェック |
| `session_window_gate_enabled` | `0` | 開場 30 分前〜引けの窓外は戦略 cron の評価自体を skip |
| `drawdown_kill_threshold` | `-0.02` | 日次 realized_pnl / start_equity 比で自動 kill |
| `stale_quote_ms` | `900000` | halt 判定 (15 min) |

**通貨別 cap / 予算 (Phase E、#76):**

| フィールド | 既定 | 意味 |
|---|---|---|
| `max_order_notional_usd` | `2000` | USD 銘柄の 1 注文上限 ($) |
| `max_order_notional_jpy` | `100000` | JPY 銘柄の 1 注文上限 (¥) |
| `total_capital_usd` / `_jpy` | `NULL` | NAV (NULL なら exposure check skip) |
| `max_portfolio_exposure_pct` | `0.6` | total_capital × これを超える open 合計を禁止 |
| `spread_limit_pct_{us,jp}` | `0.0025` / `0.006` | spread guard |
| `gap_reject_pct` | `0.03` | gap 判定 |

**Pullback 戦略の default rule (#118、#124):**

| フィールド | 既定 | 意味 |
|---|---|---|
| `pullback_default_stop_pct` | `-0.04` | pct-based stop (ATR stop の floor) |
| `pullback_default_take_profit_pct` | `0.07` | take-profit |
| `pullback_default_time_stop_days` | `10` | 保有上限 (営業日) |
| `pullback_default_pullback_{max,min}` | `-0.03` / `-0.06` | entry 窓 |
| `pullback_default_min_return_50d` | `0.08` | 50日 return の uptrend filter |
| `pullback_default_require_above_sma50` | `1` | sma50 超を entry 必須 |
| `pullback_default_k_atr` | `2.0` | ATR 倍率。`stopDistance = max(k_atr × atr20, pct stop)` |
| `pullback_default_max_sma50_deviation_pct` | `0.6` | sma50 からの上方乖離が大きすぎる時は entry 見送り |
| `pullback_default_max_atr_ratio` | `1.5` | ATR 拡大 (ボラ急騰) 時の entry 見送り閾値 |

**Risk gate の動的パラメタ (#23 Lane 2-3):**

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

加えて:
- `symbol_config.active = 0` にすれば universe から外れて cron から除外
- `symbol_config` の per-symbol override (`stop_pct_override` / `k_atr_override` / `lot_size` / `budget_alloc_pct` / `role` など) が global default に優先
- `inverse_pairs` で SOXL/SOXS 同時保有を構造的に禁止
- Cloudflare Access JWT で `/trade/*` / `/webull/*` / `/admin/*` / `/dashboard/*` / `/mcp` を保護 (#29)
- state 変更 / admin write / dashboard GET は Workers Rate Limit binding で cap (#285)

## Layout

```
src/
  app.ts / index.ts           Hono factory + Workers entry (fetch / scheduled)
  routes/                     health / trade / webull / admin / mcp + dashboard/ (画面ごとに分割)
  trading/
    application/              TradingService
    domain/                   Signal / OrderIntent / RiskDecision / ExecutionResult / StrategyDecision / tradingCalendar
    strategy/                 strategies/ (Pullback / BreakoutMomentum / FixedRule) + pullbackSizing (ATR stop, lot-round)
                              + indicators + pullbackScheduler + runStrategyCron + buyingPower + conditionalAllocation
    risk/                     DefaultRiskPolicy + spreadGuard + jpPriceBand + drawdownRiskScale + vixRegimeFilter
                              + earningsGate + macroEventGate + perSymbolRiskGate + tickerDenyGuard
    execution/                Execution + MockExecution + WebullExecution
    reconciliation/           reconcileFills (Webull order history → D1 + DO apply) + syncHoldings
    state/                    SymbolStateDO / PortfolioStateDO / WebullTokenStateDO + clients / transitions
    portfolio/                runPortfolioRoll (EOD rollover)
    runtime/                  killSwitch + productionReadiness
    quotes/                   quoteScheduler
    backtest/                 runBacktest
  infrastructure/
    webull/                   WebullReadClient / WebullTradeClient (facade) + WebullHttpClient / WebullAuth / mapper
                              + token flow (WebullTokenClient / refreshWebullToken / resolveAccessToken)
                              + tradability / instrument lookup / allowlist refresh
    quotes/                   BarClient / YahooBarClient / YahooQuoteClient / WebullQuoteClient / fxRate
    calendar/                 us・jp market calendar + earnings / macro event repo
    notification/             Notifier 実装 + Slack/Discord webhook + 状態変化検知
    logger/                   AuditLogger + tradeJournal + strategyDecisionLog (console + D1 sink)
    db/                       drizzle schema + 各 repo (tradeJournal / symbolConfig / globalConfig / ...) + loaders
  middleware/                 accessJwt (Cloudflare Access) + rateLimit
  shared/                     errors / format
  config/                     env (secret / binding の型定義と parser)
scripts/                      issue-webull-token / list-webull-accounts / guard-deploy / verify-production-d1 / backtest-*
drizzle/                      generated D1 migrations (0000_init … 0037_decision_skip_reject_taxonomy)
docs/                         db-operations / env-separation / production-cd / production-deployment / review-queries / seed
test/                         vitest suite (117 files / 1724 cases)
```

## Dev

```bash
pnpm install
pnpm run typecheck                # tsc --noEmit
pnpm test                         # vitest
pnpm dev                          # wrangler dev (ローカル D1 自動作成)
pnpm exec wrangler deploy --dry-run
```

`.dev.vars.example` を `.dev.vars` にコピーして 1Password `op inject` で値埋め。

## Endpoints

auth 列の `Access` は Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` 検証、#29)。admin は endpoint 数が多いので代表のみ — 全量は `src/routes/admin.ts` / `src/routes/dashboard/index.ts` 参照。

| method | path | auth | 概要 |
|---|---|---|---|
| GET | `/health` | none | `{status, timestamp}` |
| POST | `/trade/decide` | Access | Signal + OrderIntent + RiskDecision を返す (発注しない) |
| POST | `/trade/execute` | Access | 上記 + ExecutionResult (`dry_run=1` で Mock、0 で Webull) |
| POST | `/webull/order/place` | Access | 低レベル疎通 endpoint (`dry_run=1` で synthetic response、`dry_run=0` は 403 で拒否。実発注は `/trade/execute` か `/admin/strategy/run` 経由) |
| GET | `/admin/production-readiness` | Access | 本番 gate 解除前の fail-closed preflight (#379) |
| POST | `/admin/strategy/run` | Access | `runStrategyCron` 手動 trigger (cron 待たず試走) |
| POST | `/admin/trading/toggle` | Access | `trading_enabled` の切替 (履歴を `trading_toggle_history` に記録) |
| POST | `/admin/orders/{reconcile,sync-holdings}` | Access | `reconcileFills` / broker 保有との同期を手動 trigger |
| GET | `/admin/orders/:clientOrderId` | Access | Webull order history を client_order_id で検索 |
| POST | `/admin/portfolio/{seed-equity,roll-daily,seed-exposure}` | Access | equity 初期化 / EOD rollover / exposure 投入 |
| POST | `/admin/symbol-config/...` | Access | 銘柄の追加 / 更新 / active 切替 / 予算配分 / 取扱可否チェック |
| POST | `/admin/webull-token/{seed,refresh}` | Access | `x-access-token` の DO への投入 / 更新 |
| GET/POST | `/admin/{earnings,macro-events}` | Access | イベントカレンダーの参照 / 投入 / 削除 |
| GET | `/dashboard` | Access | read-only ランディング (資産サマリ / KPI / equity / 保有 / 直近取引) |
| GET | `/dashboard/{positions,portfolio,trades,config,cron,charts,symbols,events,alerts,audit,broker-probe,webull-token}` | Access | DO / D1 snapshot を HTML で可視化 |
| GET | `/dashboard/{positions,trades,cron,charts/symbol}/json` | Access | 同 packet の JSON 版 |
| GET/POST/DELETE | `/mcp` | Access (service token) | read-only MCP server。dashboard と同一 packet を tool として公開 (#553) |

Cron:
- `*/5 * * * *` — quote feed (bars → SymbolStateDO) + `reconcileFills`
- `*/15 * * * *` — strategy cron (USD + JPY currency-aware、JP は `lot_size` 丸め)
- `0 22 * * *` — portfolio roll (EOD) + Webull token refresh + market data health check + tradable allowlist 更新

## Bindings (wrangler.jsonc)

| 種別 | 名前 | 説明 |
|---|---|---|
| Durable Object | `SYMBOL_STATE` | 銘柄ごとの position / pending / cooldown |
| Durable Object | `PORTFOLIO_STATE` | 日次 equity / drawdown kill |
| Durable Object | `WEBULL_TOKEN_STATE` | `x-access-token` の保持と自動 refresh (#21 Phase B) |
| Rate Limit | `STATE_CHANGE_RATE_LIMIT` | 5 req / 60s — `trading/toggle` 等の状態変更 |
| Rate Limit | `ADMIN_WRITE_RATE_LIMIT` | 20 req / 60s — その他 admin write |
| Rate Limit | `DASHBOARD_RATE_LIMIT` | 60 req / 60s — dashboard GET |
| D1 Database | `DB` | trade_journal / symbol_config / global_config / strategy_decision_log ほか |

## Secrets (`wrangler secret put`)

運用可変値は D1 に逃げたので、ここに残るのは **認証情報と非公開 URL のみ**:

| Secret | 用途 |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` | Cloudflare Access JWT 検証 (#29)。旧 `BASIC_AUTH_*` は廃止 |
| `CF_ACCESS_MCP_AUD` | `/mcp` 専用 Access application の AUD (#553)。未設定なら `CF_ACCESS_AUD` に fallback |
| `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_ACCOUNT_ID_JP_CASH` | broker 署名・口座 (JP_CASH 単一口座、#109) |
| `WEBULL_TRADE_API_BASE` | trade API host override (#21)。未設定なら JP prod default (`https://api.webull.co.jp`)。UAT は ALB URL を投入 |
| `WEBULL_QUOTES_API_BASE` | quotes API host override (#21)。未設定なら JP prod default (`https://data-api.webull.co.jp`)。UAT は ALB URL を投入 |
| `WEBULL_EVENTS_API_BASE` | events API host override (#21、consumer 未実装)。未設定なら JP prod default (`https://events-api.webull.co.jp`) |
| `WEBULL_ACCESS_TOKEN` | `x-access-token` の bootstrap fallback (#21)。signature とは直交する supplemental auth、JP 本番では必須。`pnpm run issue-token` で発行 + 2FA verify して取得する (下記参照)。通常運用では DO seed 後に自動 refresh される |
| `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` | 通知先 webhook (#199)。未設定ならその channel は無効 |
| `DASHBOARD_BASE_URL` | 通知に添える dashboard link の base URL |

```bash
pnpm wrangler secret put CF_ACCESS_AUD --env=staging
# ... 1 件ずつ、誤 env 防止のため loop 化しない
pnpm wrangler secret list --env=staging   # 揃ったか確認
```

`x-access-token` は secret ではなく `WEBULL_TOKEN_STATE` DO を正とする運用 (`WEBULL_ACCESS_TOKEN` は DO seed 前の bootstrap fallback)。

### Webull account_id を取得する

Webull sandbox は dashboard で account_id を見られないので、app_key + app_secret だけで API を叩いて取得する。host は env 未設定なら JP prod default (`api.webull.co.jp`):

```bash
WEBULL_APP_KEY="$(op read 'op://Personal/WEBULL_APP_KEY/credential')" \
WEBULL_APP_SECRET="$(op read 'op://Personal/WEBULL_APP_SECRET/credential')" \
  pnpm run accounts

# UAT で叩く場合は ALB URL を override:
WEBULL_APP_KEY=... WEBULL_APP_SECRET=... \
WEBULL_TRADE_API_BASE=https://jp-openapi-alb.uat.webullbroker.com \
  pnpm run accounts
```

### Webull `x-access-token` を発行する (#21)

JP 本番では signature に加えて 2FA-backed `x-access-token` が必須。`pnpm run issue-token` が `/openapi/auth/token/create` を叩いて PENDING token を発行し、operator が Webull モバイルアプリで 2FA SMS verify を完了するのを poll で待ち、NORMAL になった token を stdout に出力する。

```bash
# 1. Operator script を起動
WEBULL_APP_KEY="$(op read 'op://Personal/WEBULL_APP_KEY/credential')" \
WEBULL_APP_SECRET="$(op read 'op://Personal/WEBULL_APP_SECRET/credential')" \
  pnpm run issue-token

# 2. ログに表示された PENDING token を確認し、Webull モバイルアプリで 5 分以内に
#    2FA SMS verify を完了する。script は 30 秒毎に check_token を poll する。

# 3. status=NORMAL になると stdout に token 文字列だけが出力されるので、
#    そのまま wrangler に流し込める:
pnpm wrangler secret put WEBULL_ACCESS_TOKEN --env=production
# (上で出力された token 文字列を貼り付ける)

# refresh (既存 token を引き継いで更新したい場合):
WEBULL_APP_KEY=... WEBULL_APP_SECRET=... \
WEBULL_EXISTING_TOKEN=<old token> \
  pnpm run issue-token
```

15 days inactivity で `INVALID` 化する。取得した token は `POST /admin/webull-token/seed` (または `/dashboard/webull-token` の画面) で `WEBULL_TOKEN_STATE` DO に投入する。以降は `0 22 * * *` cron が expires 残り 7 days を切ったら `createToken(existingToken)` で自動 refresh し、失敗時は critical 通知が飛ぶ。

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

deploy は Cloudflare Workers Builds の CD 任せ。手動 `wrangler deploy` は通常不要 (migration も CD に含まれる):

| Branch | deploy 先 | build command |
|---|---|---|
| `main` | staging | `pnpm deploy:staging` |
| `production` | production | `pnpm deploy:production` |

production は `main` から自動生成される `release/production` → `production` の release PR merge が唯一の入口 (`production` への direct push は禁止)。詳細は [`docs/production-cd.md`](docs/production-cd.md)。

`pnpm run deploy:*` が migration → deploy を `&&` で繋ぐので、migration 失敗時は worker がデプロイされない (壊れた schema に新 code が当たる事故を防ぐ)。production はさらに `pnpm verify:production-d1` が前段に入り、`database_id` 未設定なら止まる。

## 運用

銘柄追加 / trading toggle / token 投入といった日常操作は `/dashboard` の画面と `/admin/*` API から行える (変更は `config_audit_log` / `trading_toggle_history` に記録される)。画面が無い項目や緊急時は wrangler CLI から直接 SQL を叩く:

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

# Pullback rule / risk param を runtime tuning (#118 / #124 / #125 / #126)
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "UPDATE global_config SET \
             pullback_default_k_atr = 2.5, \
             risk_dd_half_threshold = -0.05, \
             vix_critical_threshold = 30.0 \
             WHERE id = 'default'"

# per-symbol override (global default より優先)
pnpm wrangler d1 execute webull-trading-staging --env=staging --remote \
  --command "UPDATE symbol_config SET k_atr_override = 2.5, stop_pct_override = -0.05 WHERE symbol = 'SOXL'"

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

