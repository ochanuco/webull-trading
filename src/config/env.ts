import type { SymbolStateDO } from '../trading/state/SymbolStateDO'

export interface Env {
  SYMBOL_STATE: DurableObjectNamespace<SymbolStateDO>
}

// Webull broker config
export interface Env {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_ACCOUNT_ID_JP_CASH?: string
  WEBULL_TRADE_API_BASE?: string
  /** Snapshot endpoint path override (UAT endpoint wasn't finalized at POC time). */
  WEBULL_QUOTE_PATH?: string
}


// PortfolioStateDO binding
import type { PortfolioStateDO } from '../trading/state/PortfolioStateDO'

export interface Env {
  PORTFOLIO_STATE?: DurableObjectNamespace<PortfolioStateDO>
}

// D1 binding
export interface Env {
  /** D1 database for trade_journal / symbol_config / global_config. Optional so tests and D1-less legacy deploys still work. */
  DB?: D1Database
}

// Notification webhook config
export interface Env {
  /** Slack incoming webhook URL; unset disables Slack notifications. Set via `wrangler secret put SLACK_WEBHOOK_URL`. */
  SLACK_WEBHOOK_URL?: string
  /** Discord webhook URL; unset disables Discord notifications. Set via `wrangler secret put DISCORD_WEBHOOK_URL`. */
  DISCORD_WEBHOOK_URL?: string
  /** Base URL for the dashboard link included in notifications (e.g. https://webull-trading.example.workers.dev). Unset omits the link. */
  DASHBOARD_BASE_URL?: string
}


// trade/account endpoint path overrides — lets the old->new OpenAPI path
// drift (below) be migrated per-env without a deploy. Unset / empty /
// whitespace-only / not-starting-with-'/' falls back to the old default
// (prevents an absolute-URL value from bypassing WEBULL_TRADE_API_BASE).
//
//   old                                  ->  new
//   /openapi/account/positions          ->  /openapi/assets/positions
//   /openapi/account/orders/history     ->  /openapi/trade/order/history
//   /openapi/account/orders/place       ->  /openapi/trade/order/place
export interface Env {
  WEBULL_PATH_POSITIONS?: string
  WEBULL_PATH_ORDERS_HISTORY?: string
  WEBULL_PATH_ORDERS_PLACE?: string
}


// Account Balance endpoint path override, for the buying-power pre-trade
// gate. Default v1 `/openapi/account/balance`; pass `/openapi/assets/balance`
// (same shape) when running `WEBULL_TRADE_VERSION=v2`. Unset / empty /
// not-starting-with-'/' falls back to the default (prevents an absolute-URL
// injection).
export interface Env {
  WEBULL_PATH_ACCOUNT_BALANCE?: string
}


// env override for the x-version header sent on trade/account routes.
// Default 'v1'. Allow-listed to 'v1' / 'v2' only — anything else (empty /
// whitespace / typo) falls back to 'v1' since an arbitrary string here
// breaks auth signing.
export interface Env {
  WEBULL_TRADE_VERSION?: string
}


// env override for Place Order request body schema version. 'v1' (default)
// or 'v2'. Allow-listed to 'v1' / 'v2' only — anything else falls back to
// 'v1' (an arbitrary string would send a broken body to the broker).
//
// v2 changes the mapper:
//   - always sets combo_type: 'NORMAL'
//   - support_trading_session: 'N' -> 'CORE' ('N' retired)
//   - omits limit_price for MARKET orders (required for LIMIT only)
//   - moves account_id from query to body
export interface Env {
  WEBULL_PLACE_ORDER_SCHEMA?: string
}


// TRADING_ENABLED is a deploy-gate override (forces OFF for non-prod /
// preview), distinct from D1 `global_config.trading_enabled` (the runtime
// value). The more restrictive side always wins: an env OFF blocks trading
// even if the DB says ON.
//
//   env unset / 'true'  -> defer to DB trading_enabled
//   env 'false'         -> force OFF even if DB is true (fail-closed)
//   env anything else   -> force OFF (a typo should halt trading, not enable it)
export interface Env {
  TRADING_ENABLED?: string
}


