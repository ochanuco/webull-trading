import { describe, expect, it, vi } from 'vitest'
import type { BarClient, IntradayBar } from '../../../src/infrastructure/quotes/BarClient'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'
import {
  BrokerClientError,
  BrokerServerError,
  WEBULL_SELL_QTY_EXCEED_CODE,
} from '../../../src/shared/errors'
import type { Execution } from '../../../src/trading/execution/Execution'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type SymbolState } from '../../../src/trading/state/types'
import { runPullbackScheduler } from '../../../src/trading/strategy/pullbackScheduler'
import {
  createBuyingPowerLedger,
  createUnavailableBuyingPowerLedger,
} from '../../../src/trading/strategy/buyingPower'
import type { DailyBar } from '../../../src/trading/strategy/indicators'

const now = new Date('2026-04-20T14:30:00.000Z')

function uptrendBars(): DailyBar[] {
  // #318: short-term swing 整合化で trend filter は 20d return ベースになった。
  // closes[-20] vs last の return が +8% を超えるよう、最後の 20 営業日に
  // しっかりした上昇を入れる:
  //   - 40 bars: slow uptrend (warmup for SMA50)
  //   - 15 bars: steeper leg → 高値 122 まで
  //   - 5 bars: 高値到達 → mild -4% pullback (BUY ゾーン)
  // 結果: closes[-20] ≈ 108 (bar 40)、last = 117.5、20d return ≈ +8.8%。
  const bars: DailyBar[] = []
  for (let i = 0; i < 40; i += 1) {
    const close = 100 + i * 0.2 // gentle warmup, bar 39 close = 107.8
    bars.push(synth(i, close))
  }
  // bar 40 close = 108、20d return baseline がここに据わる。
  for (let i = 40; i < 55; i += 1) {
    const close = 108 + (i - 40) * 1.0 // steeper, bar 54 close = 122
    bars.push(synth(i, close))
  }
  // The 10d (was 20d, #318) high hit at bar 55
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
    async overridePosition(symbol: string) {
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

  it('places a BUY when bid/ask is missing but the source lacks it (Yahoo, #411 案A)', async () => {
    // TQQQ 再現: Yahoo feed は price のみで bid/ask 無し → spread guard を適用外に
    // して通す (fail-closed しない)。console.warn の skip ログは抑制。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const state: SymbolState = {
        ...emptySymbolState('AAPL', () => now),
        lastQuote: {
          price: 118,
          asOf: now.toISOString(),
          fetchedAt: now.toISOString(),
          source: 'yahoo-snapshot',
          bid: undefined,
          ask: undefined,
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
      expect(summary.buys).toBe(1)
      expect(execution.calls).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
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

describe('runPullbackScheduler macro event gate (#196 2/3)', () => {
  it('rejects BUY when a macro event is within the freeze window of eval timestamp', async () => {
    // FOMC 14:00 ET (= 18:30 UTC EDT) を `now` (= 14:30 UTC EDT に近い) と
    // 同瞬間に置く simple repo。`now` 経由で 14:30 UTC が渡るので CPI 08:30 ET
    // (= 12:30 UTC) を window 内に置く。
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      macroEventGate: {
        repo: {
          async fetchByDateRange() {
            // 2026-04-20 12:30 UTC = 08:30 EDT — `now` 14:30 UTC = 10:30 EDT。
            // 2h 差で window 外。代わりに 14:30 UTC = 10:30 EDT を CPI 時刻に
            // することで window 内に入れる。
            return [
              {
                id: 1,
                eventType: 'CPI',
                eventDate: '2026-04-20',
                eventTime: '10:30',
                notes: null,
                createdAt: now.toISOString(),
              },
            ]
          },
          async fetchAll() {
            return []
          },
          async bulkUpsert() {
            return { inserted: 0, skipped: 0 }
          },
          async deleteById() {
            return false
          },
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('risk: macro_event_gate: CPI')
  })

  it('approves BUY when macro repo returns no rows', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      macroEventGate: {
        repo: {
          async fetchByDateRange() {
            return []
          },
          async fetchAll() {
            return []
          },
          async bulkUpsert() {
            return { inserted: 0, skipped: 0 }
          },
          async deleteById() {
            return false
          },
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })

  it('skips the macro gate when option is omitted (back-compat)', async () => {
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

  it('earnings reason wins when both gates would reject (priority order)', async () => {
    // 両 gate 入れたら earnings の reject が先 (task 指定の優先順位 earnings → macro)。
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
      macroEventGate: {
        repo: {
          async fetchByDateRange() {
            return [
              {
                id: 1,
                eventType: 'CPI',
                eventDate: now.toISOString().slice(0, 10),
                eventTime: '10:30',
                notes: null,
                createdAt: now.toISOString(),
              },
            ]
          },
          async fetchAll() {
            return []
          },
          async bulkUpsert() {
            return { inserted: 0, skipped: 0 }
          },
          async deleteById() {
            return false
          },
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('earnings_within_1bd')
    expect(reject?.reason).not.toContain('macro_event_gate')
  })
})

describe('runPullbackScheduler VIX regime filter (#196 3/3)', () => {
  // Probe で「VIX 無し時の qty / notional」を確定させ、warning 時の half qty
  // を厳密に比較できるようにする。uptrendBars + equity 100k は決定的。
  async function probeBaseQty(): Promise<number> {
    const probe = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: mockExecution(),
      now: () => now,
    })
    return probe.decisions[0]?.order?.quantity ?? 0
  }

  it('blocks all BUY when VIX is critical (sizeScale = 0)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      vixDecision: {
        regime: 'critical',
        sizeScale: 0,
        reason: 'vix_critical: 35.10 (block)',
        vix: 35.1,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('risk: vix_critical')
    expect(summary.vix?.regime).toBe('critical')
  })

  it('halves BUY quantity in warning regime (sizeScale = 0.5)', async () => {
    const baseQty = await probeBaseQty()
    expect(baseQty).toBeGreaterThan(1) // half になっても 1 以上残る前提

    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      vixDecision: {
        regime: 'warning',
        sizeScale: 0.5,
        reason: 'vix_warning: 27.30 (size x0.5)',
        vix: 27.3,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const intent = execution.calls[0] as { side: string; quantity: number }
    expect(intent.side).toBe('BUY')
    // floor(baseQty * 0.5)
    expect(intent.quantity).toBe(Math.floor(baseQty * 0.5))
    expect(summary.vix?.regime).toBe('warning')
  })

  it('rejects BUY with VIX reason when warning sizeScale rounds qty below 1 share', async () => {
    // sizeScale が極端に小さい (0.001) 場合、qty * 0.001 → floor で 0 になる。
    // 「sizing は通ったが VIX 縮小で 0 になった」経路を確実に取りたいので、
    // 通常 sizing が通る入力で sizeScale だけ極端にする (実運用では現れない値だが
    // 境界条件として実装の正しさを担保する)。
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      vixDecision: {
        regime: 'warning',
        sizeScale: 0.001,
        reason: 'vix_warning: 27.30 (size x0.001)',
        vix: 27.3,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('vix_warning')
    expect(reject?.reason).toContain('qty rounded to 0')
  })

  it('does not modify BUY in normal regime (sizeScale = 1)', async () => {
    const baseQty = await probeBaseQty()
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      vixDecision: {
        regime: 'normal',
        sizeScale: 1.0,
        reason: 'vix_normal: 18.50',
        vix: 18.5,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(baseQty)
    expect(summary.vix?.regime).toBe('normal')
  })

  it('treats unavailable VIX (fail-open) as normal', async () => {
    const baseQty = await probeBaseQty()
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      vixDecision: {
        regime: 'normal',
        sizeScale: 1.0,
        reason: 'vix_unavailable_fallback_normal',
        vix: null,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(baseQty)
    expect(summary.vix?.vix).toBeNull()
  })

  it('skips the VIX filter entirely when vixDecision is omitted (back-compat)', async () => {
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
    expect(summary.vix).toBeUndefined()
  })

  it('does not block SELL even when VIX is critical', async () => {
    // existing position から SELL 経路を作る。SELL は VIX 関係なく通る前提。
    // (uptrendBars の最後 4% pullback は BUY ではなく実際には HOLD/BUY 判定なので、
    // SELL を出すには time stop / take profit / stop loss のいずれかが要る。
    // 簡略のため take-profit を踏ませる: avgPrice を低く置いて pnl を +10% にする)
    const sellingState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 5, avgPrice: 100, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: sellingState }),
      execution,
      vixDecision: {
        regime: 'critical',
        sizeScale: 0,
        reason: 'vix_critical: 35.10 (block)',
        vix: 35.1,
      },
      now: () => now,
    })
    // BUY は確実に来ない。
    expect(summary.buys).toBe(0)
    // SELL が確かに通っていることを証明 (CodeRabbit #216 4th):
    //   - summary.sells === 1
    //   - execution に SELL intent が渡っている
    //   - decision log にも SELL が残っている
    // これで「critical でも SELL は本当に通る」passthrough を実証する
    // (HOLD で素通りしても通る test だと、回帰検知ができない)。
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(execution.calls[0]).toMatchObject({ side: 'SELL' })
    const sellDecision = summary.decisions.find((d) => d.decision === 'SELL')
    expect(sellDecision).toBeDefined()
    expect(sellDecision?.order?.side).toBe('SELL')
    // vix_critical 起因の REJECT が混ざっていないこと。
    const vixReject = summary.decisions.find(
      (d) => d.decision === 'REJECT' && (d.reason ?? '').includes('vix_critical'),
    )
    expect(vixReject).toBeUndefined()
  })
})

describe('runPullbackScheduler SELL_QTY_EXCEED fallback (#215 follow-up)', () => {
  /**
   * Down-trend bars that fire a SELL on a held position. PullbackUptrend
   * triggers SELL when price breaks below the trailing stop / takeProfit.
   * Cheap shortcut: take uptrendBars() and crash the last close so the
   * stop fires.
   */
  function downtrendBars(): DailyBar[] {
    const bars = uptrendBars()
    const last = bars[bars.length - 1]!
    bars[bars.length - 1] = synth(59, last.close * 0.7) // -30% gap = stop
    return bars
  }

  function heldState(qty = 8, avgPrice = 124.95): SymbolState {
    return {
      ...emptySymbolState('AAPL', () => now),
      position: { qty, avgPrice, openedAt: '2026-04-19T15:00:00.000Z' },
      // Add settledCash so the per-symbol gate (when used) wouldn't trip;
      // here we don't pass perSymbolRisk so it's a no-op anyway.
      settledCash: 100_000,
    }
  }

  /**
   * Build a Webull-style 417 SELL_QTY_EXCEED error mirroring what
   * `WebullHttpClient` actually throws — the body snippet is embedded in
   * the message so `isSellQtyExceedError` can read it.
   */
  function makeSellQtyExceedError(): BrokerClientError {
    return new BrokerClientError(
      `Webull request failed permanently with status 417 body=${JSON.stringify({
        code: WEBULL_SELL_QTY_EXCEED_CODE,
        msg: 'requested_qty exceeds available',
      })}`,
      'POST /openapi/account/orders/place',
      { brokerStatus: 417 },
    )
  }

  function mockSellExecution(behaviour: {
    firstThrow?: Error
    secondThrow?: Error
  }): Execution & { calls: unknown[] } {
    const calls: unknown[] = []
    let attempt = 0
    return {
      calls,
      async execute(intent) {
        attempt += 1
        calls.push(intent)
        if (attempt === 1 && behaviour.firstThrow) throw behaviour.firstThrow
        if (attempt === 2 && behaviour.secondThrow) throw behaviour.secondThrow
        return { mode: 'DRY_RUN', submitted: true, brokerOrderId: `dry-run-${attempt}` }
      },
    }
  }

  it('retries SELL with broker available qty when 417 SELL_QTY_EXCEED fires', async () => {
    // Setup: DO state qty=8, broker available=4. PullbackUptrend triggers
    // SELL via the downtrend close. First execute() throws 417 SELL_QTY_EXCEED
    // → fallback resolver returns 4 → second execute() succeeds with qty=4.
    const overrideCalls: Array<{ symbol: string; args: { qty: number; reason: string } }> = []
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition(symbol, args) {
        overrideCalls.push({ symbol, args })
        return baseStore.getState(symbol)
      },
    }
    const execution = mockSellExecution({ firstThrow: makeSellQtyExceedError() })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      sellFallback: { getAvailableQty: async () => 4 },
      now: () => now,
    })

    // Two execute() calls: original SELL 8 + fallback SELL 4.
    expect(execution.calls).toHaveLength(2)
    const firstIntent = execution.calls[0] as { side: string; quantity: number }
    const secondIntent = execution.calls[1] as { side: string; quantity: number }
    expect(firstIntent.side).toBe('SELL')
    expect(firstIntent.quantity).toBe(8)
    expect(secondIntent.side).toBe('SELL')
    expect(secondIntent.quantity).toBe(4)

    expect(summary.sells).toBe(1)
    expect(summary.errors).toHaveLength(0)

    // DO position must be force-reset to null after the fallback succeeds.
    expect(overrideCalls).toHaveLength(1)
    expect(overrideCalls[0]).toMatchObject({
      symbol: 'AAPL',
      args: { qty: 0 },
    })
    expect(overrideCalls[0]?.args.reason).toContain('sell_qty_fallback')

    // Decision trace should include the new fallback step.
    const decision = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(decision?.decision).toBe('SELL')
    expect(decision?.order?.quantity).toBe(4)
    const labels = decision?.trace?.map((s) => s.label) ?? []
    expect(labels).toContain('broker.sell_qty_fallback')
    expect(decision?.reason).toContain('sell_qty_fallback')
  })

  it('does NOT retry on a different 4xx (not SELL_QTY_EXCEED) — original error wins', async () => {
    const overrideCalls: Array<{ symbol: string }> = []
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition(symbol) {
        overrideCalls.push({ symbol })
        return baseStore.getState(symbol)
      },
    }
    // 400 with a *different* Webull error code → fallback must not engage.
    const otherErr = new BrokerClientError(
      `Webull request failed permanently with status 400 body=${JSON.stringify({
        code: 'OAUTH_OPENAPI_OTHER_ERROR',
      })}`,
      'POST /openapi/account/orders/place',
      { brokerStatus: 400 },
    )
    const execution = mockSellExecution({ firstThrow: otherErr })
    const fallbackSpy = vi.fn(async () => 4)
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      sellFallback: { getAvailableQty: fallbackSpy },
      now: () => now,
    })
    expect(execution.calls).toHaveLength(1)
    expect(fallbackSpy).not.toHaveBeenCalled()
    expect(overrideCalls).toHaveLength(0)
    expect(summary.sells).toBe(0)
    expect(summary.errors).toHaveLength(1)
    const errDecision = summary.decisions.find((d) => d.decision === 'ERROR')
    expect(errDecision?.reason).toContain('OAUTH_OPENAPI_OTHER_ERROR')
  })

  it('falls back to original error when broker available=0', async () => {
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const overrideCalls: Array<{ symbol: string }> = []
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition(symbol) {
        overrideCalls.push({ symbol })
        return baseStore.getState(symbol)
      },
    }
    const execution = mockSellExecution({ firstThrow: makeSellQtyExceedError() })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      sellFallback: { getAvailableQty: async () => 0 },
      now: () => now,
    })
    // No retry submit, no DO reset, original 417 error reported.
    expect(execution.calls).toHaveLength(1)
    expect(overrideCalls).toHaveLength(0)
    expect(summary.sells).toBe(0)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]?.message).toContain('OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY')
  })

  it('does not retry when available >= original qty (broker contradicts the 417)', async () => {
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition() {
        return baseStore.getState('AAPL')
      },
    }
    const execution = mockSellExecution({ firstThrow: makeSellQtyExceedError() })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      sellFallback: { getAvailableQty: async () => 8 },
      now: () => now,
    })
    expect(execution.calls).toHaveLength(1)
    expect(summary.sells).toBe(0)
    expect(summary.errors).toHaveLength(1)
  })

  it('falls through to original error when fallback resolver throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition() {
        return baseStore.getState('AAPL')
      },
    }
    const execution = mockSellExecution({ firstThrow: makeSellQtyExceedError() })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      sellFallback: {
        getAvailableQty: async () => {
          throw new Error('positions endpoint timeout')
        },
      },
      now: () => now,
    })
    expect(execution.calls).toHaveLength(1)
    expect(summary.sells).toBe(0)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]?.message).toContain('OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY')
    warnSpy.mockRestore()
  })

  it('falls back to original error when retry submit also fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const overrideCalls: Array<{ symbol: string }> = []
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition(symbol) {
        overrideCalls.push({ symbol })
        return baseStore.getState(symbol)
      },
    }
    // Both attempts throw — retry's failure must not mask the original 417.
    const execution = mockSellExecution({
      firstThrow: makeSellQtyExceedError(),
      secondThrow: new BrokerServerError('upstream 503', 'POST /openapi/account/orders/place', {
        brokerStatus: 503,
      }),
    })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      sellFallback: { getAvailableQty: async () => 4 },
      now: () => now,
    })
    // Retry was attempted but failed → DO state stays untouched, summary
    // reports the *original* 417 error (not the retry 503).
    expect(execution.calls).toHaveLength(2)
    expect(overrideCalls).toHaveLength(0)
    expect(summary.sells).toBe(0)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]?.message).toContain('OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY')
    warnSpy.mockRestore()
  })

  it('skips fallback entirely when sellFallback is omitted (back-compat)', async () => {
    const baseStore = makeStore({ AAPL: heldState(8, 124.95) })
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition() {
        return baseStore.getState('AAPL')
      },
    }
    const execution = mockSellExecution({ firstThrow: makeSellQtyExceedError() })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(downtrendBars()),
      positionStore,
      execution,
      now: () => now,
    })
    expect(execution.calls).toHaveLength(1)
    expect(summary.sells).toBe(0)
    expect(summary.errors).toHaveLength(1)
  })

  it('does NOT trigger fallback for BUY 417s (SELL-only path)', async () => {
    const overrideCalls: Array<{ symbol: string }> = []
    const baseStore = makeStore({})
    const positionStore: PositionStore = {
      ...baseStore,
      async overridePosition(symbol) {
        overrideCalls.push({ symbol })
        return baseStore.getState(symbol)
      },
    }
    const execution = mockSellExecution({ firstThrow: makeSellQtyExceedError() })
    const fallbackSpy = vi.fn(async () => 4)
    // uptrendBars + no held position → BUY signal. The "417 SELL_QTY_EXCEED"
    // is artificial here but lets us prove the fallback is gated on side='SELL'.
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore,
      execution,
      sellFallback: { getAvailableQty: fallbackSpy },
      now: () => now,
    })
    expect(execution.calls).toHaveLength(1)
    expect(fallbackSpy).not.toHaveBeenCalled()
    expect(overrideCalls).toHaveLength(0)
    expect(summary.errors).toHaveLength(1)
  })
})

