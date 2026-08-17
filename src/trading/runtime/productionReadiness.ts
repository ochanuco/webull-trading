import { desc } from 'drizzle-orm'
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { tradingToggleHistory } from '../../infrastructure/db/schema'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { resolveAccessTokenWithSource } from '../../infrastructure/webull/resolveAccessToken'
import { WebullTokenStateClient } from '../state/WebullTokenStateClient'
import { resolveTradingEnabled } from './killSwitch'

type ReadinessSeverity = 'pass' | 'warn' | 'fail'

interface ProductionReadinessCheck {
  id: string
  severity: ReadinessSeverity
  message: string
  details?: Record<string, unknown>
}

interface ProductionReadinessPolicy {
  maxActiveSymbols: number
  maxOrderNotionalUsd: number
  maxOrderNotionalJpy: number
  rollbackRehearsalMaxAgeHours: number
}

export interface ProductionReadinessReport {
  timestamp: string
  ready: boolean
  policy: ProductionReadinessPolicy
  state: {
    environment: string | null
    dryRun: boolean | null
    dbTradingEnabled: boolean | null
    effectiveTradingEnabled: boolean | null
    envTradingEnabledRaw: string | null
    envOverrideActive: boolean | null
    activeSymbols: string[]
    maxOrderNotionalUsd: number | null
    maxOrderNotionalJpy: number | null
    marketHoursCheck: boolean | null
    tokenSource: string | null
    tokenStatus: string | null
    tokenExpires: number | null
    lastRollbackRehearsalAt: string | null
  }
  checks: ProductionReadinessCheck[]
}

const DEFAULT_POLICY: ProductionReadinessPolicy = Object.freeze({
  maxActiveSymbols: 2,
  maxOrderNotionalUsd: 500,
  maxOrderNotionalJpy: 100_000,
  rollbackRehearsalMaxAgeHours: 72,
})

function parseProductionReadinessPolicy(env: Env): ProductionReadinessPolicy {
  return {
    maxActiveSymbols: parsePositiveInt(env.FIRST_LIVE_MAX_ACTIVE_SYMBOLS, DEFAULT_POLICY.maxActiveSymbols),
    maxOrderNotionalUsd: parsePositiveNumber(
      env.FIRST_LIVE_MAX_ORDER_NOTIONAL_USD,
      DEFAULT_POLICY.maxOrderNotionalUsd,
    ),
    maxOrderNotionalJpy: parsePositiveNumber(
      env.FIRST_LIVE_MAX_ORDER_NOTIONAL_JPY,
      DEFAULT_POLICY.maxOrderNotionalJpy,
    ),
    rollbackRehearsalMaxAgeHours: parsePositiveNumber(
      env.ROLLBACK_REHEARSAL_MAX_AGE_HOURS,
      DEFAULT_POLICY.rollbackRehearsalMaxAgeHours,
    ),
  }
}

