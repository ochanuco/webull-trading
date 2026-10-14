import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/d1'
import { createApp } from '../../src/app'
import { insertBacktestRun } from '../../src/infrastructure/db/strategyModelRepo'
import type { ReplayMetrics } from '../../src/trading/models/replay'
import type { DailyBar } from '../../src/trading/strategy/indicators'
import { sqliteD1 } from '../helpers/sqliteD1'

const getDailyBars = vi.fn<(symbol: string, lookback: number) => Promise<DailyBar[]>>()

vi.mock('../../src/infrastructure/quotes/YahooBarClient', async () => {
  const actual = await vi.importActual<typeof import('../../src/infrastructure/quotes/YahooBarClient')>(
    '../../src/infrastructure/quotes/YahooBarClient',
  )
  return {
    ...actual,
    YahooBarClient: class {
      getDailyBars(symbol: string, lookback: number) {
        return getDailyBars(symbol, lookback)
      }
    },
  }
})

const PARAMS = {
  stopPct: -0.04,
  takeProfitPct: 0.05,
  timeStopDays: 10,
  pullbackMax: -0.01,
  pullbackMin: -0.12,
  minReturn50d: -1,
  requireAboveSma50: false,
  kAtr: 2,
  maxSma50DeviationPct: 5,
  maxAtrRatio: 100,
  maxStopToTpRatio: 0,
  atrBaselineMode: 'percentile',
}

const GOOD_METRICS: ReplayMetrics = {
  totalReturn: 0.15,
  sharpeRatio: 1.3,
  maxDrawdownPct: -0.09,
  totalTrades: 40,
  winRate: 0.55,
  profitFactor: 1.7,
  avgTradeReturn: 0.012,
  avgHoldingDays: 5,
  exitReasons: { TP: 20, STOP: 12, TIME_STOP: 8, END_OF_DATA: 0 },
  pnlByCurrency: { USD: 1500, JPY: 0 },
}

