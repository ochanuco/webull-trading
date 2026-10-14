import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppBindings } from '../app'

type Bindings = AppBindings['Bindings']
import { rateLimit } from '../middleware/rateLimit'
import { ValidationError } from '../shared/errors'
import { extractActor, recordChange } from '../infrastructure/db/configAuditLog'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { YahooBarClient } from '../infrastructure/quotes/YahooBarClient'
import {
  applyPromotion,
  getActiveDeployment,
  getModel,
  insertBacktestRun,
  listBacktestRuns,
  listDeployments,
  listModels,
  registerModel,
  type BacktestRunRecord,
  type ModelDeploymentRecord,
  type StrategyModelRecord,
} from '../infrastructure/db/strategyModelRepo'
import {
  evaluatePromotionGate,
  type BacktestPurpose,
  type PromotionGateResult,
} from '../trading/models/promotionGate'
import {
  buildReplayComparison,
  defaultReplayFrom,
  ReplayWindowError,
  selectReplayModels,
  type ReplayComparison,
} from '../trading/models/replayComparison'
import {
  globalConfigPatchForPullback,
  ModelParamsError,
  parseModelSpec,
  PROMOTABLE_MODEL_KINDS,
  pullbackDriftKeys,
  pullbackParamsFromGlobalConfig,
  type StrategyModelSpec,
} from '../trading/models/strategyModel'

/** Bars come from Yahoo, matching `/admin/backtest`, so results line up with the existing harness. */
const BAR_SOURCE = 'yahoo'
const DEFAULT_INITIAL_CASH_USD = 10_000
const DEFAULT_INITIAL_CASH_JPY = 1_500_000

/**
 * Strategy model registry → backtest evidence → gated promotion → replay.
 * Promotion only rewrites `global_config.pullback_default_*` /
 * `atr_baseline_mode`; it never touches dry_run / trading_enabled, and the
 * live order path (Strategy → Risk → Execution) is unchanged.
 */