describe('runPullbackScheduler sanity_failed cooldown gate', () => {
  // 9697 04/28 incident: broker stub fill (filled_price=10 vs limit ~2683) が
  // ratio guard で reject されると DO state は更新されず、cron は毎 tick
  // 「未保有 → BUY」を送って broker 側 600 株疑い。cooldown gate は直近 N 分で
  // sanity_failed が観測されていれば BUY を block する。

  it('rejects BUY when sanity_failed cooldown reports a recent failure', async () => {
    const execution = mockExecution()
    const checkSpy = vi.fn(async (symbol: string) => symbol === '9697')
    const summary = await runPullbackScheduler({
      symbols: ['9697'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      sanityFailedCooldown: { check: checkSpy, withinMs: 30 * 60_000 },
      now: () => now,
    })

    expect(checkSpy).toHaveBeenCalledWith('9697')
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('sanity_failed cooldown active')
    expect(reject?.reason).toContain('30min')
    expect(reject?.trace?.map((s) => s.label)).toContain('risk.sanity_failed_cooldown')
  })

  it('approves BUY when cooldown reports no recent failure (lapsed window)', async () => {
    const execution = mockExecution()
    const checkSpy = vi.fn(async () => false)
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      sanityFailedCooldown: { check: checkSpy, withinMs: 30 * 60_000 },
      now: () => now,
    })

    expect(checkSpy).toHaveBeenCalledWith('AAPL')
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })

  it('skips the cooldown gate when option is omitted (back-compat)', async () => {
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

  it('treats a thrown check as cooldown active (fail-closed)', async () => {
    // DB read failure should not silently let BUY through — the incident we
    // are guarding against is exactly the case where the broker side may have
    // accumulated phantom shares.
    const execution = mockExecution()
    const checkSpy = vi.fn(async () => {
      throw new Error('D1 unavailable')
    })
    const summary = await runPullbackScheduler({
      symbols: ['9697'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      sanityFailedCooldown: { check: checkSpy, withinMs: 30 * 60_000 },
      now: () => now,
    })

    expect(checkSpy).toHaveBeenCalledWith('9697')
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(reject?.reason).toContain('sanity_failed cooldown active')
  })

  it('does not invoke check on the SELL path (existing position exit not gated)', async () => {
    // SELL は対象外: broker stub fill では起きない (= sanity_failed の根本原因
    // ではない) し、entry を凍結したいだけで exit を妨げる必要はない。Strategy
    // が SELL を出す setup に切り替えるため、time-stop / take-profit を引き寄せた
    // position を fixture で持たせる。
    const execution = mockExecution()
    const checkSpy = vi.fn(async () => true)
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: {
        qty: 5,
        avgPrice: 80,
        // 50 BD 前 → time stop で SELL 経路に乗る (default rule timeStopDays=10)
        openedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState }),
      execution,
      sanityFailedCooldown: { check: checkSpy, withinMs: 30 * 60_000 },
      now: () => now,
    })

    // SELL であれば cooldown は呼ばれず、execute も走る。HOLD で抜けた場合は
    // execute は走らないが check も呼ばれない (= BUY 経路でしか引かない実装)。
    expect(checkSpy).not.toHaveBeenCalled()
    if (summary.sells > 0) {
      expect((execution.calls[0] as { side: string }).side).toBe('SELL')
    }
  })

  it('does not affect other symbols when one symbol is in cooldown', async () => {
    // Cooldown は symbol 単位 — 1 銘柄が止まっても他銘柄の評価は通常通り。
    const execution = mockExecution()
    const checkSpy = vi.fn(async (symbol: string) => symbol === '9697')
    const summary = await runPullbackScheduler({
      symbols: ['9697', 'AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      sanityFailedCooldown: { check: checkSpy, withinMs: 30 * 60_000 },
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect((execution.calls[0] as { symbol: string }).symbol).toBe('AAPL')
    const reject = summary.decisions.find((d) => d.symbol === '9697')
    expect(reject?.decision).toBe('REJECT')
    expect(reject?.reason).toContain('sanity_failed cooldown active')
  })
})

describe('runPullbackScheduler per-symbol rule override (#316)', () => {
  // 3x leveraged ETF を念頭に「銘柄ごとに timeStopDays / kAtr を上書きできる」
  // ことを検証。default rule timeStopDays=10、override で 5 にすると holdBD≥5
  // の銘柄が time-stop SELL に乗る。同じ holdBD で override 無しの銘柄は HOLD。
  const defaultRule = {
    stopPct: -0.04,
    takeProfitPct: 0.07,
    timeStopDays: 10,
    pullbackMax: -0.03,
    pullbackMin: -0.06,
    minReturn50d: 0.08,
    requireAboveSma50: true,
    kAtr: 2.0,
    // 過熱ガードは既存 scheduler テストでは無効化 (大きい値) し entry の従来挙動を維持。
    // ガード自体の検証は pullbackUptrendStrategy.test.ts の専用ケースで行う。
    maxSma50DeviationPct: 100,
    maxAtrRatio: 100,
  }

  it('applies timeStopDays override to the matching symbol and falls through for others', async () => {
    // 7 BD 前に open した position を 2 銘柄に同条件で持たせ、SOXL 側だけ
    // timeStopDays=5 override する。SOXL は time-stop SELL、AAPL は default
    // (10d) 未到達で HOLD。avgPrice=117 は last close=117.5 とほぼ同値で
    // take-profit / stop-loss を発火させない (時間切れだけが起きる)。
    const heldState = (symbol: string): SymbolState => ({
      ...emptySymbolState(symbol, () => now),
      position: {
        qty: 5,
        avgPrice: 117,
        // 7 business days 前。default rule timeStopDays=10 では未到達、
        // override timeStopDays=5 では到達する境界。
        openedAt: new Date('2026-04-09T00:00:00.000Z').toISOString(),
      },
    })
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL', 'AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({
        SOXL: heldState('SOXL'),
        AAPL: heldState('AAPL'),
      }),
      execution,
      defaultRule,
      rulesMap: { SOXL: { ...defaultRule, timeStopDays: 5 } },
      now: () => now,
    })

    const soxlDecision = summary.decisions.find((d) => d.symbol === 'SOXL')
    const aaplDecision = summary.decisions.find((d) => d.symbol === 'AAPL')
    // SOXL は override timeStopDays=5 で time-stop に乗る。
    expect(soxlDecision?.decision).toBe('SELL')
    expect(soxlDecision?.reason).toMatch(/time-stop hit.*>=\s*5d/)
    // AAPL は default の 10d 未到達 — time-stop は発火しない (HOLD 経路)。
    expect(aaplDecision?.decision).toBe('HOLD')
    expect(aaplDecision?.reason ?? '').not.toMatch(/time-stop hit/)
  })

  it('uses defaultRule when rulesMap is empty (NULL override fall-through)', async () => {
    // Override が無い場合は default 通り。7 BD 前は default (10d) 未到達 →
    // time-stop は発火せず HOLD で抜ける。
    const heldState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: {
        qty: 5,
        avgPrice: 117,
        // 7 BD 前 → default (10d) 未到達。
        openedAt: new Date('2026-04-09T00:00:00.000Z').toISOString(),
      },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: heldState }),
      execution,
      defaultRule,
      // rulesMap 未指定 → 全 symbol が defaultRule を使う。
      now: () => now,
    })

    const soxl = summary.decisions.find((d) => d.symbol === 'SOXL')
    expect(soxl?.decision).toBe('HOLD')
    expect(soxl?.reason ?? '').not.toMatch(/time-stop hit/)
  })
})

