import type { SymbolStateDO } from '../trading/state/SymbolStateDO'

export interface Env {
  BASIC_AUTH_USER: string
  BASIC_AUTH_PASSWORD: string
  DRY_RUN?: string
  TRADING_ENABLED?: string
  ALLOWED_SYMBOLS: string
  MAX_ORDER_NOTIONAL: string
  EVENT_INGEST_SECRET: string
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
  WEBULL_ACCOUNT_ID?: string
  WEBULL_API_BASE?: string
  /** Override the snapshot endpoint path (POC: UAT 未確定なので env で差し替え). */
  WEBULL_QUOTE_PATH?: string
}

// Trading risk config (Phase 5 append)
export interface Env {
  SYMBOL_MAX_NOTIONAL?: string
  MARKET_HOURS_CHECK?: string
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
}

function coerceRule(raw: Record<string, unknown>, symbol: string): Partial<SymbolRuleShape> {
  const out: Partial<SymbolRuleShape> = {}
  const numberKeys: Array<keyof SymbolRuleShape> = [
    'stopPct',
    'takeProfitPct',
    'timeStopDays',
    'pullbackMax',
    'pullbackMin',
  ]
  for (const key of numberKeys) {
    if (raw[key] !== undefined) {
      const value = raw[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`'${symbol}.${key}' must be a finite number`)
      }
      out[key] = value
    }
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

// Risk correlation config (Phase 2b append)
export interface Env {
  INVERSE_PAIRS?: string
}

// Spread guard config (Phase 2b #38-D append)
export interface Env {
  SPREAD_LIMIT_PCT_US?: string
  SPREAD_LIMIT_PCT_JP?: string
}

// Halt / price-band / gap config (#38-C append)
export interface Env {
  STALE_QUOTE_MS?: string
  GAP_REJECT_PCT?: string
}

// Drawdown kill switch (#38-B append)
import type { PortfolioStateDO } from '../trading/state/PortfolioStateDO'

export interface Env {
  PORTFOLIO_STATE?: DurableObjectNamespace<PortfolioStateDO>
  /**
   * Daily drawdown kill threshold, as a fraction of day-start equity. Parsed as
   * a negative float (e.g. `"-0.02"`). Default -0.02 when unset or malformed.
   */
  DRAWDOWN_KILL_THRESHOLD?: string
}

// Bridge container binding (#33 append)
import type { BridgeContainer } from '../trading/bridge/BridgeContainer'

export interface Env {
  BRIDGE?: DurableObjectNamespace<BridgeContainer>
  WEBULL_GRPC_ENDPOINT?: string
  EVENT_INGEST_URL?: string
  /**
   * Bridge lifecycle policy — see {@link BridgeRunMode} (`always-on` /
   * `disabled` / `auto`). 省略時は `auto`: 平日 UTC のみ起動。
   */
  BRIDGE_RUN_MODE?: string
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