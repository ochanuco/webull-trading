import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectProductionReadiness } from '../../../src/trading/runtime/productionReadiness'
import type { Env } from '../../../src/config/env'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../../src/infrastructure/db/tradeJournalRepo'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../../helpers/configFixtures'

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

function fakeTokenNamespace(status: 'NORMAL' | 'INVALID' = 'NORMAL') {
  const stub = {
    async getState() {
      return {
        token: status === 'NORMAL' ? 'tok_live_1234567890' : '',
        expires: 1_800_000_000,
        status,
        fetchedAt: '2026-06-01T00:00:00.000Z',
        lastAttemptAt: '2026-06-01T00:00:00.000Z',
        lastSuccessAt: status === 'NORMAL' ? '2026-06-01T00:00:00.000Z' : null,
      }
    },
  }
  return {
    idFromName: () => 'id',
    get: () => stub,
  } as unknown as Env['WEBULL_TOKEN_STATE']
}

function fakeToggleHistory(timestamp: string | null) {
  const query = {
    from: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => timestamp ? [{ timestamp, reason: 'rollback rehearsal' }] : []),
  }
  return { select: vi.fn(() => query) }
}

describe('collectProductionReadiness', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({
        dryRun: false,
        tradingEnabled: true,
        marketHoursCheck: true,
        maxOrderNotionalUsd: 250,
        maxOrderNotionalJpy: 50_000,
      }),
    )
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['SOXL'],
        symbolMaxNotional: { SOXL: 250 },
        symbolCurrency: { SOXL: 'USD' },
      }),
    )
    vi.mocked(createDb).mockReturnValue(fakeToggleHistory('2026-05-31T00:00:00.000Z') as never)
  })

  afterEach(() => vi.resetAllMocks())

  it('passes the first-live preflight when all hard gates are staged safely', async () => {
    const report = await collectProductionReadiness(
      {
        SYMBOL_STATE: {} as Env['SYMBOL_STATE'],
        ENVIRONMENT: 'production',
        TRADING_ENABLED: 'false',
        WEBULL_APP_KEY: 'app-key',
        WEBULL_APP_SECRET: 'app-secret',
        WEBULL_ACCOUNT_ID_JP_CASH: 'account',
        CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
        CF_ACCESS_AUD: 'aud',
        WEBULL_TOKEN_STATE: fakeTokenNamespace(),
        DB: {} as D1Database,
      } as Env,
      'req-1',
      new Date('2026-06-01T00:00:00.000Z'),
    )

    expect(report.ready).toBe(true)
    expect(report.checks.filter((check) => check.severity === 'fail')).toEqual([])
    expect(report.state.effectiveTradingEnabled).toBe(false)
    expect(report.state.envOverrideActive).toBe(true)
    expect(report.state.tokenSource).toBe('do_normal')
  })

  it('fails when the live deploy gate is already removed before preflight', async () => {
    const report = await collectProductionReadiness(
      {
        SYMBOL_STATE: {} as Env['SYMBOL_STATE'],
        ENVIRONMENT: 'production',
        WEBULL_APP_KEY: 'app-key',
        WEBULL_APP_SECRET: 'app-secret',
        WEBULL_ACCOUNT_ID_JP_CASH: 'account',
        CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
        CF_ACCESS_AUD: 'aud',
        WEBULL_TOKEN_STATE: fakeTokenNamespace(),
        DB: {} as D1Database,
      } as Env,
      'req-2',
      new Date('2026-06-01T00:00:00.000Z'),
    )

    expect(report.ready).toBe(false)
    expect(report.checks.find((check) => check.id === 'deploy_gate_staged')?.severity).toBe('fail')
    expect(report.state.effectiveTradingEnabled).toBe(true)
  })

  it('fails on wide universe, oversized limits, missing Access, and non-DO token', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({
        dryRun: false,
        tradingEnabled: true,
        marketHoursCheck: true,
        maxOrderNotionalUsd: 2_000,
      }),
    )
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({ allowedSymbols: ['SOXL', 'SOXS', 'QQQ'] }),
    )

    const report = await collectProductionReadiness(
      {
        SYMBOL_STATE: {} as Env['SYMBOL_STATE'],
        ENVIRONMENT: 'production',
        TRADING_ENABLED: 'false',
        WEBULL_APP_KEY: 'app-key',
        WEBULL_APP_SECRET: 'app-secret',
        WEBULL_ACCOUNT_ID_JP_CASH: 'account',
        WEBULL_ACCESS_TOKEN: 'env-fallback-token',
        ACCESS_DEV_BYPASS_USER: 'admin',
        DB: {} as D1Database,
      } as Env,
      'req-3',
      new Date('2026-06-01T00:00:00.000Z'),
    )

    const failed = report.checks.filter((check) => check.severity === 'fail').map((check) => check.id)
    expect(failed).toEqual(expect.arrayContaining([
      'max_order_notional_usd',
      'active_symbol_count',
      'webull_token_source',
      'cloudflare_access',
      'dev_bypass_absent',
    ]))
  })
})