function syntheticBars(count: number): DailyBar[] {
  const out: DailyBar[] = []
  const d = new Date('2025-01-01T00:00:00.000Z')
  let i = 0
  while (out.length < count) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const close = 100 * 1.003 ** i * (1 + 0.05 * Math.sin(i / 3))
      out.push({ date: d.toISOString().slice(0, 10), open: close, high: close * 1.01, low: close * 0.99, close })
      i += 1
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

let d1: D1Database
let sqlite: DatabaseSync

function env(overrides: Record<string, unknown> = {}) {
  return { ACCESS_DEV_BYPASS_USER: 'admin', DB: d1, ENVIRONMENT: 'production', ...overrides } as never
}

async function call(path: string, init: { method?: string; body?: unknown } = {}, envOverrides = {}) {
  const app = createApp()
  const res = await app.request(
    path,
    {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    env(envOverrides),
  )
  return { status: res.status, json: (await res.json()) as Record<string, any> }
}

async function register(params: Record<string, unknown> = PARAMS, label = 'model') {
  const res = await call('/admin/models', { method: 'POST', body: { kind: 'pullback_uptrend', params, label } })
  return res.json.model.id as number
}

async function seedGoodOosRun(modelId: number) {
  await insertBacktestRun(drizzle(d1), {
    modelId,
    purpose: 'out_of_sample',
    symbols: ['SOXL'],
    fromDate: '2025-06-01',
    toDate: '2025-12-31',
    initialCashUsd: 10_000,
    initialCashJpy: 1_500_000,
    barSource: 'yahoo',
    metrics: GOOD_METRICS,
    perSymbol: [{ symbol: 'SOXL', barCount: 200, metrics: GOOD_METRICS }],
    actor: 'admin',
    requestId: null,
    now: new Date(),
  })
}

function globalRow(): Record<string, unknown> {
  return sqlite.prepare(`SELECT * FROM global_config WHERE id = 'default'`).get() as Record<string, unknown>
}

beforeEach(() => {
  const created = sqliteD1()
  d1 = created.d1
  sqlite = created.sqlite
  sqlite.exec(`INSERT INTO global_config (id, dry_run, trading_enabled, updated_at) VALUES ('default', 1, 0, '2026-01-01T00:00:00.000Z')`)
  getDailyBars.mockReset()
  getDailyBars.mockResolvedValue(syntheticBars(320))
})

describe('POST /admin/models', () => {
  it('registers a model and dedupes identical params', async () => {
    const first = await call('/admin/models', { method: 'POST', body: { kind: 'pullback_uptrend', params: PARAMS, label: 'v1' } })
    const again = await call('/admin/models', { method: 'POST', body: { kind: 'pullback_uptrend', params: PARAMS, label: 'v1b' } })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.json.model.id).toBe(first.json.model.id)
  })

  it('registers the live global_config params as a baseline model', async () => {
    const res = await call('/admin/models', { method: 'POST', body: { fromGlobalConfig: true, label: 'baseline' } })
    expect(res.status).toBe(201)
    expect(res.json.model.spec.params.kAtr).toBe(globalRow().pullback_default_k_atr)
  })

  it('400s on invalid params with the offending field', async () => {
    const res = await call('/admin/models', {
      method: 'POST',
      body: { kind: 'pullback_uptrend', params: { ...PARAMS, stopPct: 0.1 }, label: 'bad' },
    })
    expect(res.status).toBe(400)
    expect(res.json.field).toBe('stopPct')
  })

  it('401s without Access auth', async () => {
    const res = await call(
      '/admin/models',
      { method: 'POST', body: { kind: 'pullback_uptrend', params: PARAMS, label: 'v1' } },
      { ACCESS_DEV_BYPASS_USER: undefined },
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /admin/models/:id/backtest', () => {
  it('replays the model and records the run as gate evidence', async () => {
    const id = await register()
    const res = await call(`/admin/models/${id}/backtest`, {
      method: 'POST',
      body: { purpose: 'out_of_sample', from: '2025-04-01', to: '2025-12-31', symbols: ['soxl'] },
    })
    expect(res.status).toBe(201)
    expect(res.json.run.symbols).toEqual(['SOXL'])
    expect(res.json.run.metrics.totalTrades).toBeGreaterThan(0)
    expect(res.json.equityCurve.length).toBeGreaterThan(0)
    const detail = await call(`/admin/models/${id}`)
    expect(detail.json.runs).toHaveLength(1)
  })

  it('400s when no symbol has bars in the window', async () => {
    const id = await register()
    const res = await call(`/admin/models/${id}/backtest`, {
      method: 'POST',
      body: { purpose: 'out_of_sample', from: '2026-09-01', to: '2026-09-30', symbols: ['SOXL'] },
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /admin/models/:id/promote', () => {
  it('409s when the gate has no evidence, leaving global_config untouched', async () => {
    const id = await register()
    const before = globalRow()
    const res = await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'try', confirm: true } })
    expect(res.status).toBe(409)
    expect(res.json.error).toBe('promotion_gate_failed')
    expect(globalRow()).toEqual(before)
  })

  it('adopts the live global_config as a baseline without evidence, since nothing changes', async () => {
    const baseline = await call('/admin/models', { method: 'POST', body: { fromGlobalConfig: true, label: 'baseline' } })
    const before = globalRow()
    const res = await call(`/admin/models/${baseline.json.model.id}/promote`, {
      method: 'POST',
      body: { reason: 'track current settings', confirm: true },
    })
    expect(res.status).toBe(200)
    expect(res.json.deployment.reason).toBe('[adopt] track current settings')
    expect(res.json.gate.passed).toBe(false)
    const { updated_at: _a, ...afterRest } = globalRow()
    const { updated_at: _b, ...beforeRest } = before
    expect(afterRest).toEqual(beforeRest)
  })

  it('400s without explicit confirm', async () => {
    const id = await register()
    const res = await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'try' } })
    expect(res.status).toBe(400)
  })

  it('promotes a model that passes the gate: global_config, history and audit log', async () => {
    const id = await register()
    await seedGoodOosRun(id)
    const res = await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'OOS ok', confirm: true } })
    expect(res.status).toBe(200)
    expect(res.json.deployment.env).toBe('production')
    const row = globalRow()
    expect(row.pullback_default_take_profit_pct).toBe(0.05)
    expect(row.dry_run).toBe(1)
    expect(row.trading_enabled).toBe(0)
    const audit = sqlite.prepare(`SELECT * FROM config_audit_log WHERE endpoint = '/admin/models/:id/promote'`).all()
    expect(audit).toHaveLength(1)

    const again = await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'dup', confirm: true } })
    expect(again.status).toBe(409)
    expect(again.json.error).toBe('already_active')
  })

  it('allows rollback only to a model that was previously live', async () => {
    const a = await register(PARAMS, 'a')
    const b = await register({ ...PARAMS, kAtr: 2.5 }, 'b')
    const neverLive = await register({ ...PARAMS, kAtr: 3 }, 'never')
    await seedGoodOosRun(a)
    await seedGoodOosRun(b)
    expect((await call(`/admin/models/${a}/promote`, { method: 'POST', body: { reason: 'a', confirm: true } })).status).toBe(200)
    expect((await call(`/admin/models/${b}/promote`, { method: 'POST', body: { reason: 'b', confirm: true } })).status).toBe(200)

    const denied = await call(`/admin/models/${neverLive}/promote`, {
      method: 'POST',
      body: { reason: 'x', confirm: true, rollback: true },
    })
    expect(denied.status).toBe(409)
    expect(denied.json.error).toBe('rollback_not_allowed')

    sqlite.exec(`UPDATE backtest_run SET created_at = '2020-01-01T00:00:00.000Z'`)
    const rolledBack = await call(`/admin/models/${a}/promote`, {
      method: 'POST',
      body: { reason: 'b misbehaves', confirm: true, rollback: true },
    })
    expect(rolledBack.status).toBe(200)
    expect(rolledBack.json.previousModelId).toBe(b)
    expect(globalRow().pullback_default_k_atr).toBe(2)
  })

  it('409s for a backtest-only kind', async () => {
    const res = await call('/admin/models', {
      method: 'POST',
      body: {
        kind: 'breakout_momentum',
        label: 'momo',
        params: {
          stopPct: -0.05,
          takeProfitPct: 0.1,
          timeStopDays: 7,
          kAtr: 2.5,
          minReturn: 0.04,
          breakoutBuffer: 0.005,
          maxSma50DeviationPct: 0.6,
          requireAboveSma50: true,
          maxStopToTpRatio: 2,
          atrBaselineMode: 'percentile',
        },
      },
    })
    const promote = await call(`/admin/models/${res.json.model.id}/promote`, {
      method: 'POST',
      body: { reason: 'x', confirm: true },
    })
    expect(promote.status).toBe(409)
    expect(promote.json.error).toBe('not_promotable')
  })

  it('scopes deployments to the worker ENVIRONMENT', async () => {
    const id = await register()
    await seedGoodOosRun(id)
    await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'stg', confirm: true } }, { ENVIRONMENT: 'staging' })
    const prod = await call('/admin/models')
    const stg = await call('/admin/models', {}, { ENVIRONMENT: 'staging' })
    expect(prod.json.active).toBeNull()
    expect(stg.json.active.modelId).toBe(id)
  })
})

