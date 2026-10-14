import type { GlobalConfigSnapshot } from '../../infrastructure/db/globalConfigRepo'
import { MAX_TIME_STOP_DAYS } from '../../infrastructure/db/schema'
import type { AtrBaselineMode } from '../strategy/indicators'
import { BreakoutMomentumStrategy, type MomentumRule } from '../strategy/strategies/BreakoutMomentumStrategy'
import {
  PullbackUptrendStrategy,
  TEST_DEFAULT_RULE,
  type SymbolRule,
} from '../strategy/strategies/PullbackUptrendStrategy'

const STRATEGY_MODEL_KINDS = ['pullback_uptrend', 'breakout_momentum'] as const
export type StrategyModelKind = (typeof STRATEGY_MODEL_KINDS)[number]

/**
 * Only kinds the live scheduler actually dispatches can be promoted.
 * breakout_momentum is backtest-only (not wired into runStrategyCron), so
 * "promoting" it would record a deployment that changes nothing live.
 */
export const PROMOTABLE_MODEL_KINDS: ReadonlySet<StrategyModelKind> = new Set(['pullback_uptrend'])

export interface PullbackModelParams {
  stopPct: number
  takeProfitPct: number
  timeStopDays: number
  pullbackMax: number
  pullbackMin: number
  minReturn50d: number
  requireAboveSma50: boolean
  kAtr: number
  maxSma50DeviationPct: number
  maxAtrRatio: number
  maxStopToTpRatio: number
  atrBaselineMode: AtrBaselineMode
}

interface MomentumModelParams extends MomentumRule {
  atrBaselineMode: AtrBaselineMode
}

export type StrategyModelSpec =
  | { kind: 'pullback_uptrend'; params: PullbackModelParams }
  | { kind: 'breakout_momentum'; params: MomentumModelParams }

export class ModelParamsError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message)
    this.name = 'ModelParamsError'
  }
}

function isStrategyModelKind(value: unknown): value is StrategyModelKind {
  return typeof value === 'string' && (STRATEGY_MODEL_KINDS as readonly string[]).includes(value)
}

/**
 * Validates a complete parameter set. Every key is required — a partial set
 * filled from "current defaults" would make the same model id mean different
 * things depending on when it was registered, breaking replay.
 */
export function parseModelSpec(kind: unknown, raw: unknown): StrategyModelSpec {
  if (!isStrategyModelKind(kind)) {
    throw new ModelParamsError(`kind must be one of ${STRATEGY_MODEL_KINDS.join(', ')}`, 'kind')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ModelParamsError('params must be an object', 'params')
  }
  const r = raw as Record<string, unknown>
  if (kind === 'pullback_uptrend') {
    return { kind, params: parsePullbackParams(r) }
  }
  return { kind, params: parseMomentumParams(r) }
}

function parsePullbackParams(r: Record<string, unknown>): PullbackModelParams {
  rejectUnknownKeys(r, PULLBACK_KEYS)
  // Ranges mirror global_config's CHECK constraints so a model that passes
  // here can't fail the UPDATE at promotion time.
  const params: PullbackModelParams = {
    stopPct: num(r, 'stopPct', (v) => v < 0 && v >= -1, '< 0 and >= -1'),
    takeProfitPct: num(r, 'takeProfitPct', (v) => v > 0 && v <= 1, '> 0 and <= 1'),
    timeStopDays: num(
      r,
      'timeStopDays',
      (v) => Number.isInteger(v) && v > 0 && v <= MAX_TIME_STOP_DAYS,
      `an integer in 1..${MAX_TIME_STOP_DAYS}`,
    ),
    pullbackMax: num(r, 'pullbackMax', (v) => v <= 0 && v >= -1, '<= 0 and >= -1'),
    pullbackMin: num(r, 'pullbackMin', (v) => v <= 0 && v >= -1, '<= 0 and >= -1'),
    minReturn50d: num(r, 'minReturn50d', (v) => v >= -1 && v <= 10, '>= -1 and <= 10'),
    requireAboveSma50: bool(r, 'requireAboveSma50'),
    kAtr: num(r, 'kAtr', (v) => v > 0 && v <= 10, '> 0 and <= 10'),
    maxSma50DeviationPct: num(r, 'maxSma50DeviationPct', (v) => v > 0, '> 0'),
    maxAtrRatio: num(r, 'maxAtrRatio', (v) => v > 0, '> 0'),
    maxStopToTpRatio: num(r, 'maxStopToTpRatio', (v) => v >= 0, '>= 0'),
    atrBaselineMode: baselineMode(r),
  }
  if (params.pullbackMin > params.pullbackMax) {
    throw new ModelParamsError('pullbackMin must be <= pullbackMax', 'pullbackMin')
  }
  return params
}

