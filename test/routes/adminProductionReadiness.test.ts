import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app'
import type { Env } from '../../src/config/env'
import { loadGlobalConfigFrom } from '../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../src/infrastructure/db/symbolUniverse'
import { createDb } from '../../src/infrastructure/db/tradeJournalRepo'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../helpers/configFixtures'

vi.mock('../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))
vi.mock('../../src/infrastructure/db/tradeJournalRepo', () => ({
  createDb: vi.fn(),
}))

const authEnv = {
  ACCESS_DEV_BYPASS_USER: 'admin',
  SYMBOL_STATE: {} as Env['SYMBOL_STATE'],
  ENVIRONMENT: 'production',
  TRADING_ENABLED: 'false',
  WEBULL_APP_KEY: 'app-key',
  WEBULL_APP_SECRET: 'app-secret',
  WEBULL_ACCOUNT_ID_JP_CASH: 'account',
  CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud',
  DB: {} as D1Database,
}

function fakeTokenNamespace() {
  const stub = {
    async getState() {
      return {
        token: 'tok_live_1234567890',
        expires: 1_800_000_000,
        status: 'NORMAL',
        fetchedAt: '2026-06-01T00:00:00.000Z',
        lastAttemptAt: '2026-06-01T00:00:00.000Z',
        lastSuccessAt: '2026-06-01T00:00:00.000Z',
      }
    },
  }
  return {
    idFromName: () => 'id',
    get: () => stub,
  } as unknown as Env['WEBULL_TOKEN_STATE']
}

function fakeToggleHistory() {
  const query = {
    from: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => [{ timestamp: '2026-06-01T00:00:00.000Z', reason: 'rehearsal' }]),
  }
  return { select: vi.fn(() => query) }
}

describe('GET /admin/production-readiness', () => {
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
      makeSymbolUniverse({ allowedSymbols: ['SOXL'], symbolMaxNotional: { SOXL: 250 } }),
    )
    vi.mocked(createDb).mockReturnValue(fakeToggleHistory() as never)
  })

  afterEach(() => vi.resetAllMocks())

  it('401s without Access JWT or dev bypass', async () => {
    const app = createApp()
    const res = await app.request('/admin/production-readiness', {}, {
      SYMBOL_STATE: {} as Env['SYMBOL_STATE'],
    })
    expect(res.status).toBe(401)
  })

  it('returns no-store JSON readiness report', async () => {
    const app = createApp()
    const res = await app.request('/admin/production-readiness', {}, {
      ...authEnv,
      CF_ACCESS_TEAM_DOMAIN: undefined,
      CF_ACCESS_AUD: undefined,
      WEBULL_TOKEN_STATE: fakeTokenNamespace(),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = (await res.json()) as {
      ready: boolean
      checks: Array<{ id: string; severity: string }>
      state: { tokenSource: string; envOverrideActive: boolean }
    }
    expect(body.ready).toBe(false)
    expect(body.state.tokenSource).toBe('do_normal')
    expect(body.state.envOverrideActive).toBe(true)
    expect(body.checks.find((check) => check.id === 'deploy_gate_staged')?.severity).toBe('pass')
    expect(body.checks.find((check) => check.id === 'cloudflare_access')?.severity).toBe('fail')
  })
})
