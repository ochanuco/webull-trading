import { describe, expect, it, vi } from 'vitest'
import type { BarClient, IntradayBar } from '../../../src/infrastructure/quotes/BarClient'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'
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
    expect(summary.decisions).toHaveLength(1)
    expect(summary.decisions[0]).toMatchObject({
      symbol: 'AAPL',
      decision: 'BUY',
      order: { side: 'BUY' },
    })
    expect(summary.decisions[0]?.trace?.map((step) => step.label)).toContain('entry.adopt_buy')
    expect(summary.decisions[0]?.trace?.map((step) => step.label)).toContain('broker.submit')
    expect(summary.decisions[0]?.trace?.find((step) => step.label === 'broker.submit')?.label_ja).toBe('証券会社への発注送信')
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
    expect(summary.decisions).toEqual([
      {
        symbol: 'AAPL',
        decision: 'REJECT',
        reason: 'insufficient bars for indicators',
      },
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

  it('uses intraday 1h close as fill price when getIntradayBars resolves', async () => {
    // 既存 BUY fixture (uptrendBars) は daily last close = 117.5。chart UI と
    // 整合させるため cron は intraday の最新 close を採用するのが今回の挙動。
    // 117.5 とは別の値 (118.25) を返して fill 価格 (= intent.price) がそちらに
    // なることを確認する。
    const intradayBars: IntradayBar[] = [
      { timestamp: '2026-04-20T13:00:00.000Z', open: 117.6, high: 118.4, low: 117.4, close: 118.0 },
      { timestamp: '2026-04-20T14:00:00.000Z', open: 118.0, high: 118.5, low: 117.9, close: 118.25 },
    ]
    const store = makeStore({})
    const execution = mockExecution()
    const barClient: BarClient = {
      getDailyBars: vi.fn(async () => uptrendBars()),
      getIntradayBars: vi.fn(async () => intradayBars),
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient,
      positionStore: store,
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const intent = execution.calls[0] as { side: string; price: number }
    expect(intent.side).toBe('BUY')
    expect(intent.price).toBe(118.25)
    // decision sink に渡る price も intraday 由来のものになっていること
    expect(summary.decisions[0]?.price).toBe(118.25)
  })

  it('falls back to daily close when getIntradayBars rejects', async () => {
    const store = makeStore({})
    const execution = mockExecution()
    const barClient: BarClient = {
      getDailyBars: vi.fn(async () => uptrendBars()),
      getIntradayBars: vi.fn(async () => {
        throw new Error('yahoo 429')
      }),
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient,
      positionStore: store,
      execution,
      now: () => now,
    })

    // intraday 失敗は致命扱いせず daily close (= 117.5) で fallback。
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { side: string; price: number }
    expect(intent.price).toBe(117.5)
  })

  it('fires notifier with TRADE event on a successful BUY (#199)', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(event) {
        events.push(event)
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: mockExecution(),
      notifier,
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    // microtask drain so fire-and-forget notify は test 完了前に reach する
    await Promise.resolve()
    const trade = events.find((e) => e.type === 'TRADE') as Extract<NotificationEvent, { type: 'TRADE' }> | undefined
    expect(trade).toBeDefined()
    expect(trade?.side).toBe('BUY')
    expect(trade?.symbol).toBe('AAPL')
    expect(trade?.mode).toBe('DRY_RUN')
    expect(trade?.realizedPnl).toBeUndefined()
  })

  it('fires notifier with ERROR event on bar fetch failure (#199)', async () => {
    const events: NotificationEvent[] = []
    const notifier: Notifier = {
      async notify(event) {
        events.push(event)
      },
    }
    const crashingClient: BarClient = {
      async getDailyBars() {
        throw new Error('upstream 500')
      },
    }
    await runPullbackScheduler({
      symbols: ['BROKEN'],
      equity: 100_000,
      barClient: crashingClient,
      positionStore: makeStore({}),
      execution: mockExecution(),
      notifier,
      now: () => now,
    })

    await Promise.resolve()
    const err = events.find((e) => e.type === 'ERROR') as Extract<NotificationEvent, { type: 'ERROR' }> | undefined
    expect(err).toBeDefined()
    expect(err?.symbol).toBe('BROKEN')
    expect(err?.cause).toBe('bar fetch')
    expect(err?.message).toContain('upstream 500')
  })

  it('does not let a throwing notifier break the scheduler (silent fallback) (#199)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier: Notifier = {
      async notify() {
        throw new Error('notifier exploded')
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: mockExecution(),
      notifier,
      now: () => now,
    })

    // notifier failure must not block the BUY path.
    expect(summary.buys).toBe(1)
    await Promise.resolve()
    warnSpy.mockRestore()
  })

  it('does not call notifier when one is not provided (back-compat) (#199)', async () => {
    // Sanity: existing call sites without `notifier` keep working.
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: mockExecution(),
      now: () => now,
    })
    expect(summary.buys).toBe(1)
  })
})

