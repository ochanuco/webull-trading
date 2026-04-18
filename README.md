# webull-trading

Retail auto-trading **POC** on Cloudflare Workers + Hono + TypeScript, speaking Webull OpenAPI directly (no SDK) with a separate Node-runtime gRPC bridge for trade-event streaming.

**Status**: POC 全 Phase 完了 (Issue #1 closed)。実口座での疎通検証と Webull canonical signing の本実装は別フェーズ扱い。

## Safety defaults (fail-closed)

- `DRY_RUN=true` (unset も true 扱い) — broker に実発注しない
- `TRADING_ENABLED=false` — Risk で全注文を reject
- `ALLOWED_SYMBOLS` に含まれないシンボルは Risk で reject
- `MAX_ORDER_NOTIONAL` + `SYMBOL_MAX_NOTIONAL` (JSON) で発注金額上限
- `MARKET_HOURS_CHECK=true` にすると UTC 13:30-20:00 Mon-Fri 以外を reject
- `EVENT_INGEST_SECRET` header + timing-safe 比較で `/events/trade` 保護
- Basic Auth で `/trade/*` / `/webull/*` を保護

## Layout

```
src/
  app.ts, index.ts          Hono factory + Workers entry
  routes/                   health / trade / webull / events
  trading/
    application/            TradingService / TradeEventService
    domain/                 Signal / OrderIntent / RiskDecision / ExecutionResult / TradeEvent
    strategy/               Strategy interface + FixedRuleStrategy
    risk/                   RiskPolicy + DefaultRiskPolicy
    execution/              Execution interface + MockExecution / WebullExecution
    events/                 TradeEventHandler
  infrastructure/
    webull/                 WebullHttpClient / WebullAuth (placeholder signing) / dto / mapper / TradeEventBridge (contract)
    logger/                 AuditLogger (JSON + requestId + errorClass/errorMessage scrubber)
  middleware/               basicAuth
  shared/                   errors (TradingError / ValidationError / BrokerRequestError)
  config/                   env
bridge/                     Node runtime (non-Workers) — gRPC trade event subscriber + ingest POST
test/                       vitest (unit + route integration)
```

## Dev

```bash
pnpm install
pnpm run typecheck        # tsc --noEmit
pnpm test                 # vitest run (main + bridge)
pnpm dev                  # wrangler dev
pnpm exec wrangler deploy --dry-run
# bridge 単体の typecheck
cd bridge && pnpm install && pnpm exec tsc --noEmit -p .
```

`.dev.vars.example` を `.dev.vars` にコピーして編集して `pnpm dev` で起動。

## Endpoints

| method | path | auth | 概要 |
|---|---|---|---|
| GET | `/health` | none | `{status, timestamp}` |
| POST | `/trade/decide` | Basic | Signal + OrderIntent + RiskDecision を返す (発注しない) |
| POST | `/trade/execute` | Basic | 上記 + ExecutionResult (`DRY_RUN=true`/未設定で Mock、それ以外で Webull) |
| POST | `/webull/order/place` | Basic | POC 用低レベル疎通 endpoint (DRY_RUN 時は synthetic response) |
| POST | `/events/trade` | secret header | bridge からの trade event ingest |

## Env

実値は `.dev.vars.example` 参照。

| 変数 | 既定 | 用途 |
|---|---|---|
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | — | `/trade/*` / `/webull/*` の Basic Auth |
| `DRY_RUN` | `true` (fail-closed) | Execution 切替 (Mock vs Webull) |
| `TRADING_ENABLED` | `false` (fail-closed) | Risk の trading 全体スイッチ |
| `ALLOWED_SYMBOLS` | — | CSV 許可リスト (case-insensitive → 上書き大文字正規化) |
| `MAX_ORDER_NOTIONAL` | — | 1 注文あたり上限金額 (数値) |
| `SYMBOL_MAX_NOTIONAL` | `{}` | JSON inline で symbol 別上書き |
| `MARKET_HOURS_CHECK` | `false` | UTC 13:30-20:00 Mon-Fri チェック |
| `EVENT_INGEST_SECRET` | — | `/events/trade` の secret header 値 |
| `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` / `WEBULL_ACCOUNT_ID` | — | Webull 認証 (placeholder signing) |
| `WEBULL_API_BASE` | `https://openapi.webull.com` | Webull HTTP base |

## Deploy / Secrets (Cloudflare Workers)

`wrangler.jsonc` に **staging / production** 2つの environments を定義してある。既定環境 (env 指定なし) はローカル dev 用、デプロイは必ず `--env` 付きで。

| env | worker name | 用途 |
|---|---|---|
| default (no `--env`) | `webull-trading` | `wrangler dev` ローカル実行専用 |
| `staging` | `webull-trading-staging` | 検証環境 |
| `production` | `webull-trading-production` | 本番 |

### 初回セットアップ

```bash
# 1. Cloudflare へログイン (ブラウザが開く)
pnpm exec wrangler login

# 2. Worker を空で作成して secrets 枠を用意
pnpm exec wrangler deploy --env staging
pnpm exec wrangler deploy --env production
```

### Secrets 投入 (`wrangler secret put`)

`.dev.vars` の内容は **本番/staging に自動同期しない**。環境ごとに明示的に投入する:

```bash
# staging
pnpm exec wrangler secret put BASIC_AUTH_USER --env staging
pnpm exec wrangler secret put BASIC_AUTH_PASSWORD --env staging
pnpm exec wrangler secret put EVENT_INGEST_SECRET --env staging
pnpm exec wrangler secret put ALLOWED_SYMBOLS --env staging
pnpm exec wrangler secret put MAX_ORDER_NOTIONAL --env staging
pnpm exec wrangler secret put SYMBOL_MAX_NOTIONAL --env staging
# Phase 3 Webull
pnpm exec wrangler secret put WEBULL_APP_KEY --env staging
pnpm exec wrangler secret put WEBULL_APP_SECRET --env staging
pnpm exec wrangler secret put WEBULL_ACCOUNT_ID --env staging

# production (同じ set を production に)
pnpm exec wrangler secret put BASIC_AUTH_USER --env production
# ... 以下同様
```

`DRY_RUN` / `TRADING_ENABLED` / `MARKET_HOURS_CHECK` / `WEBULL_API_BASE` は env var (非 secret) なので `wrangler.jsonc` の `env.<target>.vars` に平文で書くか、同じく `wrangler secret put` で投入可。**本番で DRY_RUN=false / TRADING_ENABLED=true にする場合は、先に staging で十分疎通確認してから**。

### デプロイ

```bash
pnpm exec wrangler deploy --env staging       # staging に反映
pnpm exec wrangler deploy --env production    # production に反映
```

### Secrets のローテーション

```bash
pnpm exec wrangler secret put WEBULL_APP_SECRET --env production  # 上書き投入
pnpm exec wrangler secret list --env production                   # 現在の secrets (値は出ない)
pnpm exec wrangler secret delete WEBULL_APP_SECRET --env staging  # 削除
```

### 1Password 連携 (推奨、dotfile 手元運用)

\\`~/.coderabbit` の OAuth トークンと同じく、発行した credential を 1Password に保管して `op read` で解決する流れが安全:

```bash
export CLOUDFLARE_API_TOKEN="$(op read 'op://Personal/CLOUDFLARE_API_TOKEN/credential')"
pnpm exec wrangler deploy --env staging
```

GitHub Actions での自動デプロイは **別 PR 予定** (CI/CD 拡張時、follow-up [#24](https://github.com/ochanuco/webull-trading/issues/24))。本 PR は手動デプロイ前提の runbook のみ。

## AI エージェント / レビュー設定

このリポジトリは AI (Claude Code / Codex / CodeRabbit) で作業することを前提に設定ファイルを整備している:

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