// Cloudflare Access JWT auth (replaces the retired BASIC_AUTH_* / EVENT_INGEST_SECRET).
// - CF_ACCESS_TEAM_DOMAIN: team URL (e.g. https://<team>.cloudflareaccess.com);
//   JWKS is fetched from `<team>/cdn-cgi/access/certs`. When set, middleware
//   enforces JWT verification and ignores ACCESS_DEV_BYPASS_USER (prod-safe gate).
// - CF_ACCESS_AUD: application AUD tag; a JWT claim mismatch is a 401.
// - ACCESS_DEV_BYPASS_USER: stamps this string as actor only in local dev
//   (`wrangler dev`) when CF_ACCESS_TEAM_DOMAIN is unset AND no
//   `Cf-Access-Jwt-Assertion` header is present. Must never be set in a
//   deployed env — the gate above neutralizes it there, but not setting it
//   removes the risk entirely.
// - CF_ACCESS_MCP_AUD: AUD tag for the /mcp-only Access application
//   (path-scoped + Service Auth policy); falls back to CF_ACCESS_AUD when
//   unset. Kept separate so a service token's reach is limited to
//   read-only /mcp.
export interface Env {
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  CF_ACCESS_MCP_AUD?: string
  ACCESS_DEV_BYPASS_USER?: string
}


// Cloudflare Workers `RateLimit` bindings (state-changing writes / admin
// writes / dashboard soft cap). Declared per-env under `[[unsafe.bindings]]`
// in `wrangler.jsonc`. If local miniflare doesn't recognize the binding,
// middleware warns and fails open.
export interface Env {
  STATE_CHANGE_RATE_LIMIT?: RateLimit
  ADMIN_WRITE_RATE_LIMIT?: RateLimit
  DASHBOARD_RATE_LIMIT?: RateLimit
}


// Webull JP production splits 3 API hosts:
//   trade  : api.webull.co.jp         -> WEBULL_TRADE_API_BASE
//   quotes : data-api.webull.co.jp    -> WEBULL_QUOTES_API_BASE
//   events : events-api.webull.co.jp  -> WEBULL_EVENTS_API_BASE (no consumer yet, reserved)
// Values match the SDK's published region defs (webull-openapi-python-sdk
// endpoints.json) so there's no reason to hide them; each client factory
// falls back to the JP prod default when the env var is unset / empty /
// whitespace, and honors an explicit override otherwise (UAT / future
// regions). JP UAT (jp-openapi-alb.uat.webullbroker.com) funnels everything
// through one ALB host, so hitting UAT means overriding all 3 vars to the
// same UAT ALB URL.
export interface Env {
  WEBULL_QUOTES_API_BASE?: string
  WEBULL_EVENTS_API_BASE?: string
}


// Webull `x-access-token` hybrid auth (signature + 2FA token;
// developer.webull.co.jp/apis/docs/authentication/token):
//   1. operator issues a token via Webull's official tool -> PENDING
//   2. 2FA SMS verify in the Webull mobile app within 5 min -> NORMAL
//   3. `wrangler secret put WEBULL_ACCESS_TOKEN --env=<env>` with that token
//   4. each client sends it as the `x-access-token` header
// Not included in the signature's canonical string (per SDK/docs, a
// supplemental header like x-version). Expires after 15 days of
// inactivity; `WEBULL_TOKEN_STATE` (below) auto-refreshes it, with this var
// as the bootstrap/fallback path when that DO has no seeded token. Missing
// this var is not itself fail-closed — client creation still succeeds — so
// a gap surfaces as a 401 from the broker rather than at startup.
export interface Env {
  WEBULL_ACCESS_TOKEN?: string
}


// Deploy environment label, hardcoded per env via `wrangler.jsonc::env.<env>.vars`
// (baked into the deploy artifact; a secret override is possible but treated
// as deliberate operator action — this guards against accidents, not
// tampering). `WebullTradeClient` checks `ENVIRONMENT === 'staging'` to
// refuse live orders from staging, because Webull JP's 1-user-1-app
// constraint means staging and prod can't have separate API keys — the
// gate has to live in code.
//   - dev:        'dev'        (wrangler.jsonc env.dev.vars)
//   - staging:    'staging'    (wrangler.jsonc env.staging.vars)
//   - production: 'production' (wrangler.jsonc env.production.vars)
// 'production' could be omitted, but setting it explicitly makes "past the
// staging gate = production" legible at the call site.
export interface Env {
  ENVIRONMENT?: string
}