export const adminModels = new Hono<AppBindings>()
  .get('/', async (c) => {
    return c.json(await loadModelRegistryView(c.env, c.get('requestId')))
  })
  /**
   * Body: `{ kind, params, label, note?, parentModelId? }`, or
   * `{ fromGlobalConfig: true, label }` to register the pullback params
   * production is running right now (the baseline to compare against).
   * Re-registering identical params returns the existing model (200).
   */
  .post('/', rateLimit('ADMIN_WRITE'), async (c) => {
    const db = requireDb(c.env)
    const body = await readJsonObject(c)
    const label = readNonEmptyString(body.label, 'label', 100)
    const spec =
      body.fromGlobalConfig === true
        ? ({
            kind: 'pullback_uptrend',
            params: pullbackParamsFromGlobalConfig(await loadGlobalConfigFrom(c.env, c.get('requestId'))),
          } satisfies StrategyModelSpec)
        : toValidation(() => parseModelSpec(body.kind, body.params))
    const parentModelId = body.parentModelId === undefined || body.parentModelId === null ? null : readId(body.parentModelId, 'parentModelId')
    if (parentModelId !== null && !(await getModel(db, parentModelId))) {
      throw new ValidationError(`parent model ${parentModelId} not found`, { field: 'parentModelId' })
    }
    const result = await registerModel(db, {
      spec,
      label,
      note: body.note === undefined || body.note === null ? null : readNonEmptyString(body.note, 'note', 1000),
      parentModelId,
      actor: extractActor(c.get('actor')),
      now: new Date(),
    })
    return c.json(result, result.created ? 201 : 200)
  })
  /**
   * Query: `from`, `to` (default: env's first promotion .. today), `symbols`
   * (CSV, default: active universe), `modelIds` (CSV, default: every model
   * ever live in this env), `initialCashUsd`, `initialCashJpy`.
   */
  .get('/replay', async (c) => {
    return c.json(await runReplayFromQuery(c.env, (key) => c.req.query(key)))
  })
  .get('/:id', async (c) => {
    const db = requireDb(c.env)
    const model = await requireModel(c, db)
    const env = deploymentEnv(c.env)
    const [runs, deployments] = await Promise.all([listBacktestRuns(db, model.id), listDeployments(db, env)])
    return c.json({ model, runs, deployments: deployments.filter((d) => d.modelId === model.id) })
  })
  /**
   * Replays the model over `[from, to]` and records the result as gate
   * evidence. Body: `{ purpose: 'in_sample'|'out_of_sample', from, to,
   * symbols?, initialCashUsd?, initialCashJpy? }`.
   */
  .post('/:id/backtest', rateLimit('ADMIN_WRITE'), async (c) => {
    const db = requireDb(c.env)
    const model = await requireModel(c, db)
    const body = await readJsonObject(c)
    const purpose = readPurpose(body.purpose)
    const from = readYmd(body.from, 'from')
    const to = readYmd(body.to, 'to')
    if (from > to) throw new ValidationError("'from' must be <= 'to'", { field: 'from' })
    const symbols = await resolveSymbols(c.env, body.symbols)
    const initialCashUsd = readPositive(body.initialCashUsd, 'initialCashUsd', DEFAULT_INITIAL_CASH_USD)
    const initialCashJpy = readPositive(body.initialCashJpy, 'initialCashJpy', DEFAULT_INITIAL_CASH_JPY)

    const comparison = await replayOrValidation(() =>
      buildReplayComparison({
        models: [model],
        deployments: [],
        symbols,
        from,
        to,
        initialCashUsd,
        initialCashJpy,
        loadBars: yahooLoader(),
        today: new Date(),
      }),
    )
    const replayed = comparison.models[0]!
    if (replayed.result.perSymbol.length === 0) {
      throw new ValidationError('no symbol had bars in the requested window', { field: 'from' })
    }
    const run = await insertBacktestRun(db, {
      modelId: model.id,
      purpose,
      symbols: replayed.result.perSymbol.map((s) => s.symbol),
      fromDate: from,
      toDate: to,
      initialCashUsd,
      initialCashJpy,
      barSource: BAR_SOURCE,
      metrics: replayed.result.metrics,
      perSymbol: replayed.result.perSymbol,
      actor: extractActor(c.get('actor')),
      requestId: c.get('requestId') ?? null,
      now: new Date(),
    })
    return c.json(
      {
        run,
        skippedSymbols: replayed.result.skippedSymbols,
        failedSymbols: comparison.failedSymbols,
        equityCurve: replayed.result.equityCurve,
      },
      201,
    )
  })
  /** Dry evaluation of the promotion gate — same checks `/promote` enforces. */
  .get('/:id/gate', async (c) => {
    const db = requireDb(c.env)
    const model = await requireModel(c, db)
    return c.json(await evaluateGateFor(db, deploymentEnv(c.env), model.id))
  })
  /**
   * Body: `{ reason, confirm: true, rollback?: true }`. `rollback` skips the
   * gate but only for a model that was previously live in this env —
   * returning to a known-good model must not be blocked by stale evidence,
   * while an unproven model can never use it to dodge the gate. A model
   * whose params equal live global_config is adopted without the gate.
   */
  .post('/:id/promote', rateLimit('STATE_CHANGE'), async (c) => {
    const db = requireDb(c.env)
    const model = await requireModel(c, db)
    const env = deploymentEnv(c.env)
    const body = await readJsonObject(c)
    if (body.confirm !== true) {
      throw new ValidationError("'confirm' must be true", { field: 'confirm' })
    }
    const reason = readNonEmptyString(body.reason, 'reason', 500)
    const rollback = body.rollback === true
    if (!PROMOTABLE_MODEL_KINDS.has(model.spec.kind)) {
      return c.json(
        { error: 'not_promotable', message: `kind '${model.spec.kind}' is not dispatched by the live scheduler` },
        409,
      )
    }
    const deployments = await listDeployments(db, env)
    const active = deployments.find((d) => d.endedAt === null) ?? null
    if (active?.modelId === model.id) {
      return c.json({ error: 'already_active', message: `model ${model.id} is already active in ${env}` }, 409)
    }
    if (rollback && !deployments.some((d) => d.modelId === model.id)) {
      return c.json(
        { error: 'rollback_not_allowed', message: `model ${model.id} was never live in ${env}; promote it through the gate` },
        409,
      )
    }
    const global = await loadGlobalConfigFrom(c.env, c.get('requestId'))
    const params = model.spec.kind === 'pullback_uptrend' ? model.spec.params : null
    // Adopting a model identical to live global_config changes no trading
    // behavior, so it needs no evidence — this is how the current settings
    // become the first tracked baseline without having to "pass" first.
    const adoptsLiveConfig = params !== null && pullbackDriftKeys(params, global).length === 0
    const gate = await evaluateGateFor(db, env, model.id)
    if (!rollback && !adoptsLiveConfig && !gate.passed) {
      return c.json({ error: 'promotion_gate_failed', gate }, 409)
    }

    const before = { activeModelId: active?.modelId ?? null, params: pullbackParamsFromGlobalConfig(global) }
    const deployment = await applyPromotion(db, {
      modelId: model.id,
      env,
      actor: extractActor(c.get('actor')),
      reason: rollback ? `[rollback] ${reason}` : adoptsLiveConfig ? `[adopt] ${reason}` : reason,
      gate,
      globalConfigPatch: params ? globalConfigPatchForPullback(params) : null,
      requestId: c.get('requestId') ?? null,
      now: new Date(),
    })
    // The promotion batch already committed; failing the response here would
    // invite a retry that hits `already_active`. model_deployment itself is
    // the primary record, so an audit-write failure is logged, not thrown.
    try {
      await recordChange(c.env.DB!, {
        actor: extractActor(c.get('actor')),
        endpoint: '/admin/models/:id/promote',
        targetKey: `model=${model.id} env=${env}`,
        before,
        after: { activeModelId: model.id, params },
        requestId: c.get('requestId') ?? null,
      })
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'config_audit_log_write_failed',
          endpoint: '/admin/models/:id/promote',
          modelId: model.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    return c.json({ deployment, previousModelId: active?.modelId ?? null, gate })
  })

export async function runReplayFromQuery(
  bindings: Bindings,
  query: (key: string) => string | undefined,
): Promise<ReplayComparison> {
  const db = requireDb(bindings)
  const env = deploymentEnv(bindings)
  const today = new Date()
  const [allModels, deployments] = await Promise.all([listModels(db), listDeployments(db, env)])
  const from = query('from') ? readYmd(query('from'), 'from') : defaultReplayFrom(deployments, today)
  const to = query('to') ? readYmd(query('to'), 'to') : today.toISOString().slice(0, 10)
  if (from > to) throw new ValidationError("'from' must be <= 'to'", { field: 'from' })
  const requestedIds = (query('modelIds') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => readId(Number(s), 'modelIds'))
  const symbolsQuery = query('symbols')
  const symbols = await resolveSymbols(bindings, symbolsQuery ? symbolsQuery.split(',') : undefined)
  return replayOrValidation(() =>
    buildReplayComparison({
      models: selectReplayModels(allModels, deployments, requestedIds),
      deployments,
      symbols,
      from,
      to,
      initialCashUsd: readPositive(numberOrUndefined(query('initialCashUsd')), 'initialCashUsd', DEFAULT_INITIAL_CASH_USD),
      initialCashJpy: readPositive(numberOrUndefined(query('initialCashJpy')), 'initialCashJpy', DEFAULT_INITIAL_CASH_JPY),
      loadBars: yahooLoader(),
      today,
    }),
  )
}

export interface ModelRegistryView {
  env: string
  active: ModelDeploymentRecord | null
  /** global_config keys hand-edited away from the active model since promotion. */
  driftKeys: string[]
  models: Array<{
    model: StrategyModelRecord
    runs: Array<Omit<BacktestRunRecord, 'perSymbol'>>
    gate: PromotionGateResult
    promotable: boolean
  }>
  deployments: ModelDeploymentRecord[]
}

export async function loadModelRegistryView(bindings: Bindings, requestId?: string): Promise<ModelRegistryView> {
  const db = requireDb(bindings)
  const env = deploymentEnv(bindings)
  const [models, deployments, runs, global] = await Promise.all([
    listModels(db),
    listDeployments(db, env),
    listBacktestRuns(db),
    loadGlobalConfigFrom(bindings, requestId),
  ])
  const active = deployments.find((d) => d.endedAt === null) ?? null
  const activeModel = active ? models.find((m) => m.id === active.modelId) ?? null : null
  const activeRuns = active ? runs.filter((r) => r.modelId === active.modelId) : []
  const now = new Date()
  return {
    env,
    active,
    driftKeys: activeModel ? driftKeysFor(activeModel.spec, global) : [],
    models: models.map((model) => {
      const own = runs.filter((r) => r.modelId === model.id)
      return {
        model,
        runs: own.map(({ perSymbol: _perSymbol, ...r }) => r),
        gate: evaluatePromotionGate({
          candidateRuns: own,
          activeRuns: active?.modelId === model.id ? [] : activeRuns,
          now,
        }),
        promotable: PROMOTABLE_MODEL_KINDS.has(model.spec.kind),
      }
    }),
    deployments,
  }
}

async function evaluateGateFor(db: ReturnType<typeof createDb>, env: string, modelId: number) {
  const [candidateRuns, active] = await Promise.all([listBacktestRuns(db, modelId), getActiveDeployment(db, env)])
  const activeRuns = active && active.modelId !== modelId ? await listBacktestRuns(db, active.modelId) : []
  return evaluatePromotionGate({ candidateRuns, activeRuns, now: new Date() })
}

function driftKeysFor(spec: StrategyModelSpec, global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>): string[] {
  return spec.kind === 'pullback_uptrend' ? pullbackDriftKeys(spec.params, global) : []
}

/**
 * The worker's own ENVIRONMENT, never a request field: a staging worker
 * must not be able to record (or a caller to spoof) a production promotion.
 */
function deploymentEnv(bindings: Bindings): string {
  const env = bindings.ENVIRONMENT?.trim()
  return env && env.length > 0 ? env : 'dev'
}

function requireDb(bindings: Bindings): ReturnType<typeof createDb> {
  if (!bindings.DB) throw new ValidationError('DB binding is not configured', { field: 'env' })
  return createDb(bindings.DB)
}

async function requireModel(c: Context<AppBindings>, db: ReturnType<typeof createDb>) {
  const id = readId(Number(c.req.param('id')), 'id')
  const model = await getModel(db, id)
  if (!model) throw new ValidationError(`model ${id} not found`, { field: 'id' })
  return model
}

function yahooLoader() {
  const client = new YahooBarClient()
  return (symbol: string, lookback: number) => client.getDailyBars(symbol, lookback)
}

async function resolveSymbols(bindings: Bindings, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) {
    const universe = await loadSymbolUniverse(bindings)
    if (universe.allowedSymbols.length === 0) {
      throw new ValidationError('no active symbols; pass symbols explicitly', { field: 'symbols' })
    }
    return universe.allowedSymbols
  }
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) {
    throw new ValidationError("'symbols' must be an array of strings", { field: 'symbols' })
  }
  const symbols = [...new Set((raw as string[]).map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))]
  if (symbols.length === 0) throw new ValidationError("'symbols' must not be empty", { field: 'symbols' })
  if (symbols.length > 30) throw new ValidationError("'symbols' allows at most 30 entries", { field: 'symbols' })
  return symbols
}

