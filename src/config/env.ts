export interface Env {
  BASIC_AUTH_USER: string
  BASIC_AUTH_PASSWORD: string
  DRY_RUN?: string
  TRADING_ENABLED?: string
  ALLOWED_SYMBOLS: string
  MAX_ORDER_NOTIONAL: string
}

export function parseBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new Error(`Invalid boolean environment variable value: '${value}'. Expected 'true', 'false', or undefined.`)
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