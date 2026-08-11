# アーキテクチャ

## 全体像

```
 ┌──────────────┐  */5  * * * *   ┌────────────────────────────────────┐
 │  Cloudflare  │────────────────▶│ quote feed + reconcileFills         │
 │   Workers    │  */15 * * * * ─▶│ strategy cron (Pullback / Breakout) │
 │              │  0 22  * * * ──▶│ portfolio roll + token refresh +    │
 │              │                 │ market data health + allowlist 更新 +│
 │              │                 │ news shock gate 日次サマリ            │
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
 │      portfolio_equity_snapshot / tradable_instrument /      │
 │      attention_observation ...                              │
 └─────────────────────────────────────────────────────────────┘
```

発注経路は **Strategy → Risk → Execution** の一方向。Risk で止まる導線を迂回する経路は作らない。

> gRPC bridge (Node Container) は PR #110 で撤去済。SELL 後処理は `reconcileFills` に統合され、`/events/trade` ingest も廃止された。

## Cron

| schedule | 内容 |
|---|---|
| `*/5 * * * *` | quote feed (bars → SymbolStateDO) + `reconcileFills` |
| `*/15 * * * *` | strategy cron (USD + JPY currency-aware、JP は `lot_size` 丸め) |
| `0 22 * * *` | portfolio roll (EOD) + Webull token refresh + market data health check + tradable allowlist 更新 + news shock gate 日次サマリ通知 |

stop / take-profit / time-stop は**ブローカー側の逆指値ではなく cron が毎 tick 評価するソフト stop**。cron が止まると保有銘柄は無防備になるため、risk halt は entry だけを止めて exit 判定は継続する (`entryHaltReason`、#595)。

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

## ディレクトリ構成

```
src/
  app.ts / index.ts           Hono factory + Workers entry (fetch / scheduled)
  routes/                     health / trade / webull / admin / mcp + dashboard/ (画面ごとに分割)
  trading/
    application/              TradingService
    domain/                   Signal / OrderIntent / RiskDecision / ExecutionResult / StrategyDecision
                              + tradingCalendar + tradingCost
    strategy/                 strategies/ (Pullback / BreakoutMomentum / FixedRule) + pullbackSizing
                              + stopDistance + indicators + pullbackScheduler + runStrategyCron
                              + buyingPower + conditionalAllocation
    risk/                     DefaultRiskPolicy + spreadGuard + jpPriceBand + drawdownRiskScale
                              + vixRegimeFilter + newsShockGate + earningsGate + macroEventGate
                              + perSymbolRiskGate + tickerDenyGuard
    execution/                Execution + MockExecution + WebullExecution
    reconciliation/           reconcileFills (Webull order history → D1 + DO apply) + syncHoldings
    state/                    SymbolStateDO / PortfolioStateDO / WebullTokenStateDO + clients / transitions
    portfolio/                runPortfolioRoll (EOD rollover)
    news/                     newsScheduler (attention observation の収集)
    runtime/                  killSwitch + productionReadiness
    quotes/                   quoteScheduler
    backtest/                 runBacktest
  infrastructure/
    webull/                   WebullReadClient / WebullTradeClient (facade) + WebullHttpClient / WebullAuth
                              + mapper + token flow + tradability / instrument lookup / allowlist refresh
    quotes/                   BarClient / YahooBarClient / YahooQuoteClient / WebullQuoteClient / fxRate
    news/                     GdeltDocClient + newsProbes
    calendar/                 us・jp market calendar + earnings / macro event repo
    notification/             Notifier 実装 + Slack/Discord webhook + 状態変化検知
    logger/                   AuditLogger + tradeJournal + strategyDecisionLog (console + D1 sink)
    db/                       drizzle schema + 各 repo + loaders
  middleware/                 accessJwt (Cloudflare Access) + rateLimit
  shared/                     errors / format
  config/                     env (secret / binding の型定義と parser)
scripts/                      issue-webull-token / list-webull-accounts / guard-deploy
                              / verify-production-d1 / backtest-*
drizzle/                      generated D1 migrations
docs/                         本ディレクトリ (下記 index は README)
test/                         vitest suite
```

## 層の境界

- Webull の raw JSON は `infrastructure/webull/` に閉じ込め、application / domain には正規化後のドメイン型だけを流す
- `rawPayload` は監査用に保持するが、domain ロジックからは参照しない
- 時刻は UTC の ISO 8601 で保存し、市場時間への変換は表示側で行う
