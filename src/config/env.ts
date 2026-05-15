import type { SymbolStateDO } from '../trading/state/SymbolStateDO'

export interface Env {
  /**
   * Cloudflare Access team domain (e.g. `https://<team>.cloudflareaccess.com`).
   * Verified via JWKS at `<team>/cdn-cgi/access/certs`. Required for the
   * Access middleware to attempt verification; if unset *and*
   * `ACCESS_DEV_BYPASS_USER` is set, the middleware operates in local dev
   * bypass mode (see `src/middleware/accessJwt.ts`).
   */
  CF_ACCESS_TEAM_DOMAIN?: string
  /** Cloudflare Access application AUD tag (required claim match). */
  CF_ACCESS_AUD?: string
  /**
   * Local-dev only: when set AND `CF_ACCESS_TEAM_DOMAIN` is unset, the
   * Access middleware skips JWT verification and stamps this string as the
   * actor on every request. Production must NEVER set this (and is protected
   * by the team-domain check anyway).
   */
  ACCESS_DEV_BYPASS_USER?: string
  SYMBOL_STATE: DurableObjectNamespace<SymbolStateDO>
}

/**
 * Parses a string environment variable as a boolean.
 * Only the exact string `"true"` is truthy; everything else (including undefined) falls back to
 * `defaultValue`.  This ensures fail-closed behaviour: callers that omit the env var get the
 * safe default rather than `false` for a DRY_RUN guard or `true` for a TRADING_ENABLED gate.
 */
export function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue
  }
  return value === 'true'
}

export function parseCsvEnv(value: string | undefined): string[] {
  if (!value) {
    return []
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function parseNumberEnv(value: string | undefined, key?: string): number {
  if (value === undefined) {
    throw new Error(`Environment variable ${key ? `'${key}' ` : ''}is undefined`)
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key ? `'${key}' ` : ''}has invalid number value: '${value}'`)
  }

  return parsed
}

// Webull broker config (Phase 2 append)
export interface Env {
  WEBULL_APP_KEY?: string
  WEBULL_APP_SECRET?: string
  WEBULL_ACCOUNT_ID_JP_CASH?: string
  WEBULL_API_BASE?: string
  /** Override the snapshot endpoint path (POC: UAT 未確定なので env で差し替え). */
  WEBULL_QUOTE_PATH?: string
}


// Pullback strategy per-symbol rule overrides (Phase 2c append)
export interface Env {
  SYMBOL_RULES?: string
}

let didWarnInvalidSymbolNotionalMap = false

export function parseSymbolNotionalMap(value: string | undefined): Record<string, number> {
  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('value must be an object')
    }

    const result: Record<string, number> = {}

    for (const [symbol, limit] of Object.entries(parsed)) {
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        throw new Error(`symbol '${symbol}' has invalid notional limit`)
      }

      result[symbol.toUpperCase()] = limit
    }

    return result
  } catch {
    if (!didWarnInvalidSymbolNotionalMap) {
      didWarnInvalidSymbolNotionalMap = true
      console.warn('Invalid SYMBOL_MAX_NOTIONAL value; using empty symbol max notional map')
    }

    return {}
  }
}

let didWarnInvalidSymbolRules = false

/**
 * Parses SYMBOL_RULES JSON into a per-symbol PullbackUptrendStrategy rule map.
 * Keys are symbols, values are partial overrides of SymbolRule. Missing fields
 * fall through to DEFAULT_RULE at strategy level. Returns `{}` on any error so
 * a typo in one env entry cannot wedge the whole symbol universe.
 *
 * Example: `{"SOXL":{"stopPct":-0.03,"timeStopDays":5}}`
 */
export function parseSymbolRulesMap(
  value: string | undefined,
): Record<string, Partial<SymbolRuleShape>> {
  if (!value) return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('value must be an object')
    }

    const result: Record<string, Partial<SymbolRuleShape>> = {}
    for (const [symbol, rule] of Object.entries(parsed)) {
      if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
        throw new Error(`rule for '${symbol}' must be an object`)
      }
      result[symbol.toUpperCase()] = coerceRule(rule as Record<string, unknown>, symbol)
    }
    return result
  } catch (error) {
    if (!didWarnInvalidSymbolRules) {
      didWarnInvalidSymbolRules = true
      console.warn(
        `Invalid SYMBOL_RULES value; using empty rules: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return {}
  }
}

interface SymbolRuleShape {
  stopPct: number
  takeProfitPct: number
  timeStopDays: number
  pullbackMax: number
  pullbackMin: number
  /** Minimum 50d return to treat the stock as in-uptrend. See SymbolRule. */
  minReturn50d: number
  /** If true, entry requires price > 50d SMA. See SymbolRule. */
  requireAboveSma50: boolean
}

function coerceRule(raw: Record<string, unknown>, symbol: string): Partial<SymbolRuleShape> {
  const out: Partial<SymbolRuleShape> = {}
  const numberKeys: Array<keyof SymbolRuleShape> = [
    'stopPct',
    'takeProfitPct',
    'timeStopDays',
    'pullbackMax',
    'pullbackMin',
    'minReturn50d',
  ]
  for (const key of numberKeys) {
    if (raw[key] !== undefined) {
      const value = raw[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`'${symbol}.${key}' must be a finite number`)
      }
      ;(out[key] as number) = value
    }
  }
  if (raw.requireAboveSma50 !== undefined) {
    if (typeof raw.requireAboveSma50 !== 'boolean') {
      throw new Error(`'${symbol}.requireAboveSma50' must be a boolean`)
    }
    out.requireAboveSma50 = raw.requireAboveSma50
  }
  return out
}