export async function collectProductionReadiness(
  env: Env,
  requestId?: string,
  now: Date = new Date(),
): Promise<ProductionReadinessReport> {
  const policy = parseProductionReadinessPolicy(env)
  const checks: ProductionReadinessCheck[] = []
  const label = normalizeOptional(env.ENVIRONMENT)
  const envTradingRaw = env.TRADING_ENABLED ?? null
  const globalResult = await loadOptional('global_config', () => loadGlobalConfigFrom(env, requestId))
  const universeResult = await loadOptional('symbol_universe', () => loadSymbolUniverse(env))
  const tokenResult = await resolveAccessTokenWithSource(env)
  const tokenState = await loadTokenState(env)
  const rollbackRehearsal = await loadLatestRollbackRehearsal(env)

  if (!globalResult.ok) {
    checks.push({
      id: 'global_config_load',
      severity: 'fail',
      message: 'global_config could not be loaded from production D1',
      details: { error: globalResult.error },
    })
  }
  if (!universeResult.ok) {
    checks.push({
      id: 'symbol_universe_load',
      severity: 'fail',
      message: 'symbol universe could not be loaded from production D1',
      details: { error: universeResult.error },
    })
  }

  const global = globalResult.ok ? globalResult.value : null
  const universe = universeResult.ok ? universeResult.value : null
  const effectiveTrading = global
    ? resolveTradingEnabled(global.tradingEnabled, env.TRADING_ENABLED)
    : null
  const envOverrideActive = global ? effectiveTrading !== global.tradingEnabled : null

  pushCheck(checks, {
    id: 'environment_label',
    ok: label === 'production',
    failMessage: 'ENVIRONMENT must be production before live trading can be enabled',
    passMessage: 'ENVIRONMENT is production',
    details: { environment: label },
  })

  pushCheck(checks, {
    id: 'deploy_gate_staged',
    ok: env.TRADING_ENABLED === 'false',
    failMessage: 'TRADING_ENABLED=false should remain set until the final live enablement step',
    passMessage: 'TRADING_ENABLED=false deploy gate is still blocking live orders',
    details: { raw: envTradingRaw, effectiveTradingEnabled: effectiveTrading },
  })

  if (global) {
    pushCheck(checks, {
      id: 'dry_run_staged_off',
      ok: global.dryRun === false,
      failMessage: 'D1 dryRun should be false only after the operator intentionally stages live enablement',
      passMessage: 'D1 dryRun=false is staged',
      details: { dryRun: global.dryRun },
    })
    pushCheck(checks, {
      id: 'db_trading_enabled_staged_on',
      ok: global.tradingEnabled === true,
      failMessage: 'D1 trading_enabled should be true before deleting the deploy gate',
      passMessage: 'D1 trading_enabled=true is staged',
      details: { dbTradingEnabled: global.tradingEnabled, effectiveTradingEnabled: effectiveTrading },
    })
    pushCheck(checks, {
      id: 'market_hours_check',
      ok: global.marketHoursCheck === true,
      failMessage: 'marketHoursCheck must be enabled before live trading',
      passMessage: 'marketHoursCheck is enabled',
    })
    pushCheck(checks, {
      id: 'max_order_notional_usd',
      ok: global.maxOrderNotionalUsd <= policy.maxOrderNotionalUsd,
      failMessage: 'USD max order notional exceeds first-live policy',
      passMessage: 'USD max order notional is within first-live policy',
      details: { configured: global.maxOrderNotionalUsd, limit: policy.maxOrderNotionalUsd },
    })
    pushCheck(checks, {
      id: 'max_order_notional_jpy',
      ok: global.maxOrderNotionalJpy <= policy.maxOrderNotionalJpy,
      failMessage: 'JPY max order notional exceeds first-live policy',
      passMessage: 'JPY max order notional is within first-live policy',
      details: { configured: global.maxOrderNotionalJpy, limit: policy.maxOrderNotionalJpy },
    })
  }

  if (universe) {
    pushCheck(checks, {
      id: 'active_symbol_count',
      ok: universe.allowedSymbols.length > 0 && universe.allowedSymbols.length <= policy.maxActiveSymbols,
      failMessage: 'active symbol universe must be narrow for first live enablement',
      passMessage: 'active symbol universe is narrow for first live enablement',
      details: { activeSymbols: universe.allowedSymbols, limit: policy.maxActiveSymbols },
    })
    const oversizedSymbolCaps = Object.entries(universe.symbolMaxNotional).filter(([symbol, limit]) => {
      const currency = universe.symbolCurrency[symbol] ?? 'USD'
      return limit > (currency === 'JPY' ? policy.maxOrderNotionalJpy : policy.maxOrderNotionalUsd)
    })
    pushCheck(checks, {
      id: 'per_symbol_notional_caps',
      ok: oversizedSymbolCaps.length === 0,
      failMessage: 'one or more per-symbol notional caps exceed first-live policy',
      passMessage: 'per-symbol notional caps are within first-live policy',
      details: { oversized: oversizedSymbolCaps },
    })
  }

  pushCheck(checks, {
    id: 'webull_credentials',
    ok: hasTrimmed(env.WEBULL_APP_KEY) &&
      hasTrimmed(env.WEBULL_APP_SECRET) &&
      hasTrimmed(env.WEBULL_ACCOUNT_ID_JP_CASH),
    failMessage: 'Webull app key, app secret, and JP cash account ID must all be configured',
    passMessage: 'Webull credential bindings are present',
    details: {
      appKeyPresent: hasTrimmed(env.WEBULL_APP_KEY),
      appSecretPresent: hasTrimmed(env.WEBULL_APP_SECRET),
      accountIdPresent: hasTrimmed(env.WEBULL_ACCOUNT_ID_JP_CASH),
    },
  })

  pushCheck(checks, {
    id: 'webull_token_source',
    ok: tokenResult.source === 'do_normal',
    failMessage: 'Webull token must resolve from WEBULL_TOKEN_STATE with NORMAL status',
    passMessage: 'Webull token resolves from DO with NORMAL status',
    details: { source: tokenResult.source, doStatus: tokenResult.doStatus ?? null },
  })

  pushCheck(checks, {
    id: 'cloudflare_access',
    ok: hasTrimmed(env.CF_ACCESS_TEAM_DOMAIN) && hasTrimmed(env.CF_ACCESS_AUD),
    failMessage: 'Cloudflare Access team domain and AUD must be configured',
    passMessage: 'Cloudflare Access config is present',
    details: {
      teamDomainPresent: hasTrimmed(env.CF_ACCESS_TEAM_DOMAIN),
      audPresent: hasTrimmed(env.CF_ACCESS_AUD),
    },
  })
  pushCheck(checks, {
    id: 'dev_bypass_absent',
    ok: label !== 'production' || !hasTrimmed(env.ACCESS_DEV_BYPASS_USER),
    failMessage: 'ACCESS_DEV_BYPASS_USER must not be set in production',
    passMessage: 'production dev bypass secret is absent',
  })

  const rehearsalFresh = isRecentIso(
    rollbackRehearsal.timestamp,
    now,
    policy.rollbackRehearsalMaxAgeHours,
  )
  checks.push({
    id: 'rollback_rehearsal',
    severity: rehearsalFresh ? 'pass' : 'warn',
    message: rehearsalFresh
      ? 'recent rollback/kill-switch rehearsal is recorded'
      : 'no recent rollback rehearsal was found; rehearse rollback before first live trade',
    details: {
      lastRollbackRehearsalAt: rollbackRehearsal.timestamp,
      reason: rollbackRehearsal.reason,
      maxAgeHours: policy.rollbackRehearsalMaxAgeHours,
    },
  })

  checks.push({
    id: 'broker_probe',
    severity: 'warn',
    message: 'run /admin/broker/probe immediately before deleting TRADING_ENABLED',
    details: {
      expected: 'positions/order history endpoints return 200 and token source is do_normal',
    },
  })

  return {
    timestamp: now.toISOString(),
    ready: checks.every((check) => check.severity !== 'fail'),
    policy,
    state: {
      environment: label,
      dryRun: global?.dryRun ?? null,
      dbTradingEnabled: global?.tradingEnabled ?? null,
      effectiveTradingEnabled: effectiveTrading,
      envTradingEnabledRaw: envTradingRaw,
      envOverrideActive,
      activeSymbols: universe?.allowedSymbols ?? [],
      maxOrderNotionalUsd: global?.maxOrderNotionalUsd ?? null,
      maxOrderNotionalJpy: global?.maxOrderNotionalJpy ?? null,
      marketHoursCheck: global?.marketHoursCheck ?? null,
      tokenSource: tokenResult.source,
      tokenStatus: tokenState?.status ?? tokenResult.doStatus ?? null,
      tokenExpires: tokenState?.expires ?? null,
      lastRollbackRehearsalAt: rollbackRehearsal.timestamp,
    },
    checks,
  }
}