describe('runPullbackScheduler per-symbol lot_size (#symbol-lot-size)', () => {
  it('fail-closed (no BUY) when symbolLotSizeMap is provided but the symbol is absent', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      // map は渡すが AAPL を含めない → lot_size 未設定扱い → 発注見送り。
      symbolLotSizeMap: { SOXL: 1 },
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('REJECT')
    expect(aapl?.reason).toMatch(/missing-lot-size/)
    expect(summary.rejected).toContainEqual(
      expect.objectContaining({ symbol: 'AAPL', reason: expect.stringMatching(/missing-lot-size/) }),
    )
  })

  it('places a BUY when the symbol has a lot_size in the map', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })

  it('rounds a JP-style lot=100 symbol down to a whole unit (single-unit-or-zero)', async () => {
    // lot=100 で equity が 1 単元に届かない → lot-size-round で 0 株 reject。
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 100 },
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('REJECT')
    expect(aapl?.reason).toMatch(/lot-size-round/)
  })
})

describe('runPullbackScheduler budget-alloc basis fail-closed (#417 buying-power)', () => {
  it('fail-closed (no BUY) for a budget symbol when budgetBasisJpy is undefined (total_capital_jpy 未設定)', async () => {
    // total_capital_jpy=null → runStrategyCron は budgetBasisJpy=undefined を渡す。
    // 幻の資本で sizing せず発注見送り (過大発注 → Webull 417 を防ぐ)。
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      symbolBudgetAllocPctMap: { AAPL: 0.35 },
      budgetBasisJpy: undefined,
      fxJpyPerSymbolCcy: 150,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('REJECT')
  })

  it('places a BUY for a budget symbol once budgetBasisJpy is a real account total', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      symbolBudgetAllocPctMap: { AAPL: 0.35 },
      budgetBasisJpy: 1_000_000, // ¥1M × 35% / 150 ≈ $2,333 → 数株
      fxJpyPerSymbolCcy: 150,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
  })
})