function parseMomentumParams(r: Record<string, unknown>): MomentumModelParams {
  rejectUnknownKeys(r, MOMENTUM_KEYS)
  return {
    stopPct: num(r, 'stopPct', (v) => v < 0 && v >= -1, '< 0 and >= -1'),
    takeProfitPct: num(r, 'takeProfitPct', (v) => v > 0 && v <= 1, '> 0 and <= 1'),
    timeStopDays: num(
      r,
      'timeStopDays',
      (v) => Number.isInteger(v) && v > 0 && v <= MAX_TIME_STOP_DAYS,
      `an integer in 1..${MAX_TIME_STOP_DAYS}`,
    ),
    kAtr: num(r, 'kAtr', (v) => v > 0 && v <= 10, '> 0 and <= 10'),
    minReturn: num(r, 'minReturn', (v) => v >= -1 && v <= 10, '>= -1 and <= 10'),
    breakoutBuffer: num(r, 'breakoutBuffer', (v) => v >= 0 && v <= 1, '>= 0 and <= 1'),
    maxSma50DeviationPct: num(r, 'maxSma50DeviationPct', (v) => v > 0, '> 0'),
    requireAboveSma50: bool(r, 'requireAboveSma50'),
    maxStopToTpRatio: num(r, 'maxStopToTpRatio', (v) => v >= 0, '>= 0'),
    atrBaselineMode: baselineMode(r),
  }
}

const PULLBACK_KEYS: ReadonlySet<string> = new Set([
  'stopPct',
  'takeProfitPct',
  'timeStopDays',
  'pullbackMax',
  'pullbackMin',
  'minReturn50d',
  'requireAboveSma50',
  'kAtr',
  'maxSma50DeviationPct',
  'maxAtrRatio',
  'maxStopToTpRatio',
  'atrBaselineMode',
])

const MOMENTUM_KEYS: ReadonlySet<string> = new Set([
  'stopPct',
  'takeProfitPct',
  'timeStopDays',
  'kAtr',
  'minReturn',
  'breakoutBuffer',
  'maxSma50DeviationPct',
  'requireAboveSma50',
  'maxStopToTpRatio',
  'atrBaselineMode',
])

// A typo'd key (e.g. `takeProfit`) would otherwise be silently dropped and
// the model registered with a missing-key error that hides the real cause.
function rejectUnknownKeys(r: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(r)) {
    if (!allowed.has(key)) throw new ModelParamsError(`unknown param '${key}'`, key)
  }
}

function num(
  r: Record<string, unknown>,
  key: string,
  ok: (v: number) => boolean,
  expectation: string,
): number {
  const v = r[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ModelParamsError(`'${key}' must be a finite number`, key)
  }
  if (!ok(v)) throw new ModelParamsError(`'${key}' must be ${expectation}`, key)
  return v
}

function bool(r: Record<string, unknown>, key: string): boolean {
  const v = r[key]
  if (typeof v !== 'boolean') throw new ModelParamsError(`'${key}' must be a boolean`, key)
  return v
}

function baselineMode(r: Record<string, unknown>): AtrBaselineMode {
  const v = r.atrBaselineMode
  if (v === 'overlap' || v === 'exclude-recent' || v === 'percentile') return v
  throw new ModelParamsError(
    "'atrBaselineMode' must be 'overlap', 'exclude-recent' or 'percentile'",
    'atrBaselineMode',
  )
}