async function loadOptional<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; id: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, id, error: error instanceof Error ? error.message : String(error) }
  }
}

async function loadTokenState(env: Env) {
  if (!env.WEBULL_TOKEN_STATE) return null
  try {
    return await new WebullTokenStateClient(env.WEBULL_TOKEN_STATE).getState()
  } catch {
    return null
  }
}

async function loadLatestRollbackRehearsal(env: Env): Promise<{
  timestamp: string | null
  reason: string | null
}> {
  if (!env.DB) return { timestamp: null, reason: null }
  try {
    const db = createDb(env.DB)
    const rows = await db
      .select({
        timestamp: tradingToggleHistory.timestamp,
        reason: tradingToggleHistory.reason,
      })
      .from(tradingToggleHistory)
      .orderBy(desc(tradingToggleHistory.timestamp))
      .limit(1)
    const row = rows[0]
    return { timestamp: row?.timestamp ?? null, reason: row?.reason ?? null }
  } catch {
    return { timestamp: null, reason: null }
  }
}

function pushCheck(
  checks: ProductionReadinessCheck[],
  input: {
    id: string
    ok: boolean
    passMessage: string
    failMessage: string
    details?: Record<string, unknown>
  },
): void {
  checks.push({
    id: input.id,
    severity: input.ok ? 'pass' : 'fail',
    message: input.ok ? input.passMessage : input.failMessage,
    ...(input.details ? { details: input.details } : {}),
  })
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

function hasTrimmed(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(value, fallback)
  return Math.max(1, Math.floor(parsed))
}

function isRecentIso(value: string | null, now: Date, maxAgeHours: number): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return false
  return now.getTime() - timestamp <= maxAgeHours * 60 * 60 * 1000
}