describe('runPullbackScheduler buying-power pool gate (#415)', () => {
  it('fail-closed: rejects BUY when the ledger is unavailable (fetch failed)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      buyingPower: createUnavailableBuyingPowerLedger('fetch failed'),
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('REJECT')
    expect(aapl?.reason).toMatch(/buying-power unavailable/)
  })

  it('places a BUY and decrements the ledger when buying power is sufficient', async () => {
    const execution = mockExecution()
    const ledger = createBuyingPowerLedger({ availableJpy: 1_000_000_000, asOf: null, bufferPct: 0 })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      fxJpyPerSymbolCcy: 150,
      buyingPower: ledger,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(ledger.remainingJpy).toBeLessThan(1_000_000_000) // 約定分が減算された
  })

  it('rejects BUY (no execution) when notional exceeds remaining buying power', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      fxJpyPerSymbolCcy: 150,
      buyingPower: createBuyingPowerLedger({ availableJpy: 1, asOf: null, bufferPct: 0 }),
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('REJECT')
    expect(aapl?.reason).toMatch(/insufficient buying power/)
  })

  it('shared pool covers only the first of two BUYs (sequential decrement)', async () => {
    // budget mode + symbolCap で notional を 1 銘柄 ≈ ¥49,937 に固定 (fx=1)。
    // pool ¥60,000 → 1 件目は通り、2 件目は残余力不足で reject。
    const execution = mockExecution()
    const ledger = createBuyingPowerLedger({ availableJpy: 60_000, asOf: null, bufferPct: 0 })
    const summary = await runPullbackScheduler({
      symbols: ['AAA', 'BBB'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAA: 1, BBB: 1 },
      symbolBudgetAllocPctMap: { AAA: 1, BBB: 1 },
      symbolCapMap: { AAA: 50_000, BBB: 50_000 },
      budgetBasisJpy: 1_000_000,
      fxJpyPerSymbolCcy: 1,
      buyingPower: ledger,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const rejected = summary.decisions.filter((d) => d.decision === 'REJECT')
    expect(rejected.some((d) => /insufficient buying power/.test(d.reason ?? ''))).toBe(true)
  })
})

