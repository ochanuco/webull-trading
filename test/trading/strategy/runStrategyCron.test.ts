import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadGlobalConfigFrom } from '../../../src/infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../../../src/infrastructure/db/symbolUniverse'
import { runStrategyCron } from '../../../src/trading/strategy/runStrategyCron'
import { makeGlobalConfigSnapshot, makeSymbolUniverse } from '../../helpers/configFixtures'

vi.mock('../../../src/infrastructure/db/globalConfigLoader', () => ({
  loadGlobalConfigFrom: vi.fn(),
}))
vi.mock('../../../src/infrastructure/db/symbolUniverse', () => ({
  loadSymbolUniverse: vi.fn(),
}))

const env = {
  DB: {} as D1Database,
  SYMBOL_STATE: {} as DurableObjectNamespace<never>,
} as unknown as Parameters<typeof runStrategyCron>[0]

describe('runStrategyCron', () => {
  beforeEach(() => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(makeGlobalConfigSnapshot())
    vi.mocked(loadSymbolUniverse).mockResolvedValue(makeSymbolUniverse())
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('skips with trading_disabled when tradingEnabled=false', async () => {
    vi.mocked(loadGlobalConfigFrom).mockResolvedValue(
      makeGlobalConfigSnapshot({ tradingEnabled: false }),
    )
    const result = await runStrategyCron(env)
    expect(result.skipReason).toBe('trading_disabled')
    expect(result.summary.evaluated).toBe(0)
  })

  it('skips with no_us_symbols when universe is JP-only', async () => {
    vi.mocked(loadSymbolUniverse).mockResolvedValue(
      makeSymbolUniverse({
        allowedSymbols: ['6301', '4502'],
        symbolCurrency: { '6301': 'JPY', '4502': 'JPY' },
      }),
    )
    const result = await runStrategyCron(env)
    expect(result.skipReason).toBe('no_us_symbols')
  })

  it('skips with no_bridge_state when SYMBOL_STATE binding is missing', async () => {
    const envWithout = { DB: {} } as unknown as Parameters<typeof runStrategyCron>[0]
    const result = await runStrategyCron(envWithout)
    expect(result.skipReason).toBe('no_bridge_state')
  })
})
