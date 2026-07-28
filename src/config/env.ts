import type { SymbolStateDO } from '../trading/state/SymbolStateDO'

export interface Env {
  SYMBOL_STATE: DurableObjectNamespace<SymbolStateDO>
}

// Webull broker config (Phase 2 append)
export interface Env {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_ACCOUNT_ID_JP_CASH?: string
  WEBULL_TRADE_API_BASE?: string
  /** Override the snapshot endpoint path (POC: UAT 未確定なので env で差し替え). */
  WEBULL_QUOTE_PATH?: string
}


// PortfolioStateDO binding (#38-B)
import type { PortfolioStateDO } from '../trading/state/PortfolioStateDO'

export interface Env {
  PORTFOLIO_STATE?: DurableObjectNamespace<PortfolioStateDO>
}

/**
 * Optional positive number env parser. Returns `fallback` when undefined or
 * malformed (fail-closed to a sane default rather than throwing — these are
 * risk knobs, not hard dependencies).
 */
export function parseOptionalPositiveNumber(
  value: string | undefined,
  fallback: number,
  key?: string,
): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid ${key ?? 'env'} value: '${value}'; using fallback ${fallback}`)
    return fallback
  }
  return parsed
}

// D1 binding (#68 Phase A append)
export interface Env {
  /**
   * D1 database for trade_journal (and eventually symbol_config, global_config).
   * Optional so existing tests / legacy deploys without D1 keep working.
   */
  DB?: D1Database
}

// Notification webhook config (#199 append)
export interface Env {
  /**
   * Slack incoming webhook URL。未設定なら Slack 通知無効。
   * `wrangler secret put SLACK_WEBHOOK_URL` で設定する。
   */
  SLACK_WEBHOOK_URL?: string
  /**
   * Discord webhook URL。未設定なら Discord 通知無効。
   * `wrangler secret put DISCORD_WEBHOOK_URL` で設定する。
   */
  DISCORD_WEBHOOK_URL?: string
  /**
   * 通知メッセージに付ける dashboard link の base URL
   * (例: `https://webull-trading.example.workers.dev`)。未設定なら link 省略。
   */
  DASHBOARD_BASE_URL?: string
}


// #257: trade/account endpoint path overrides (append at end / 共有ファイル
// は末尾 append 規約)。新 OpenAPI docs (#251) で `/openapi/account/*` →
// `/openapi/assets/positions` / `/openapi/trade/order/*` への drift。env を
// 切替えるだけで段階移行できる。default は旧 path、未設定 / 空 / whitespace
// のみ / `/` で始まらない値は fallback (絶対 URL 注入で WEBULL_TRADE_API_BASE を
// bypass する事故防止、CodeRabbit #264)。
//
//   旧                                  →  新
//   /openapi/account/positions          →  /openapi/assets/positions
//   /openapi/account/orders/history     →  /openapi/trade/order/history
//   /openapi/account/orders/place       →  /openapi/trade/order/place
export interface Env {
  WEBULL_PATH_POSITIONS?: string
  WEBULL_PATH_ORDERS_HISTORY?: string
  WEBULL_PATH_ORDERS_PLACE?: string
}


// #415: Account Balance endpoint path override (append at end)。買付余力 pool
// pre-trade ゲート用。default v1 `/openapi/account/balance` (JP probe で 200 確認)。
// `WEBULL_TRADE_VERSION=v2` 運用なら `/openapi/assets/balance` を指定する (同 shape)。
// 未設定 / 空 / `/` 始まりでない値は fallback (絶対 URL 注入防止)。
export interface Env {
  WEBULL_PATH_ACCOUNT_BALANCE?: string
}


// #258: trade/account routes に送る x-version ヘッダ値の env override
// (append at end)。default 'v1' (= 現行挙動)。新 OpenAPI docs では v2 必須化
// の方向だが、旧 path も v1 alias で受理されてるので staging で env 切替えて
// 検証してから default 化する。
// 受理値は 'v1' / 'v2' のみ allow-list。それ以外 (空 / whitespace / 不正値)
// は 'v1' fallback (任意文字列を渡すと auth signing が壊れるため strict)。
export interface Env {
  WEBULL_TRADE_VERSION?: string
}


// #256: Place Order body schema version の env override (append at end)。
// 'v1' (default / 現挙動) と 'v2' (新 OpenAPI docs) を切替え可能。受理値は
// 'v1' / 'v2' のみ allow-list、それ以外 (空 / whitespace / 任意文字列) は
// 'v1' fallback (任意文字列で broken body を broker に送らないため strict)。
//
// v2 にすると mapper は以下に変更:
//   - combo_type: 'NORMAL' を必ず付ける
//   - support_trading_session: 'N' → 'CORE' (新 enum、'N' は廃止)
//   - MARKET 注文では limit_price を送らない (LIMIT のときのみ required)
//   - account_id を query → body に移動
export interface Env {
  WEBULL_PLACE_ORDER_SCHEMA?: string
}