describe('runPullbackScheduler per-symbol risk gate (#138 parity)', () => {
  // Default risk config matches global_config defaults; production wires this
  // through runStrategyCron so cron / `/trade/execute` evaluate the same gates.
  const baseRiskConfig = {
    inversePairs: {} as Record<string, string>,
    spreadLimits: { US: 0.0025, JP: 0.006 },
    staleQuoteMs: 15 * 60 * 1_000,
    gapRejectPct: 0.03,
  }

  it('rejects BUY when settledCash is insufficient (gate parity)', async () => {
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      // tiny settledCash → uptrendBars BUY notional (qty>0 × ~$118) exceeds it
      settledCash: 1,
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: state }),
      execution,
      perSymbolRisk: baseRiskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('insufficient settled cash')
  })

  it('rejects BUY when lastQuote is stale (halt fallback)', async () => {
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      lastQuote: {
        price: 118,
        asOf: new Date(now.getTime() - 16 * 60 * 1_000).toISOString(),
        fetchedAt: new Date(now.getTime() - 16 * 60 * 1_000).toISOString(),
        source: 'test',
        bid: 117.9,
        ask: 118.1,
      },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: state }),
      execution,
      perSymbolRisk: baseRiskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('halt or stale quote')
  })

  it('rejects BUY when spread exceeds the US limit (fail-closed missing bid)', async () => {
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      lastQuote: {
        price: 118,
        asOf: now.toISOString(),
        fetchedAt: now.toISOString(),
        source: 'test',
        // bid missing → fail-closed reject
        bid: undefined,
        ask: 118.1,
      },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: state }),
      execution,
      perSymbolRisk: baseRiskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('bid/ask missing')
  })

  it('rejects BUY when inverseState shows an open position', async () => {
    const inverse: SymbolState = {
      ...emptySymbolState('SQQQ', () => now),
      position: { qty: 5, avgPrice: 10, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['QQQ'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SQQQ: inverse }),
      execution,
      perSymbolRisk: { ...baseRiskConfig, inversePairs: { QQQ: 'SQQQ' } },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('inverse-pair exposure')
  })

  it('approves BUY when no per-symbol gate fires', async () => {
    // settledCash 0 (unseeded) + lastQuote null (unseeded) → all gates skip;
    // proves the gate is wired but does not block clean inputs.
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      perSymbolRisk: baseRiskConfig,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })

  it('skips the gate when perSymbolRisk option is omitted (back-compat)', async () => {
    // No perSymbolRisk → existing behaviour, even when state would trip
    // the gate (stale quote here) the BUY proceeds.
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      lastQuote: {
        price: 118,
        asOf: new Date(now.getTime() - 16 * 60 * 1_000).toISOString(),
        fetchedAt: new Date(now.getTime() - 16 * 60 * 1_000).toISOString(),
        source: 'test',
        bid: 117.9,
        ask: 118.1,
      },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: state }),
      execution,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })
})

describe('runPullbackScheduler earnings calendar gate (#196)', () => {
  it('rejects BUY when an earnings_calendar row is within ±1 BD', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      earningsGate: {
        repo: {
          async fetchByRange() {
            // Always returns one row whose date matches the eval day.
            return [
              {
                id: 1,
                symbol: 'AAPL',
                earningsDate: now.toISOString().slice(0, 10),
                notes: null,
                createdAt: now.toISOString(),
              },
            ]
          },
          async fetchBySymbol() {
            return []
          },
          async bulkUpsert() {
            return { inserted: 0, skipped: 0 }
          },
          async deleteById() {
            return false
          },
        },
        freezeBusinessDays: 1,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('risk: earnings_within_1bd')
  })

  it('approves BUY when earnings repo returns no rows', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      earningsGate: {
        repo: {
          async fetchByRange() {
            return []
          },
          async fetchBySymbol() {
            return []
          },
          async bulkUpsert() {
            return { inserted: 0, skipped: 0 }
          },
          async deleteById() {
            return false
          },
        },
        freezeBusinessDays: 1,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })

  it('skips the earnings gate when option is omitted (back-compat)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
  })
})