// DO holding Webull `x-access-token` runtime state. Operator seeds it via
// the admin endpoint with a token from `pnpm run issue-token`; a cron
// refreshes and writes it back via
// `WebullTokenClient.createToken(existingToken)`. WEBULL_ACCESS_TOKEN stays
// as the fallback bootstrap path when the DO has no seed; when both are
// present, the DO wins (the auto-refreshing source is treated as
// authoritative).
import type { WebullTokenStateDO } from '../trading/state/WebullTokenStateDO'

export interface Env {
  WEBULL_TOKEN_STATE?: DurableObjectNamespace<WebullTokenStateDO>
}


// First-live production readiness policy. Not trading gates themselves —
// they bound `/admin/production-readiness`, giving the operator a
// fail-closed preflight before removing the production TRADING_ENABLED
// deploy gate.
export interface Env {
  FIRST_LIVE_MAX_ACTIVE_SYMBOLS?: string
  FIRST_LIVE_MAX_ORDER_NOTIONAL_USD?: string
  FIRST_LIVE_MAX_ORDER_NOTIONAL_JPY?: string
  ROLLBACK_REHEARSAL_MAX_AGE_HOURS?: string
}


// Quote-source switch. 'webull' makes the Market Data API (trade host + v2)
// primary, restoring the spread guard to real bid/ask via its snapshot.
// Auto-falls back to Yahoo for JP symbols and on Webull failure. Unset / any
// other value = 'yahoo' (the long-standing default) — the fail-safe side is
// default, switching is an explicit opt-in only.
export interface Env {
  QUOTE_SOURCE?: string
}


// Bar-source switch (same convention as QUOTE_SOURCE, independent canary).
// 'webull' makes Market Data API bars (trade host + v2) primary; auto-falls
// back to Yahoo for ^VIX (index) / JP symbols / on Webull failure. Unset /
// any other value = 'yahoo' — the fail-safe side is default.
export interface Env {
  BAR_SOURCE?: string
}


// NEWS_ATTENTION_ENABLED: opt-in for `newsScheduler`. 'true'
// (case-insensitive, trimmed) enables the GDELT fetch; unset/anything else
// disables it — same "unset is the safe default, opt-in is explicit"
// pattern as QUOTE_SOURCE / BAR_SOURCE.
// GDELT_API_BASE: GDELT DOC 2.0 API base URL override, for tests. Unset
// uses the production URL (`https://api.gdeltproject.org`).
export interface Env {
  NEWS_ATTENTION_ENABLED?: string
  GDELT_API_BASE?: string
}


// EXTENDED_HOURS_OBSERVATION_ENABLED: opt-in for `extendedHoursScheduler`.
// 'true' (case-insensitive, trimmed) enables fetching Yahoo pre-market 1m
// bars in the US pre-market window ([open-90min, open)); unset/anything
// else disables it, same default-safe pattern as NEWS_ATTENTION_ENABLED.
// Read by `extendedHoursGate` (gated off by default via
// `global_config.extended_hours_gate_mode`).
export interface Env {
  EXTENDED_HOURS_OBSERVATION_ENABLED?: string
}


// JEV_HEADLINE_EVAL_ENABLED: opt-in for `headlineEvalScheduler`, same
// default-safe pattern as NEWS_ATTENTION_ENABLED / EXTENDED_HOURS_OBSERVATION_ENABLED.
// AI: Workers AI binding. Typed as a minimal local shape rather than
// @cloudflare/workers-types' `Ai` — that type's `run()` overloads are keyed
// to a fixed model catalog and reject the `typesafe/jev` model id at
// compile time since it isn't in that catalog.
export interface Env {
  JEV_HEADLINE_EVAL_ENABLED?: string
  AI?: { run(model: string, input: unknown): Promise<unknown> }
}
