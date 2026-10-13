import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import {
  applyPromotion,
  getActiveDeployment,
  insertBacktestRun,
  listBacktestRuns,
  listDeployments,
  registerModel,
} from '../../../src/infrastructure/db/strategyModelRepo'
import type { PromotionGateResult } from '../../../src/trading/models/promotionGate'
import type { ReplayMetrics } from '../../../src/trading/models/replay'
import { globalConfigPatchForPullback, type PullbackModelParams, type StrategyModelSpec } from '../../../src/trading/models/strategyModel'
import { sqliteD1 } from '../../helpers/sqliteD1'

const PARAMS: PullbackModelParams = {
    stopPct: -0.05,
    takeProfitPct: 0.08,
    timeStopDays: 12,
    pullbackMax: -0.02,
    pullbackMin: -0.07,
    minReturn50d: 0.05,
    requireAboveSma50: true,
    kAtr: 2.2,
    maxSma50DeviationPct: 0.5,
    maxAtrRatio: 1.3,
    maxStopToTpRatio: 1.5,
    atrBaselineMode: 'overlap',
}
const SPEC: StrategyModelSpec = { kind: 'pullback_uptrend', params: PARAMS }

const GATE: PromotionGateResult = { passed: true, evidenceRunIds: [1], checks: [] }
const T0 = new Date('2026-10-01T00:00:00.000Z')
const T1 = new Date('2026-10-05T00:00:00.000Z')

const METRICS: ReplayMetrics = {
  totalReturn: 0.1,
  sharpeRatio: 1,
  maxDrawdownPct: -0.08,
  totalTrades: 25,
  winRate: 0.5,
  profitFactor: 1.5,
  avgTradeReturn: 0.01,
  avgHoldingDays: 5,
  exitReasons: { TP: 10, STOP: 10, TIME_STOP: 5, END_OF_DATA: 0 },
  pnlByCurrency: { USD: 1000, JPY: 0 },
}

let db: DrizzleD1Database
let sqlite: DatabaseSync

function seedGlobalConfig() {
  sqlite.exec(`INSERT INTO global_config (id, dry_run, trading_enabled, updated_at) VALUES ('default', 1, 0, '2026-01-01T00:00:00.000Z')`)
}

function globalRow(): Record<string, unknown> {
  return sqlite.prepare(`SELECT * FROM global_config WHERE id = 'default'`).get() as Record<string, unknown>
}

beforeEach(() => {
  const created = sqliteD1()
  sqlite = created.sqlite
  db = drizzle(created.d1)
})

describe('registerModel', () => {
  it('creates a model once and returns the same row for identical params', async () => {
    const first = await registerModel(db, { spec: SPEC, label: 'v1', note: null, parentModelId: null, actor: 'admin', now: T0 })
    const again = await registerModel(db, { spec: SPEC, label: 'renamed', note: null, parentModelId: null, actor: 'admin', now: T1 })
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.model.id).toBe(first.model.id)
    expect(again.model.label).toBe('v1')
    expect(again.model.spec).toEqual(SPEC)
  })

  it('registers a new model when any param differs', async () => {
    const a = await registerModel(db, { spec: SPEC, label: 'a', note: null, parentModelId: null, actor: 'admin', now: T0 })
    const b = await registerModel(db, {
      spec: { kind: 'pullback_uptrend', params: { ...PARAMS, kAtr: 2.3 } },
      label: 'b',
      note: 'kAtr +0.1',
      parentModelId: a.model.id,
      actor: 'admin',
      now: T0,
    })
    expect(b.created).toBe(true)
    expect(b.model.parentModelId).toBe(a.model.id)
  })
})

describe('backtest runs', () => {
  it('stores and reads back metrics per model', async () => {
    const { model } = await registerModel(db, { spec: SPEC, label: 'v1', note: null, parentModelId: null, actor: 'admin', now: T0 })
    await insertBacktestRun(db, {
      modelId: model.id,
      purpose: 'out_of_sample',
      symbols: ['SOXL'],
      fromDate: '2025-01-01',
      toDate: '2025-12-31',
      initialCashUsd: 10_000,
      initialCashJpy: 1_500_000,
      barSource: 'yahoo',
      metrics: METRICS,
      perSymbol: [{ symbol: 'SOXL', barCount: 300, metrics: METRICS }],
      actor: 'admin',
      requestId: 'req-1',
      now: T0,
    })
    const runs = await listBacktestRuns(db, model.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.metrics).toEqual(METRICS)
    expect(runs[0]!.symbols).toEqual(['SOXL'])
    expect(await listBacktestRuns(db, model.id + 1)).toEqual([])
  })
})

