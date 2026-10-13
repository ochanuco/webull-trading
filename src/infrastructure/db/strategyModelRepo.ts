import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { BacktestPurpose, GateRun, PromotionGateResult } from '../../trading/models/promotionGate'
import type { ReplayMetrics, ReplaySymbolResult } from '../../trading/models/replay'
import {
  canonicalParamsJson,
  hashModelSpec,
  parseModelSpec,
  type StrategyModelSpec,
} from '../../trading/models/strategyModel'
import {
  backtestRun,
  globalConfig,
  modelDeployment,
  strategyModel,
  type BacktestRunRow,
  type GlobalConfigInsert,
  type ModelDeploymentRow,
  type StrategyModelRow,
} from './schema'

export interface StrategyModelRecord {
  id: number
  spec: StrategyModelSpec
  paramsHash: string
  label: string
  note: string | null
  parentModelId: number | null
  createdAt: string
  createdBy: string
}

function toStrategyModelRecord(row: StrategyModelRow): StrategyModelRecord {
  return {
    id: row.id,
    spec: parseModelSpec(row.kind, JSON.parse(row.paramsJson)),
    paramsHash: row.paramsHash,
    label: row.label,
    note: row.note,
    parentModelId: row.parentModelId,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export async function registerModel(
  db: DrizzleD1Database,
  args: {
    spec: StrategyModelSpec
    label: string
    note: string | null
    parentModelId: number | null
    actor: string
    now: Date
  },
): Promise<{ model: StrategyModelRecord; created: boolean }> {
  const paramsHash = await hashModelSpec(args.spec)
  const inserted = await db
    .insert(strategyModel)
    .values({
      kind: args.spec.kind,
      paramsJson: canonicalParamsJson(args.spec),
      paramsHash,
      label: args.label,
      note: args.note,
      parentModelId: args.parentModelId,
      createdAt: args.now.toISOString(),
      createdBy: args.actor,
    })
    .onConflictDoNothing({ target: strategyModel.paramsHash })
    .returning()
  if (inserted[0]) return { model: toStrategyModelRecord(inserted[0]), created: true }
  const existing = await db.select().from(strategyModel).where(eq(strategyModel.paramsHash, paramsHash)).limit(1)
  if (!existing[0]) throw new Error(`registerModel: hash ${paramsHash} conflicted but no row found`)
  return { model: toStrategyModelRecord(existing[0]), created: false }
}

export async function getModel(db: DrizzleD1Database, id: number): Promise<StrategyModelRecord | null> {
  const rows = await db.select().from(strategyModel).where(eq(strategyModel.id, id)).limit(1)
  return rows[0] ? toStrategyModelRecord(rows[0]) : null
}

export async function listModels(db: DrizzleD1Database): Promise<StrategyModelRecord[]> {
  const rows = await db.select().from(strategyModel).orderBy(desc(strategyModel.id))
  return rows.map(toStrategyModelRecord)
}

export interface BacktestRunRecord extends GateRun {
  modelId: number
  initialCashUsd: number
  initialCashJpy: number
  barSource: string
  perSymbol: ReplaySymbolResult[]
  createdBy: string
}

function toBacktestRunRecord(row: BacktestRunRow): BacktestRunRecord {
  return {
    id: row.id,
    modelId: row.modelId,
    purpose: row.purpose as BacktestPurpose,
    symbols: JSON.parse(row.symbolsJson) as string[],
    fromDate: row.fromDate,
    toDate: row.toDate,
    initialCashUsd: row.initialCashUsd,
    initialCashJpy: row.initialCashJpy,
    barSource: row.barSource,
    metrics: JSON.parse(row.metricsJson) as ReplayMetrics,
    perSymbol: JSON.parse(row.perSymbolJson) as ReplaySymbolResult[],
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export async function insertBacktestRun(
  db: DrizzleD1Database,
  args: {
    modelId: number
    purpose: BacktestPurpose
    symbols: string[]
    fromDate: string
    toDate: string
    initialCashUsd: number
    initialCashJpy: number
    barSource: string
    metrics: ReplayMetrics
    perSymbol: ReplaySymbolResult[]
    actor: string
    requestId: string | null
    now: Date
  },
): Promise<BacktestRunRecord> {
  const rows = await db
    .insert(backtestRun)
    .values({
      modelId: args.modelId,
      purpose: args.purpose,
      symbolsJson: JSON.stringify(args.symbols),
      fromDate: args.fromDate,
      toDate: args.toDate,
      initialCashUsd: args.initialCashUsd,
      initialCashJpy: args.initialCashJpy,
      barSource: args.barSource,
      metricsJson: JSON.stringify(args.metrics),
      perSymbolJson: JSON.stringify(args.perSymbol),
      createdAt: args.now.toISOString(),
      createdBy: args.actor,
      requestId: args.requestId,
    })
    .returning()
  return toBacktestRunRecord(rows[0]!)
}

export async function listBacktestRuns(db: DrizzleD1Database, modelId?: number): Promise<BacktestRunRecord[]> {
  const base = db.select().from(backtestRun).$dynamic()
  const rows = await (modelId === undefined ? base : base.where(eq(backtestRun.modelId, modelId))).orderBy(
    desc(backtestRun.id),
  )
  return rows.map(toBacktestRunRecord)
}

export interface ModelDeploymentRecord {
  id: number
  modelId: number
  env: string
  startedAt: string
  endedAt: string | null
  actor: string
  reason: string
  evidenceRunIds: number[]
  gate: PromotionGateResult
}

function toDeploymentRecord(row: ModelDeploymentRow): ModelDeploymentRecord {
  return {
    id: row.id,
    modelId: row.modelId,
    env: row.env,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    actor: row.actor,
    reason: row.reason,
    evidenceRunIds: JSON.parse(row.evidenceRunIdsJson) as number[],
    gate: JSON.parse(row.gateJson) as PromotionGateResult,
  }
}

export async function getActiveDeployment(db: DrizzleD1Database, env: string): Promise<ModelDeploymentRecord | null> {
  const rows = await db
    .select()
    .from(modelDeployment)
    .where(and(eq(modelDeployment.env, env), isNull(modelDeployment.endedAt)))
    .limit(1)
  return rows[0] ? toDeploymentRecord(rows[0]) : null
}

export async function listDeployments(db: DrizzleD1Database, env: string): Promise<ModelDeploymentRecord[]> {
  const rows = await db
    .select()
    .from(modelDeployment)
    .where(eq(modelDeployment.env, env))
    .orderBy(asc(modelDeployment.startedAt), asc(modelDeployment.id))
  return rows.map(toDeploymentRecord)
}

/**
 * Closes the env's active deployment, opens the new one and (for a live
 * kind) writes its params into global_config in one D1 batch, so a partial
 * failure can't leave global_config running a model the history doesn't
 * name (or vice versa).
 */
export async function applyPromotion(
  db: DrizzleD1Database,
  args: {
    modelId: number
    env: string
    actor: string
    reason: string
    gate: PromotionGateResult
    globalConfigPatch: Partial<GlobalConfigInsert> | null
    requestId: string | null
    now: Date
  },
): Promise<ModelDeploymentRecord> {
  const nowIso = args.now.toISOString()
  if (args.globalConfigPatch !== null) {
    // Seeding a missing row here would create it with dry_run/trading_enabled
    // column defaults as a side effect of a params change — refuse instead.
    const existing = await db.select({ id: globalConfig.id }).from(globalConfig).where(eq(globalConfig.id, 'default')).limit(1)
    if (!existing[0]) throw new Error("applyPromotion: global_config row 'default' not found")
  }
  const closeActive = db
    .update(modelDeployment)
    .set({ endedAt: nowIso })
    .where(and(eq(modelDeployment.env, args.env), isNull(modelDeployment.endedAt)))
  const openNew = db
    .insert(modelDeployment)
    .values({
      modelId: args.modelId,
      env: args.env,
      startedAt: nowIso,
      endedAt: null,
      actor: args.actor,
      reason: args.reason,
      evidenceRunIdsJson: JSON.stringify(args.gate.evidenceRunIds),
      gateJson: JSON.stringify(args.gate),
      requestId: args.requestId,
    })
    .returning()
  const results =
    args.globalConfigPatch !== null
      ? await db.batch([
          db
            .update(globalConfig)
            .set({ ...args.globalConfigPatch, updatedAt: nowIso })
            .where(eq(globalConfig.id, 'default')),
          closeActive,
          openNew,
        ])
      : await db.batch([closeActive, openNew])
  const insertedRows = results[results.length - 1] as ModelDeploymentRow[]
  return toDeploymentRecord(insertedRows[0]!)
}