describe('GET /admin/models', () => {
  it('flags global_config drift from the active model', async () => {
    const id = await register()
    await seedGoodOosRun(id)
    await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'ok', confirm: true } })
    sqlite.exec(`UPDATE global_config SET pullback_default_k_atr = 2.7`)
    const res = await call('/admin/models')
    expect(res.json.driftKeys).toEqual(['kAtr'])
  })
})

describe('GET /admin/models/replay', () => {
  it('replays previously live models alongside the active one', async () => {
    const a = await register(PARAMS, 'a')
    const b = await register({ ...PARAMS, takeProfitPct: 0.08 }, 'b')
    await register({ ...PARAMS, takeProfitPct: 0.09 }, 'candidate')
    await seedGoodOosRun(a)
    await seedGoodOosRun(b)
    await call(`/admin/models/${a}/promote`, { method: 'POST', body: { reason: 'a', confirm: true } })
    await call(`/admin/models/${b}/promote`, { method: 'POST', body: { reason: 'b', confirm: true } })

    const res = await call('/admin/models/replay?from=2025-04-01&to=2025-12-31&symbols=SOXL')
    expect(res.status).toBe(200)
    const models = res.json.models as Array<{ id: number; isActive: boolean; livePeriods: unknown[]; result: { equityCurve: unknown[] } }>
    expect(models.map((m) => m.id).sort()).toEqual([a, b].sort())
    expect(models.find((m) => m.id === b)!.isActive).toBe(true)
    expect(models.find((m) => m.id === a)!.livePeriods).toHaveLength(1)
    expect(models.every((m) => m.result.equityCurve.length > 0)).toBe(true)
  })

  it('drops a symbol whose bar fetch failed for every model', async () => {
    await register()
    getDailyBars.mockImplementation(async (symbol) => {
      if (symbol === 'BROKEN') throw new Error('yahoo 500')
      return syntheticBars(320)
    })
    const res = await call('/admin/models/replay?from=2025-04-01&to=2025-12-31&symbols=SOXL,BROKEN')
    expect(res.json.symbols).toEqual(['SOXL'])
    expect(res.json.failedSymbols).toEqual([{ symbol: 'BROKEN', error: 'yahoo 500' }])
  })

  it('400s for a window beyond the bar history', async () => {
    await register()
    const res = await call('/admin/models/replay?from=2015-01-01&to=2025-12-31&symbols=SOXL')
    expect(res.status).toBe(400)
  })
})

describe('GET /dashboard/models', () => {
  it('renders registry, replay table and a parseable chart script', async () => {
    const id = await register(PARAMS, 'baseline')
    await seedGoodOosRun(id)
    await call(`/admin/models/${id}/promote`, { method: 'POST', body: { reason: 'ok', confirm: true } })
    const app = createApp()
    const res = await app.request('/dashboard/models?from=2025-04-01&to=2025-12-31&symbols=SOXL', {}, env())
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('稼働中モデル')
    expect(html).toContain('baseline')
    expect(html).toContain('models-replay-chart')
    expect(html).toContain('<span class="subnav-link active">モデル比較</span>')
    for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(code!)).not.toThrow()
    }
  })
})
