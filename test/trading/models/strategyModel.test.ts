import { describe, expect, it } from 'vitest'
import { GLOBAL_CONFIG_DEFAULTS } from '../../../src/infrastructure/db/globalConfigRepo'
import {
  buildReplayStrategy,
  canonicalParamsJson,
  globalConfigPatchForPullback,
  hashModelSpec,
  ModelParamsError,
  parseModelSpec,
  PROMOTABLE_MODEL_KINDS,
  pullbackDriftKeys,
  pullbackParamsFromGlobalConfig,
  type PullbackModelParams,
} from '../../../src/trading/models/strategyModel'
import { BreakoutMomentumStrategy } from '../../../src/trading/strategy/strategies/BreakoutMomentumStrategy'
import { PullbackUptrendStrategy } from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

const PULLBACK: PullbackModelParams = {
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2,
  maxSma50DeviationPct: 0.6,
  maxAtrRatio: 1.5,
  maxStopToTpRatio: 2,
  atrBaselineMode: 'percentile',
}

const MOMENTUM = {
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
}

function parseError(kind: unknown, params: unknown): ModelParamsError {
  try {
    parseModelSpec(kind, params)
  } catch (err) {
    if (err instanceof ModelParamsError) return err
    throw err
  }
  throw new Error('expected ModelParamsError')
}

describe('parseModelSpec', () => {
  it('accepts a complete pullback parameter set', () => {
    expect(parseModelSpec('pullback_uptrend', PULLBACK)).toEqual({ kind: 'pullback_uptrend', params: PULLBACK })
  })

  it('accepts a complete momentum parameter set', () => {
    expect(parseModelSpec('breakout_momentum', MOMENTUM).kind).toBe('breakout_momentum')
  })

  it('rejects an unknown kind', () => {
    expect(parseError('mean_reversion', PULLBACK).field).toBe('kind')
  })

  it('rejects a missing key instead of filling it from current defaults', () => {
    const { kAtr: _kAtr, ...partial } = PULLBACK
    expect(parseError('pullback_uptrend', partial).field).toBe('kAtr')
  })

  it('rejects an unknown (typo) key', () => {
    expect(parseError('pullback_uptrend', { ...PULLBACK, takeProfit: 0.07 }).field).toBe('takeProfit')
  })

  it.each([
    ['stopPct', 0.04],
    ['takeProfitPct', 0],
    ['timeStopDays', 2.5],
    ['timeStopDays', 366],
    ['kAtr', 0],
    ['maxAtrRatio', Number.NaN],
  ])('rejects out-of-range %s=%s', (field, value) => {
    expect(parseError('pullback_uptrend', { ...PULLBACK, [field]: value }).field).toBe(field)
  })

  it('rejects an inverted pullback window', () => {
    expect(parseError('pullback_uptrend', { ...PULLBACK, pullbackMin: -0.02, pullbackMax: -0.05 }).field).toBe(
      'pullbackMin',
    )
  })

  it('rejects a non-boolean requireAboveSma50', () => {
    expect(parseError('pullback_uptrend', { ...PULLBACK, requireAboveSma50: 1 }).field).toBe('requireAboveSma50')
  })
})

describe('hashModelSpec', () => {
  it('is independent of key order', async () => {
    const reversed = Object.fromEntries(Object.entries(PULLBACK).reverse())
    const a = parseModelSpec('pullback_uptrend', PULLBACK)
    const b = parseModelSpec('pullback_uptrend', reversed)
    expect(canonicalParamsJson(a)).toBe(canonicalParamsJson(b))
    expect(await hashModelSpec(a)).toBe(await hashModelSpec(b))
  })

  it('changes when any single param changes', async () => {
    const a = await hashModelSpec(parseModelSpec('pullback_uptrend', PULLBACK))
    const b = await hashModelSpec(parseModelSpec('pullback_uptrend', { ...PULLBACK, kAtr: 2.1 }))
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('global_config mapping', () => {
  it('round-trips pullback params through the global_config patch', () => {
    const patch = globalConfigPatchForPullback(PULLBACK)
    const global = { ...GLOBAL_CONFIG_DEFAULTS, ...patch }
    expect(pullbackParamsFromGlobalConfig(global)).toEqual(PULLBACK)
  })

  it('never writes the dry_run / trading_enabled safety switches', () => {
    const patch = globalConfigPatchForPullback(PULLBACK) as Record<string, unknown>
    expect(patch).not.toHaveProperty('dryRun')
    expect(patch).not.toHaveProperty('tradingEnabled')
  })

  it('reports keys hand-edited away from the active model', () => {
    const global = { ...GLOBAL_CONFIG_DEFAULTS, ...globalConfigPatchForPullback(PULLBACK), pullbackDefaultKAtr: 3 }
    expect(pullbackDriftKeys(PULLBACK, global)).toEqual(['kAtr'])
  })
})

describe('buildReplayStrategy', () => {
  it('builds the live pullback strategy from model params', () => {
    const built = buildReplayStrategy({ kind: 'pullback_uptrend', params: { ...PULLBACK, atrBaselineMode: 'overlap' } })
    expect(built.strategy).toBeInstanceOf(PullbackUptrendStrategy)
    expect(built.rule.kAtr).toBe(2)
    expect(built.atrBaselineMode).toBe('overlap')
  })

  it('builds the momentum strategy for breakout models', () => {
    const built = buildReplayStrategy(parseModelSpec('breakout_momentum', MOMENTUM))
    expect(built.strategy).toBeInstanceOf(BreakoutMomentumStrategy)
  })
})

describe('PROMOTABLE_MODEL_KINDS', () => {
  it('only allows kinds the live scheduler dispatches', () => {
    expect(PROMOTABLE_MODEL_KINDS.has('pullback_uptrend')).toBe(true)
    expect(PROMOTABLE_MODEL_KINDS.has('breakout_momentum')).toBe(false)
  })
})
