export interface Env {
  BASIC_AUTH_USER: string
  BASIC_AUTH_PASSWORD: string
}

export interface Env {
  DRY_RUN: string
  TRADING_ENABLED: string
  ALLOWED_SYMBOLS: string
  MAX_ORDER_NOTIONAL: string
}

export function parseBooleanEnv(value: string | undefined): boolean {
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

export function parseNumberEnv(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}
