import type { DailyBar } from '../strategy/indicators'
import type { ModelDeploymentRecord, StrategyModelRecord } from '../../infrastructure/db/strategyModelRepo'
import { MAX_REPLAY_LOOKBACK_BARS, replayLookbackBars, replayModel, type ReplayResult } from './replay'

/** Each model replays every symbol, so this bounds Worker CPU per request. */
const MAX_REPLAY_MODELS = 10

export interface ReplayComparisonInput {
  models: StrategyModelRecord[]
  deployments: ModelDeploymentRecord[]
  symbols: string[]
  from: string
  to: string
  initialCashUsd: number
  initialCashJpy: number
  loadBars: (symbol: string, lookback: number) => Promise<DailyBar[]>
  today: Date
}

interface ReplayComparisonModel {
  id: number
  label: string
  kind: string
  params: unknown
  isActive: boolean
  /** Periods this model was live in the env (from model_deployment). */
  livePeriods: Array<{ startedAt: string; endedAt: string | null }>
  result: ReplayResult
}

export interface ReplayComparison {
  from: string
  to: string
  symbols: string[]
  failedSymbols: Array<{ symbol: string; error: string }>
  models: ReplayComparisonModel[]
}

export class ReplayWindowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayWindowError'
  }
}

export async function buildReplayComparison(input: ReplayComparisonInput): Promise<ReplayComparison> {
  const lookback = replayLookbackBars(input.from, input.today)
  if (lookback > MAX_REPLAY_LOOKBACK_BARS) {
    throw new ReplayWindowError(`'from' ${input.from} is beyond the ~5y daily-bar history the bar source serves`)
  }

  // A symbol whose fetch failed is dropped for every model, so all models
  // are always compared on the identical symbol set.
  const failedSymbols: Array<{ symbol: string; error: string }> = []
  const barsBySymbol = new Map<string, DailyBar[]>()
  await Promise.all(
    input.symbols.map(async (symbol) => {
      try {
        barsBySymbol.set(symbol, await input.loadBars(symbol, lookback))
      } catch (err) {
        failedSymbols.push({ symbol, error: err instanceof Error ? err.message : String(err) })
      }
    }),
  )
  const ordered = new Map(input.symbols.filter((s) => barsBySymbol.has(s)).map((s) => [s, barsBySymbol.get(s)!]))

  const window = {
    from: input.from,
    to: input.to,
    initialCashUsd: input.initialCashUsd,
    initialCashJpy: input.initialCashJpy,
  }
  const models: ReplayComparisonModel[] = []
  for (const model of input.models.slice(0, MAX_REPLAY_MODELS)) {
    const periods = input.deployments.filter((d) => d.modelId === model.id)
    models.push({
      id: model.id,
      label: model.label,
      kind: model.spec.kind,
      params: model.spec.params,
      isActive: periods.some((d) => d.endedAt === null),
      livePeriods: periods.map((d) => ({ startedAt: d.startedAt, endedAt: d.endedAt })),
      result: await replayModel(model.spec, ordered, window),
    })
  }

  return { from: input.from, to: input.to, symbols: [...ordered.keys()], failedSymbols, models }
}

/**
 * Default model set: every model that has ever been live in the env (so a
 * replaced model keeps being tracked), plus any explicitly requested ids.
 */
export function selectReplayModels(
  all: StrategyModelRecord[],
  deployments: ModelDeploymentRecord[],
  requestedIds: number[],
): StrategyModelRecord[] {
  const wanted = new Set<number>([...deployments.map((d) => d.modelId), ...requestedIds])
  const picked = all.filter((m) => wanted.has(m.id))
  return (picked.length > 0 ? picked : all).slice(0, MAX_REPLAY_MODELS)
}

/** Default window start: the env's first promotion, else one year before `today`. */
export function defaultReplayFrom(deployments: ModelDeploymentRecord[], today: Date): string {
  const first = deployments.map((d) => d.startedAt).sort()[0]
  if (first) return first.slice(0, 10)
  const d = new Date(today.getTime())
  d.setUTCFullYear(d.getUTCFullYear() - 1)
  return d.toISOString().slice(0, 10)
}
