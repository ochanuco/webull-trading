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