// #276: TRADING_ENABLED env var を deploy-gate (= non-prod / preview の強制 OFF
// override) として残す。prod は D1 `global_config.trading_enabled` が真値だが、
// 「env で OFF にしたら DB で ON にしても発注しない」=「より制限的な側が勝つ」
// 仕様。`true` 明示 / unset は DB を尊重、その他は OFF override 扱い。
//
//   env unset / 'true'  → DB の trading_enabled を使う
//   env が 'false'      → DB が true でも強制 OFF (fail-closed)
//   env がそれ以外       → 安全側に倒し 強制 OFF (typo は cron 止める方が安全)
export interface Env {
  TRADING_ENABLED?: string
}


// #29: Cloudflare Access JWT auth (append 規約)。旧 BASIC_AUTH_* / EVENT_INGEST_SECRET
// は廃止。
// - CF_ACCESS_TEAM_DOMAIN: team URL (例 https://<team>.cloudflareaccess.com)。
//   JWKS を `<team>/cdn-cgi/access/certs` から fetch。設定されていれば middleware は
//   JWT 検証を強制し、ACCESS_DEV_BYPASS_USER を無視する (prod-safe gate)。
// - CF_ACCESS_AUD: application AUD tag (Zero Trust application 詳細の Application
//   Audience)。JWT claim と一致しないと 401。
// - ACCESS_DEV_BYPASS_USER: local dev (wrangler dev) で CF_ACCESS_TEAM_DOMAIN が
//   未設定 AND `Cf-Access-Jwt-Assertion` ヘッダ無しの時のみ、この文字列を actor として
//   stamp する。**deployed env では絶対に設定禁止** (上記 gate で実質無効化されるが、
//   設定自体しない方が誤爆リスクが少ない)。
// - CF_ACCESS_MCP_AUD: /mcp 専用 Access application (path 限定 + Service Auth
//   policy) の AUD tag (#553)。未設定時は CF_ACCESS_AUD に fallback。専用 app を
//   分ける理由は service token の権限を read-only な /mcp に限定するため。
export interface Env {
  CF_ACCESS_TEAM_DOMAIN?: string
  CF_ACCESS_AUD?: string
  CF_ACCESS_MCP_AUD?: string
  ACCESS_DEV_BYPASS_USER?: string
}


// #285: Cloudflare Workers `RateLimit` binding (state 変更 / 運用書込 / dashboard
// soft cap)。`wrangler.jsonc` の `[[unsafe.bindings]]` で各 env に同名で宣言する。
// local miniflare で binding が認識されないケースは middleware 側で warn → fail-open。
export interface Env {
  STATE_CHANGE_RATE_LIMIT?: RateLimit
  ADMIN_WRITE_RATE_LIMIT?: RateLimit
  DASHBOARD_RATE_LIMIT?: RateLimit
}


// #21: Webull JP 本番ホスト分離 (append 規約)。
// JP 本番では 3 つの API host が分離されてる:
//   trade  : api.webull.co.jp         → WEBULL_TRADE_API_BASE
//   quotes : data-api.webull.co.jp    → WEBULL_QUOTES_API_BASE
//   events : events-api.webull.co.jp  → WEBULL_EVENTS_API_BASE (consumer 未実装、reserved)
// 値は SDK の公開 region 定義 (webull-openapi-python-sdk endpoints.json) に
// 載っており隠す価値はゼロなので、各 client factory は env 未設定 / 空 /
// whitespace のとき JP **prod** default に fallback する。env が explicit に
// セットされてれば override (UAT / 将来 region 用)。JP UAT
// (jp-openapi-alb.uat.webullbroker.com) は ALB が全部を 1 ホストに束ねるので、
// UAT を叩くときは 3 var とも UAT ALB URL を override 投入する運用。
// events API は consumer がまだ無いので declare のみ (default は引いてある)。
export interface Env {
  WEBULL_QUOTES_API_BASE?: string
  WEBULL_EVENTS_API_BASE?: string
}


