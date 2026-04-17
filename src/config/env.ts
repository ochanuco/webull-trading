export interface Env {
  BASIC_AUTH_USER: string
  BASIC_AUTH_PASSWORD: string
  DRY_RUN?: string
  TRADING_ENABLED?: string
  ALLOWED_SYMBOLS: string
  MAX_ORDER_NOTIONAL: string
  EVENT_INGEST_SECRET: string
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