async function readJsonObject(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('request body must be a JSON object', { field: 'body' })
  }
  return body as Record<string, unknown>
}

function readNonEmptyString(v: unknown, field: string, maxLength: number): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ValidationError(`'${field}' must be a non-empty string`, { field })
  }
  if (v.trim().length > maxLength) {
    throw new ValidationError(`'${field}' must be at most ${maxLength} characters`, { field })
  }
  return v.trim()
}

function readId(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ValidationError(`'${field}' must be a positive integer`, { field })
  }
  return v
}

function readPurpose(v: unknown): BacktestPurpose {
  if (v === 'in_sample' || v === 'out_of_sample') return v
  throw new ValidationError("'purpose' must be 'in_sample' or 'out_of_sample'", { field: 'purpose' })
}

function readYmd(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new ValidationError(`'${field}' must be YYYY-MM-DD`, { field })
  }
  return v
}

function readPositive(v: unknown, field: string, fallback: number): number {
  if (v === undefined || v === null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ValidationError(`'${field}' must be a positive number`, { field })
  }
  return v
}

function numberOrUndefined(v: string | undefined): number | undefined {
  return v === undefined || v === '' ? undefined : Number(v)
}

function toValidation<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof ModelParamsError) throw new ValidationError(err.message, { field: err.field })
    throw err
  }
}

async function replayOrValidation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ReplayWindowError) throw new ValidationError(err.message, { field: 'from' })
    throw err
  }
}