// #21: Webull `x-access-token` flow (append 規約)。
// signature + 2FA token の hybrid auth (developer.webull.co.jp/apis/docs/authentication/token):
//   1. operator が Webull 公式ツールで token 発行 → PENDING
//   2. Webull モバイルアプリで 2FA SMS verify (5 min 以内) → NORMAL 化
//   3. その token 文字列を `wrangler secret put WEBULL_ACCESS_TOKEN --env=<env>` で投入
//   4. 各 client が `x-access-token` ヘッダで request に付ける
// token は signature の canonical string に **含めない** (SDK / docs 通り、x-version
// と同じく supplemental ヘッダ扱い)。15 days inactivity で INVALID 化するので、
// 期限切れ監視 / 再投入は別 issue で扱う (#21 follow-up)。テスト環境では token
// auto-NORMAL なので staging では未設定でも動くが、prod では設定漏れ → 401。
// 設定漏れ自体は fail-closed ではない (= signing だけで動く path もあるかもしれない
// ので未設定でも client は作成成功) — 401 の broker error で発覚させる方針。
export interface Env {
  WEBULL_ACCESS_TOKEN?: string
}


// Cross-cutting: deploy 環境ラベル (append 規約)。`wrangler.jsonc::env.<env>.vars`
// で各 env に **hardcode** される (= deploy artifact に焼き込まれる)。secret では
// 上書きされ得るが、その時点で operator が意図してる行為とみなす (= 偶発事故
// 防止が主目的、悪意ある書換は防げない)。`WebullTradeClient` で
// `ENVIRONMENT === 'staging'` を検知して staging からの live order を絶対に出さ
// ないために使う (Webull JP は 1 user = 1 app の制約で staging/prod で API key
// 分離できないため、コード側で trade を gate する必要がある)。
//   - dev:        'dev'        (wrangler.jsonc env.dev.vars)
//   - staging:    'staging'    (wrangler.jsonc env.staging.vars)
//   - production: 'production' (wrangler.jsonc env.production.vars)
// 'production' は省略可だが、明示することで「staging gate を抜けたら本番」
// という意図が読みやすくなる。
export interface Env {
  ENVIRONMENT?: string
}


// #21 Phase B: Webull `x-access-token` の runtime state を持つ DO (append 規約)。
// Phase A で operator が `pnpm run issue-token` で取得した token を、admin
// endpoint 経由でこの DO に seed する。cron が定期的に `WebullTokenClient.
// createToken(existingToken)` で refresh して書き戻す。WEBULL_ACCESS_TOKEN env
// (Phase A の bootstrap path) は DO seed が無い時の fallback として残し、両方
// 揃ってる場合は DO 側を優先する (= 自動 refresh が効く状態を「正」と扱う)。
import type { WebullTokenStateDO } from '../trading/state/WebullTokenStateDO'

export interface Env {
  WEBULL_TOKEN_STATE?: DurableObjectNamespace<WebullTokenStateDO>
}


// #379 / #376: first-live production readiness policy. These are not trading
// gates by themselves; they bound `/admin/production-readiness` so the operator
// gets a fail-closed preflight before deleting the production TRADING_ENABLED
// deploy gate.
export interface Env {
  FIRST_LIVE_MAX_ACTIVE_SYMBOLS?: string
  FIRST_LIVE_MAX_ORDER_NOTIONAL_USD?: string
  FIRST_LIVE_MAX_ORDER_NOTIONAL_JPY?: string
  ROLLBACK_REHEARSAL_MAX_AGE_HOURS?: string
}


// #475: quote source の切替。'webull' で Market Data API (trade host + v2、
// PR #474 で稼働実証) を primary にし、bid/ask 付き snapshot で spread guard
// (issue #411) を実数評価に戻す。JP 銘柄と Webull 障害時は Yahoo に自動
// fallback。未設定 / 他値は 'yahoo' (PR #334 以来の現行動作) — fail-safe 側が
// 既定で、切替は env の明示 opt-in のみ。
export interface Env {
  QUOTE_SOURCE?: string
}


// #475: bar source の切替 (quote の QUOTE_SOURCE と同じ規約、独立 canary 用)。
// 'webull' で Market Data API bars (trade host + v2) を primary に、^VIX
// (index) / JP 銘柄 / Webull 障害時は Yahoo に自動 fallback。未設定 / 他値は
// 'yahoo' (現行) — fail-safe 側が既定。
export interface Env {
  BAR_SOURCE?: string
}


// news attention producer (issue #196 follow-up、newsShockGate PR 1)。
// NEWS_ATTENTION_ENABLED: `newsScheduler` の opt-in flag。値が 'true'
// (大小文字問わず、前後空白 trim) のときだけ GDELT を叩く。未設定 / それ以外は
// 無効 — この repo の「未設定は安全側 default、明示 opt-in」規約 (QUOTE_SOURCE /
// BAR_SOURCE と同じ判定パターン)。
// GDELT_API_BASE: GDELT DOC 2.0 API のベース URL override (テスト用)。未設定なら
// 本番 URL (`https://api.gdeltproject.org`) を使う。
export interface Env {
  NEWS_ATTENTION_ENABLED?: string
  GDELT_API_BASE?: string
}