describe('applyPromotion', () => {
  it('writes params to global_config and opens the deployment without touching safety switches', async () => {
    seedGlobalConfig()
    const { model } = await registerModel(db, { spec: SPEC, label: 'v1', note: null, parentModelId: null, actor: 'admin', now: T0 })
    const deployment = await applyPromotion(db, {
      modelId: model.id,
      env: 'production',
      actor: 'admin',
      reason: 'better OOS',
      gate: GATE,
      globalConfigPatch: globalConfigPatchForPullback(PARAMS),
      requestId: null,
      now: T0,
    })
    expect(deployment.endedAt).toBeNull()
    const row = globalRow()
    expect(row.pullback_default_k_atr).toBe(2.2)
    expect(row.atr_baseline_mode).toBe('overlap')
    expect(row.dry_run).toBe(1)
    expect(row.trading_enabled).toBe(0)
  })

  it('closes the previous active deployment so exactly one stays active per env', async () => {
    seedGlobalConfig()
    const a = await registerModel(db, { spec: SPEC, label: 'a', note: null, parentModelId: null, actor: 'admin', now: T0 })
    const b = await registerModel(db, {
      spec: { kind: 'pullback_uptrend', params: { ...PARAMS, kAtr: 2.4 } },
      label: 'b',
      note: null,
      parentModelId: null,
      actor: 'admin',
      now: T0,
    })
    const base = { env: 'production', actor: 'admin', reason: 'r', gate: GATE, globalConfigPatch: null, requestId: null }
    await applyPromotion(db, { ...base, modelId: a.model.id, now: T0 })
    await applyPromotion(db, { ...base, modelId: b.model.id, now: T1 })
    await applyPromotion(db, { ...base, env: 'staging', modelId: a.model.id, now: T1 })

    const history = await listDeployments(db, 'production')
    expect(history.map((d) => [d.modelId, d.endedAt])).toEqual([
      [a.model.id, T1.toISOString()],
      [b.model.id, null],
    ])
    expect((await getActiveDeployment(db, 'staging'))?.modelId).toBe(a.model.id)
  })

  it('refuses to seed a missing global_config row as a side effect', async () => {
    const { model } = await registerModel(db, { spec: SPEC, label: 'v1', note: null, parentModelId: null, actor: 'admin', now: T0 })
    await expect(
      applyPromotion(db, {
        modelId: model.id,
        env: 'production',
        actor: 'admin',
        reason: 'r',
        gate: GATE,
        globalConfigPatch: { pullbackDefaultKAtr: 2.2 },
        requestId: null,
        now: T0,
      }),
    ).rejects.toThrow(/global_config row 'default' not found/)
    expect(await listDeployments(db, 'production')).toEqual([])
  })

  it('rolls back the deployment change when the global_config write violates a CHECK', async () => {
    seedGlobalConfig()
    const { model } = await registerModel(db, { spec: SPEC, label: 'v1', note: null, parentModelId: null, actor: 'admin', now: T0 })
    await expect(
      applyPromotion(db, {
        modelId: model.id,
        env: 'production',
        actor: 'admin',
        reason: 'r',
        gate: GATE,
        globalConfigPatch: { pullbackDefaultStopPct: 0.5 },
        requestId: null,
        now: T0,
      }),
    ).rejects.toThrow()
    expect(await listDeployments(db, 'production')).toEqual([])
  })

  it('rejects a second active row for the same env at the DB level', () => {
    const insert = `INSERT INTO model_deployment (model_id, env, started_at, actor, reason, evidence_run_ids_json, gate_json) VALUES (?, 'production', '2026-01-01', 'a', 'r', '[]', '{}')`
    sqlite.prepare(insert).run(1)
    expect(() => sqlite.prepare(insert).run(2)).toThrow(/UNIQUE/)
  })
})
