import { describe, expect, it, vi } from 'vitest'
import type { BarClient } from '../../../src/infrastructure/quotes/BarClient'
import type { Execution } from '../../../src/trading/execution/Execution'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type SymbolState } from '../../../src/trading/state/types'
import { runPullbackScheduler } from '../../../src/trading/strategy/pullbackScheduler'
import type { DailyBar } from '../../../src/trading/strategy/indicators'

const now = new Date('2026-04-20T14:30:00.000Z')

function uptrendBars(): DailyBar[] {
  // 60 bars, uptrend ~+15% over 50d, ending with a mild -4% pullback from high.
  const bars: DailyBar[] = []
  for (let i = 0; i < 55; i += 1) {
    const close = 100 + i * 0.4 // slow uptrend, ends at ~121.6
    bars.push(synth(i, close))
  }
  // The 20d high hit at bar 55
  bars.push(synth(55, 122))
  bars.push(synth(56, 121))
  bars.push(synth(57, 120))
  bars.push(synth(58, 118))
  // pullback: -4% from high 122 = 117.12 → put close at ~117.5
  bars.push(synth(59, 117.5))
  return bars
}

function synth(i: number, close: number): DailyBar {
  const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  return { date, open: close, high: close * 1.005, low: close * 0.995, close }
}

function makeStore(states: Record<string, SymbolState>) {
  return {
    async getState(symbol: string) {
      return states[symbol.toUpperCase()] ?? emptySymbolState(symbol, () => now)
    },
    async lockPendingOrder() {
      return { ok: true, state: emptySymbolState('_', () => now) }
    },
    async clearPendingOrder(symbol: string) {
      return emptySymbolState(symbol, () => now)
    },
    async recordFill(symbol: string) {
      return emptySymbolState(symbol, () => now)
    },
    async addPendingSettlement(symbol: string) {
      return emptySymbolState(symbol, () => now)
    },
    async setCooldown(symbol: string) {
      return emptySymbolState(symbol, () => now)
    },
    async seedSettledCash(symbol: string) {
      return emptySymbolState(symbol, () => now)
    },
  } satisfies PositionStore
}

function mockBarClient(bars: DailyBar[]): BarClient {
  return { getDailyBars: vi.fn(async () => bars) }
}

function mockExecution(): Execution & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async execute(intent) {
      calls.push(intent)
      return {
        mode: 'DRY_RUN',
        submitted: true,
        brokerOrderId: 'dry-run-1',
      }
    },
  }
}

describe('runPullbackScheduler', () => {
  it('places a BUY when the Pullback entry conditions fire', async () => {
    const store = makeStore({})
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: store,
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const intent = execution.calls[0] as { side: string; quantity: number }
    expect(intent.side).toBe('BUY')
    expect(intent.quantity).toBeGreaterThan(0)
  })

  it('HOLDs (and does not submit) when bars are too short for indicators', async () => {
    const store = makeStore({})
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient([synth(0, 100), synth(1, 101)]),
      positionStore: store,
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(summary.rejected).toEqual([
      { symbol: 'AAPL', reason: 'insufficient bars for indicators' },
    ])
    expect(execution.calls).toHaveLength(0)
  })

  it('records bar-client errors without halting the rest of the universe', async () => {
    const store = makeStore({})
    const execution = mockExecution()
    const crashingClient: BarClient = {
      async getDailyBars(symbol) {
        if (symbol === 'BROKEN') throw new Error('upstream 500')
        return uptrendBars()
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['BROKEN', 'AAPL'],
      equity: 100_000,
      barClient: crashingClient,
      positionStore: store,
      execution,
      now: () => now,
    })

    expect(summary.errors).toEqual([{ symbol: 'BROKEN', message: 'upstream 500' }])
    expect(summary.buys).toBe(1)
  })
})