export function canonicalParamsJson(spec: StrategyModelSpec): string {
  const params = spec.params as unknown as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(params).sort()) sorted[key] = params[key]
  return JSON.stringify(sorted)
}

export async function hashModelSpec(spec: StrategyModelSpec): Promise<string> {
  const bytes = new TextEncoder().encode(`${spec.kind}:${canonicalParamsJson(spec)}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The pullback model the live scheduler is effectively running right now. */
export function pullbackParamsFromGlobalConfig(global: GlobalConfigSnapshot): PullbackModelParams {
  return {
    stopPct: global.pullbackDefaultStopPct,
    takeProfitPct: global.pullbackDefaultTakeProfitPct,
    timeStopDays: global.pullbackDefaultTimeStopDays,
    pullbackMax: global.pullbackDefaultPullbackMax,
    pullbackMin: global.pullbackDefaultPullbackMin,
    minReturn50d: global.pullbackDefaultMinReturn50d,
    requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
    kAtr: global.pullbackDefaultKAtr,
    maxSma50DeviationPct: global.pullbackDefaultMaxSma50DeviationPct,
    maxAtrRatio: global.pullbackDefaultMaxAtrRatio,
    maxStopToTpRatio: global.pullbackDefaultMaxStopToTpRatio,
    atrBaselineMode: global.atrBaselineMode,
  }
}

/** global_config columns a pullback promotion writes. Never includes dry_run / trading_enabled. */
export function globalConfigPatchForPullback(params: PullbackModelParams) {
  return {
    pullbackDefaultStopPct: params.stopPct,
    pullbackDefaultTakeProfitPct: params.takeProfitPct,
    pullbackDefaultTimeStopDays: params.timeStopDays,
    pullbackDefaultPullbackMax: params.pullbackMax,
    pullbackDefaultPullbackMin: params.pullbackMin,
    pullbackDefaultMinReturn50d: params.minReturn50d,
    pullbackDefaultRequireAboveSma50: params.requireAboveSma50,
    pullbackDefaultKAtr: params.kAtr,
    pullbackDefaultMaxSma50DeviationPct: params.maxSma50DeviationPct,
    pullbackDefaultMaxAtrRatio: params.maxAtrRatio,
    pullbackDefaultMaxStopToTpRatio: params.maxStopToTpRatio,
    atrBaselineMode: params.atrBaselineMode,
  }
}

/**
 * Keys where live global_config no longer matches the active model — i.e.
 * someone edited global_config by hand after promotion, so replaying the
 * active model no longer reproduces what production ran.
 */
export function pullbackDriftKeys(params: PullbackModelParams, global: GlobalConfigSnapshot): string[] {
  const live = pullbackParamsFromGlobalConfig(global)
  return (Object.keys(params) as Array<keyof PullbackModelParams>).filter((k) => params[k] !== live[k])
}

/** Inputs `runBacktest` needs to replay a model. */
export function buildReplayStrategy(spec: StrategyModelSpec): {
  rule: SymbolRule
  strategy: PullbackUptrendStrategy | BreakoutMomentumStrategy
  atrBaselineMode: AtrBaselineMode
} {
  if (spec.kind === 'pullback_uptrend') {
    const { atrBaselineMode, ...rest } = spec.params
    // runBacktest doesn't feed lastExitPrice, so the re-entry guard is inert
    // in replay; the live hardcoded values are carried only to complete the type.
    const rule: SymbolRule = { ...rest, reentryMinAtrBelowLastExit: 1.0, reentryGuardBusinessDays: 3 }
    return { rule, strategy: new PullbackUptrendStrategy(rule), atrBaselineMode }
  }
  const { atrBaselineMode, ...momentumRule } = spec.params
  // `rule` is required by BacktestParams but ignored once `strategy` is given.
  return {
    rule: TEST_DEFAULT_RULE,
    strategy: new BreakoutMomentumStrategy(momentumRule),
    atrBaselineMode,
  }
}