describe('runPullbackScheduler broker-error decision embeds order amount (#417)', () => {
  it('includes qty + USD/JPY notional in the ERROR reason for a USD symbol', async () => {
    const throwing: Execution & { calls: unknown[] } = {
      calls: [],
      async execute(intent) {
        ;(throwing.calls as unknown[]).push(intent)
        throw new BrokerClientError(
          'Webull request failed permanently with status 417: {"error_code":"OAUTH_OPENAPI_ORDER_BUYING_POWER_NOT_ENOUGH"}',
          'POST /openapi/account/orders/place',
          { brokerStatus: 417 },
        )
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: throwing,
      symbolLotSizeMap: { AAPL: 1 },
      fxJpyPerSymbolCcy: 150,
      now: () => now,
    })
    const err = summary.decisions.find((d) => d.decision === 'ERROR')
    expect(err).toBeDefined()
    // localize 用の prefix は維持 (発注内容は message の後ろ)。
    expect(err?.reason).toMatch(/^broker submit error: /)
    expect(err?.reason).toMatch(/発注内容: \d+口/)
    expect(err?.reason).toContain('$') // USD notional
    expect(err?.reason).toContain('¥') // JPY 換算
    expect(err?.reason).toContain('USD/JPY 150')
  })

  it('shows ¥ only for a JPY symbol (fx=1)', async () => {
    const throwing: Execution & { calls: unknown[] } = {
      calls: [],
      async execute() {
        throw new BrokerClientError('boom 417', 'POST /place', { brokerStatus: 417 })
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: throwing,
      symbolLotSizeMap: { AAPL: 1 },
      fxJpyPerSymbolCcy: 1,
      now: () => now,
    })
    const err = summary.decisions.find((d) => d.decision === 'ERROR')
    expect(err?.reason).toMatch(/発注内容: \d+口 @ ¥/)
    expect(err?.reason).not.toContain('USD/JPY')
  })
})

