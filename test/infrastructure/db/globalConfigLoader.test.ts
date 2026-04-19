import { describe, expect, it, vi } from 'vitest'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { GLOBAL_CONFIG_DEFAULTS } from '../../../src/infrastructure/db/globalConfigRepo'

function fakeD1WithRow(row: Record<string, unknown> | undefined) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : [])
  const where = vi.fn().mockReturnValue({ limit })
  const from = vi.fn().mockReturnValue({ where })
  const select = vi.fn().mockReturnValue({ from })
  const fakeDrizzle = { select }
  // createDb wraps a D1Database — we short-circuit by tagging the fake so the
  // loader's createDb() call returns the same object.
  return {
    prepare: vi.fn(),
    __drizzle: fakeDrizzle,
  } as unknown as D1Database
}

describe('loadGlobalConfigFrom', () => {
  it('env fallback when DB binding is missing', async () => {
    const snapshot = await loadGlobalConfigFrom({
      DRY_RUN: 'false',
      TRADING_ENABLED: 'true',
      MAX_ORDER_NOTIONAL: '250',
      DRAWDOWN_KILL_THRESHOLD: '-0.03',
      SPREAD_LIMIT_PCT_US: '0.25',
      BRIDGE_RUN_MODE: 'always-on',
    })
    expect(snapshot.source).toBe('env')
    expect(snapshot.dryRun).toBe(false)
    expect(snapshot.tradingEnabled).toBe(true)
    expect(snapshot.maxOrderNotional).toBe(250)
    expect(snapshot.drawdownKillThreshold).toBe(-0.03)
    expect(snapshot.spreadLimitPctUs).toBeCloseTo(0.0025, 6)
    expect(snapshot.bridgeRunMode).toBe('always-on')
  })

  it('falls back to defaults for missing env values', async () => {
    const snapshot = await loadGlobalConfigFrom({})
    expect(snapshot.source).toBe('env')
    expect(snapshot.dryRun).toBe(GLOBAL_CONFIG_DEFAULTS.dryRun)
    expect(snapshot.tradingEnabled).toBe(GLOBAL_CONFIG_DEFAULTS.tradingEnabled)
    expect(snapshot.maxOrderNotional).toBe(GLOBAL_CONFIG_DEFAULTS.maxOrderNotional)
    expect(snapshot.drawdownKillThreshold).toBe(GLOBAL_CONFIG_DEFAULTS.drawdownKillThreshold)
    expect(snapshot.spreadLimitPctUs).toBe(GLOBAL_CONFIG_DEFAULTS.spreadLimitPctUs)
    expect(snapshot.bridgeRunMode).toBe(GLOBAL_CONFIG_DEFAULTS.bridgeRunMode)
  })
})