let didWarnInvalidInversePairs = false

/**
 * Parses INVERSE_PAIRS JSON into a bidirectional pair lookup. An inverse pair
 * is two symbols whose prices are structurally anti-correlated (e.g. SOXL/SOXS).
 * Holding both at once is a P&L decay trap, not a hedge, so the correlation
 * gate must reject BUY X while any position in its inverse exists.
 *
 * Accepts either a map `{"SOXL":"SOXS"}` (expanded to both directions) or an
 * already-bidirectional map. Fails closed (empty result) on any malformed entry.
 */
export function parseInversePairs(value: string | undefined): Record<string, string> {
  if (!value) return {}

  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('value must be an object')
    }

    const result: Record<string, string> = {}
    for (const [left, right] of Object.entries(parsed)) {
      if (typeof right !== 'string' || right.trim().length === 0) {
        throw new Error(`inverse pair for '${left}' must be a non-empty string`)
      }
      const leftKey = left.toUpperCase()
      const rightKey = right.toUpperCase()
      if (leftKey === rightKey) {
        throw new Error(`inverse pair '${leftKey}' cannot reference itself`)
      }
      result[leftKey] = rightKey
      // Expand to both directions so a caller only needs to write the map once.
      if (result[rightKey] === undefined) {
        result[rightKey] = leftKey
      }
    }
    return result
  } catch (error) {
    if (!didWarnInvalidInversePairs) {
      didWarnInvalidInversePairs = true
      console.warn(
        `Invalid INVERSE_PAIRS value; using empty pairs: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return {}
  }
}

// PortfolioStateDO binding (#38-B)
import type { PortfolioStateDO } from '../trading/state/PortfolioStateDO'

export interface Env {
  PORTFOLIO_STATE?: DurableObjectNamespace<PortfolioStateDO>
}

/**
 * Parses an optional numeric env var into a non-negative finite number. Returns
 * `undefined` when the var is unset or empty so callers can fall back to a
 * safe default. Invalid or negative values warn once and return `undefined` —
 * a typo in a risk limit must not silently widen the limit.
 */
const didWarnInvalidNonNegative: Record<string, boolean> = {}
export function parseOptionalNonNegativeNumberEnv(
  value: string | undefined,
  key: string,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined

  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    if (!didWarnInvalidNonNegative[key]) {
      didWarnInvalidNonNegative[key] = true
      console.warn(`Invalid ${key} value '${value}'; using safe default`)
    }
    return undefined
  }
  return parsed
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

const DEFAULT_DRAWDOWN_KILL_THRESHOLD = -0.02

/**
 * Parses DRAWDOWN_KILL_THRESHOLD. Must be a finite negative number; anything
 * else falls back to the default so a typo cannot silently disarm the kill.
 */
export function parseDrawdownKillThreshold(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DRAWDOWN_KILL_THRESHOLD
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed >= 0) {
    console.warn(
      `Invalid DRAWDOWN_KILL_THRESHOLD '${value}'; using default ${DEFAULT_DRAWDOWN_KILL_THRESHOLD}`,
    )
    return DEFAULT_DRAWDOWN_KILL_THRESHOLD
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
// のみ / `/` で始まらない値は fallback (絶対 URL 注入で WEBULL_API_BASE を
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