describe('runPullbackScheduler intraday-only force-close (#intraday-only)', () => {
  // avgPrice 117 ≈ price 117.5 (uptrendBars last close) → pnl +0.4% → 通常は HOLD。
  const heldState = (): SymbolState => ({
    ...emptySymbolState('AAPL', () => now),
    position: { qty: 3, avgPrice: 117, openedAt: '2026-04-19T00:00:00.000Z' },
  })
  // 2026-04-20 月曜、EDT → 引け 20:00 UTC。19:50 UTC = 15:50 ET = 引け 15分前 window 内。
  const closeWindow = new Date('2026-04-20T19:50:00.000Z')

  it('forces a SELL within the US-close window, overriding HOLD', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState() }),
      execution,
      intradayOnlySymbols: new Set(['AAPL']),
      now: () => closeWindow,
    })
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('SELL')
    expect(aapl?.reason).toMatch(/intraday-only/)
  })

  it('does NOT force-close outside the window (normal HOLD)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState() }),
      execution,
      intradayOnlySymbols: new Set(['AAPL']),
      now: () => now, // 14:30 UTC = 10:30 ET, 窓外
    })
    expect(summary.sells).toBe(0)
    expect(execution.calls).toHaveLength(0)
    expect(summary.decisions.find((d) => d.symbol === 'AAPL')?.decision).toBe('HOLD')
  })

  it('does NOT force-close a symbol not flagged intraday-only', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState() }),
      execution,
      intradayOnlySymbols: new Set(['TQQQ']), // AAPL は対象外
      now: () => closeWindow,
    })
    expect(summary.sells).toBe(0)
    expect(summary.decisions.find((d) => d.symbol === 'AAPL')?.decision).toBe('HOLD')
  })
})
