import { describe, expect, it, vi } from 'vitest'
import type { BarClient, IntradayBar } from '../../../src/infrastructure/quotes/BarClient'
import type { Notifier, NotificationEvent } from '../../../src/infrastructure/notification/Notifier'
import {
  BrokerClientError,
  BrokerRateLimitError,
  BrokerServerError,
  WEBULL_SELL_QTY_EXCEED_CODE,
} from '../../../src/shared/errors'
import type { Execution } from '../../../src/trading/execution/Execution'
import type { PositionStore } from '../../../src/trading/state/PositionStore'
import { emptySymbolState, type SymbolState } from '../../../src/trading/state/types'
import { runPullbackScheduler } from '../../../src/trading/strategy/pullbackScheduler'
import { TEST_DEFAULT_RULE } from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'
import {
  createBuyingPowerLedger,
  createUnavailableBuyingPowerLedger,
} from '../../../src/trading/strategy/buyingPower'
import {
  createExposureLedger,
  createUnavailableExposureLedger,
} from '../../../src/trading/strategy/exposureLedger'
import type { DailyBar } from '../../../src/trading/strategy/indicators'

const now = new Date('2026-04-20T14:30:00.000Z')

describe('fresh quote decisions and BUY cooldown scope', () => {
  const quote = { price: 101, asOf: now.toISOString(), fetchedAt: now.toISOString(), source: 'webull-snapshot' }
  const held = (): SymbolState => ({
    ...emptySymbolState('AAPL', () => now),
    position: { qty: 2, avgPrice: 100, openedAt: '2026-04-20T14:00:00Z' },
    lastQuote: quote,
  })
  it('buys from a fresh snapshot when an hourly close is already outside the entry band', async () => {
    const state = { ...emptySymbolState('AAPL', () => now), lastQuote: { ...quote, price: 117.5 } }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'], equity: 100_000, symbolLotSizeMap: { AAPL: 1 },
      barClient: { ...mockBarClient(uptrendBars()), getIntradayBars: async () => [{ timestamp: '2026-04-20T14:00:00Z', open: 123, high: 123, low: 123, close: 123 }] },
      positionStore: makeStore({ AAPL: state }), execution: mockExecution(), now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(summary.decisions[0]?.price).toBe(117.5)
    expect(summary.decisions[0]?.trace?.[0]?.message).toBe(`webull-snapshot:${now.toISOString()}`)
  })
  it('decides from the hourly bar when the snapshot is stale', async () => {
    const state = held()
    state.lastQuote = { ...quote, asOf: '2026-04-20T14:00:00Z' }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'], barClient: { ...mockBarClient(uptrendBars()), getIntradayBars: async () => [{ timestamp: '2026-04-20T14:00:00Z', open: 101, high: 101, low: 101, close: 101 }] },
      positionStore: makeStore({ AAPL: state }), execution: mockExecution(), now: () => now,
    })
    expect(summary.decisions[0]?.trace?.[0]?.message).toBe('intraday_60m:2026-04-20T14:00:00Z')
  })
  it('an existing stop-loss still exits during a BUY cooldown', async () => {
    const state = held()
    state.lastQuote = { ...quote, price: 90 }
    state.cooldownUntil = '2026-04-21T14:30:00Z'
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'], barClient: mockBarClient(uptrendBars()), positionStore: makeStore({ AAPL: state }),
      execution: mockExecution(), now: () => now,
    })
    expect(summary.sells).toBe(1)
    expect(summary.decisions[0]?.reason).toContain('stop-loss')
  })
})

// #318: trend filter は 20d return ベース。40 bars 緩い上昇 (SMA50 warmup) → 15 bars 急伸 (高値122) →
// 5 bars 高値到達後 mild -4% pullback (BUY ゾーン)。結果: closes[-20]≈108、last=117.5、20d return≈+8.8%。
function uptrendBars(): DailyBar[] {
  const bars: DailyBar[] = []
  for (let i = 0; i < 40; i += 1) {
    const close = 100 + i * 0.2 // gentle warmup, bar 39 close = 107.8
    bars.push(synth(i, close))
  }
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

// 新高値ブレイク bars: 緩く上げて最後の bar で 20日終値高値を超える。
// 押し目戦略は「新高値=押し目でない」で HOLD、モメンタムは BUY になる。
function breakoutBars(): DailyBar[] {
  const bars: DailyBar[] = []
  for (let i = 0; i < 59; i += 1) bars.push(synth(i, 100 + i * 0.2)) // bar58 close = 111.6
  bars.push(synth(59, 115)) // 新高値ジャンプ (breakoutHigh20=111.6、115 > 111.6*1.005)
  return bars
}

describe('momentum routing (#momentum)', () => {
  it('momentum symbol はブレイクで BUY、押し目戦略は同 bars で HOLD', async () => {
    const { BreakoutMomentumStrategy, TEST_DEFAULT_MOMENTUM_RULE } = await import(
      '../../../src/trading/strategy/strategies/BreakoutMomentumStrategy'
    )
    const exPull = mockExecution()
    const sumPull = await runPullbackScheduler({
      symbols: ['ICLN'],
      equity: 100_000,
      barClient: mockBarClient(breakoutBars()),
      positionStore: makeStore({}),
      execution: exPull,
      now: () => now,
    })
    expect(sumPull.buys).toBe(0)
    expect(exPull.calls).toHaveLength(0)

    const exMom = mockExecution()
    const sumMom = await runPullbackScheduler({
      symbols: ['ICLN'],
      equity: 100_000,
      barClient: mockBarClient(breakoutBars()),
      positionStore: makeStore({}),
      execution: exMom,
      momentumSymbols: new Set(['ICLN']),
      momentumStrategy: new BreakoutMomentumStrategy(TEST_DEFAULT_MOMENTUM_RULE),
      now: () => now,
    })
    expect(sumMom.buys).toBe(1)
    expect(exMom.calls).toHaveLength(1)
    expect((exMom.calls[0] as { side: string }).side).toBe('BUY')
  })
})

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

  it('blocks a would-be BUY when re-entry price guard is active (recent exit near price, #reentry)', async () => {
    const recentlyExited: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      // last close 117.5 に前回売値を置くと ceiling = 117.5 - 1*ATR < 117.5 で必ずガードに掛かる
      lastExitPrice: 117.5,
      // now (2026-04-20 Mon) の 1 営業日前 (Fri) → businessDaysSinceExit = 1 < 3。
      lastExitAt: '2026-04-17T14:30:00.000Z',
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: recentlyExited }),
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'SOXL')
    expect(decision?.decision).toBe('HOLD')
    expect(decision?.reason).toMatch(/re-entry guard/)
    expect(decision?.trace?.map((s) => s.label)).toContain('entry.reentry_below_last_exit')
    expect(decision?.trace?.map((s) => s.label)).not.toContain('entry.adopt_buy')
  })

  it('allows the BUY once the re-entry guard window has elapsed', async () => {
    const staleExit: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastExitPrice: 117.5,
      // ~6 営業日前 → businessDaysSinceExit >= 3 → ガード無効化。
      lastExitAt: '2026-04-10T14:30:00.000Z',
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: staleExit }),
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(summary.decisions.find((d) => d.symbol === 'SOXL')?.decision).toBe('BUY')
  })

  it('treats a symbol with no lastExitAt as never-exited and does not infer a guard from stale lastExecutedPrice (#660)', async () => {
    const neverExitedState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      // sync-holdings 由来の残骸: 古い BUY 価格が居座っている想定
      lastExecutedPrice: 50,
      lastExitPrice: null,
      lastExitAt: null,
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: neverExitedState }),
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(summary.decisions.find((d) => d.symbol === 'SOXL')?.decision).toBe('BUY')
  })

  // #660: lastExitAt (#582) はあるが lastExitPrice が無い移行期 state がありうる。
  // 窓内で fail-open にすると守るべきガードが無防備になるため fail-closed で保留する。
  it('fail-closes the re-entry guard when lastExitAt exists but lastExitPrice is legacy-null within the guard window', async () => {
    const migrationWindowState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastExitPrice: null,
      // now (2026-04-20 Mon) の 1 営業日前 (Fri) → businessDaysSinceExit = 1 < 3。
      lastExitAt: '2026-04-17T14:30:00.000Z',
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: migrationWindowState }),
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'SOXL')
    expect(decision?.decision).toBe('HOLD')
    expect(decision?.reason).toMatch(/re-entry guard/)
    expect(decision?.reason).toMatch(/unknown|guard window/)
    expect(decision?.trace?.map((s) => s.label)).toContain('entry.reentry_below_last_exit')
  })

  it('allows the BUY once the guard window elapses even when lastExitPrice is legacy-null', async () => {
    const pastWindowState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      lastExitPrice: null,
      // ~6 営業日前 → businessDaysSinceExit >= 3 → ガード無効化。
      lastExitAt: '2026-04-10T14:30:00.000Z',
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: pastWindowState }),
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(summary.decisions.find((d) => d.symbol === 'SOXL')?.decision).toBe('BUY')
  })

  it('drives the re-entry guard from lastExitPrice, ignoring a differing lastExecutedPrice (#660)', async () => {
    const explicitExitState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      // lastExecutedPrice はガードに使われないダミー値 (無関係に高い値)
      lastExecutedPrice: 200,
      lastExitPrice: 45.83,
      lastExitAt: '2026-04-17T14:30:00.000Z',
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXL: explicitExitState }),
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'SOXL')
    expect(decision?.decision).toBe('HOLD')
    expect(decision?.reason).toContain('45.83')
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
        decision: 'SKIP',
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

  // flat は今まで通り 1 回で確定、held は 1 回だけ retry してから ERROR にする
  describe('held position survives bar-fetch failure', () => {
    const heldState = (): SymbolState => ({
      ...emptySymbolState('BROKEN', () => now),
      position: { qty: 7, avgPrice: 100, openedAt: '2026-01-01T00:00:00.000Z' },
    })

    it('emits ERROR with the holding reason and retries the daily fetch once when it keeps failing', async () => {
      const events: NotificationEvent[] = []
      const notifier: Notifier = {
        async notify(event) {
          events.push(event)
        },
      }
      const getDailyBars = vi.fn(async () => {
        throw new Error('upstream 500')
      })
      const summary = await runPullbackScheduler({
        symbols: ['BROKEN'],
        equity: 100_000,
        barClient: { getDailyBars },
        positionStore: makeStore({ BROKEN: heldState() }),
        execution: mockExecution(),
        notifier,
        now: () => now,
      })

      expect(getDailyBars).toHaveBeenCalledTimes(2) // 1 回目 + retry 1 回
      const decision = summary.decisions.find((d) => d.symbol === 'BROKEN')
      expect(decision?.decision).toBe('ERROR')
      expect(decision?.reason).toBe(
        'exit evaluation unavailable while holding 7: bar fetch: upstream 500',
      )
      expect(summary.errors).toEqual([
        { symbol: 'BROKEN', message: 'exit evaluation unavailable while holding 7: bar fetch: upstream 500' },
      ])
      await Promise.resolve()
      const err = events.find((e) => e.type === 'ERROR') as
        | Extract<NotificationEvent, { type: 'ERROR' }>
        | undefined
      expect(err?.cause).toBe('exit_unavailable_while_holding')
    })

    it('does not attempt a degraded SELL when bars are unavailable for a held position', async () => {
      const getDailyBars = vi.fn(async () => {
        throw new Error('upstream 500')
      })
      const execution = mockExecution()
      const summary = await runPullbackScheduler({
        symbols: ['BROKEN'],
        equity: 100_000,
        barClient: { getDailyBars },
        positionStore: makeStore({ BROKEN: heldState() }),
        execution,
        now: () => now,
      })

      expect(summary.sells).toBe(0)
      expect(execution.calls).toHaveLength(0)
    })

    it('emits the same exit-unavailable ERROR when bars are fetched but insufficient for indicators', async () => {
      const summary = await runPullbackScheduler({
        symbols: ['BROKEN'],
        equity: 100_000,
        barClient: mockBarClient([synth(0, 100), synth(1, 101)]), // too short for indicators
        positionStore: makeStore({ BROKEN: heldState() }),
        execution: mockExecution(),
        now: () => now,
      })

      const decision = summary.decisions.find((d) => d.symbol === 'BROKEN')
      expect(decision?.decision).toBe('ERROR')
      expect(decision?.reason).toBe(
        'exit evaluation unavailable while holding 7: insufficient bars for indicators',
      )
    })
  })

  it('uses intraday 1h close as fill price when getIntradayBars resolves', async () => {
    // chart UI と整合させるため、daily last close (117.5) とは別の intraday close (118.25) を返す
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
    expect(summary.decisions[0]?.price).toBe(118.25)
    expect(summary.decisions[0]?.trace?.[0]?.label).toBe('data.price_as_of')
    expect(summary.decisions[0]?.trace?.[0]?.message).toBe('intraday_60m:2026-04-20T14:00:00.000Z')
  })

  it('falls back to daily close for the decision record, but skips the BUY as stale price', async () => {
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

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(decision?.decision).toBe('SKIP')
    expect(decision?.reason).toBe(
      'stale price: intraday bar unavailable, daily close fallback not accepted for BUY',
    )
    expect(decision?.price).toBe(117.5)
    expect(decision?.trace?.map((s) => s.label)).toContain('risk.price_freshness')
    expect(decision?.trace?.[0]?.label).toBe('data.price_as_of')
    expect(decision?.trace?.[0]?.message).toBe('daily_close:2026-03-01')
  })

  it('still SELLs a held position at the stop price when intraday bars are unavailable', async () => {
    // 価格鮮度ゲートは BUY のみが対象 — exit は daily close で通常どおり動く
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 5, avgPrice: 200, openedAt: new Date('2026-01-01T00:00:00.000Z').toISOString() },
    }
    const store = makeStore({ AAPL: heldState })
    const execution = mockExecution()
    const barClient: BarClient = {
      getDailyBars: vi.fn(async () => uptrendBars()), // last close 117.5 << avgPrice 200 → stop hit
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

    expect(summary.sells).toBe(1)
    const intent = execution.calls[0] as { side: string; price: number }
    expect(intent.side).toBe('SELL')
    expect(intent.price).toBe(117.5)
  })

  it('skips the BUY as stale price when the latest intraday bar is 5h old', async () => {
    const staleTimestamp = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString()
    const store = makeStore({})
    const execution = mockExecution()
    const barClient: BarClient = {
      getDailyBars: vi.fn(async () => uptrendBars()),
      getIntradayBars: vi.fn(async () => [
        { timestamp: staleTimestamp, open: 117.6, high: 118.4, low: 117.4, close: 118.0 },
      ]),
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient,
      positionStore: store,
      execution,
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(decision?.decision).toBe('SKIP')
    expect(decision?.reason).toBe(
      `stale price: intraday_60m as of ${staleTimestamp} exceeds 7200000ms`,
    )
    expect(decision?.trace?.map((s) => s.label)).toContain('risk.price_freshness')
  })

  it('proceeds with the BUY at the daily close when the client has no getIntradayBars', async () => {
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()), // getIntradayBars を実装しない fake
      positionStore: makeStore({}),
      execution: mockExecution(),
      now: () => now,
    })

    expect(summary.buys).toBe(1)
    const decision = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(decision?.trace?.[0]?.label).toBe('data.price_as_of')
    expect(decision?.trace?.[0]?.message).toBe('daily_close:2026-03-01')
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

    expect(summary.buys).toBe(1)
    await Promise.resolve()
    warnSpy.mockRestore()
  })

  it('does not call notifier when one is not provided (back-compat) (#199)', async () => {
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
  // production wires this through runStrategyCron so cron / /trade/execute evaluate the same gates
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.reason).toContain('bid/ask missing')
  })

  it('places a BUY when bid/ask is missing but the source lacks it (Yahoo, #411 案A)', async () => {
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.reason).toContain('inverse-pair exposure')
  })

  it('approves BUY when no per-symbol gate fires', async () => {
    // settledCash 0 + lastQuote null (unseeded) → all gates skip; proves the gate is wired but harmless
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

  it('normal BUY still proceeds when cooldownUntil is already in the past (evaluateCooldown: true)', async () => {
    const state: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      cooldownUntil: new Date(now.getTime() - 60_000).toISOString(),
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
  })

  it('SELL exit is still submitted when cooldownUntil is in the future (evaluateCooldown does not block exits)', async () => {
    // decide() は cooldown 中は HOLD を返すため、cooldown 中の SELL は intraday-only force-close の override 経路を借りて作る
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 3, avgPrice: 117, openedAt: '2026-04-19T00:00:00.000Z' },
      cooldownUntil: new Date('2026-04-21T00:00:00.000Z').toISOString(),
    }
    // 2026-04-20 月曜、EDT → 引け 20:00 UTC。19:50 UTC = 引け 15分前 window 内。
    const closeWindow = new Date('2026-04-20T19:50:00.000Z')
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState }),
      execution,
      intradayOnlySymbols: new Set(['AAPL']),
      perSymbolRisk: baseRiskConfig,
      now: () => closeWindow,
    })
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect((execution.calls[0] as { side: string }).side).toBe('SELL')
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
            // now は 14:30 UTC = 10:30 EDT なので CPI 時刻を 10:30 に置いて window 内に入れる
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.reason).toContain('earnings_within_1bd')
    expect(reject?.reason).not.toContain('macro_event_gate')
  })
})

describe('runPullbackScheduler VIX regime filter (#196 3/3)', () => {
  // VIX 無し時の qty/notional を確定させ、warning 時の half qty と厳密に比較できるようにする
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
    const held = summary.decisions.find((d) => d.decision === 'HOLD' && (d.reason ?? '').includes('vix_critical'))
    expect(held?.reason).toContain('risk: vix_critical')
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
    expect(intent.quantity).toBe(Math.floor(baseQty * 0.5))
    expect(summary.vix?.regime).toBe('warning')
  })

  it('rejects BUY with VIX reason when warning sizeScale rounds qty below 1 share', async () => {
    // sizeScale=0.001 は実運用では現れない極端値だが、sizing 通過後に VIX 縮小で 0 になる経路を境界条件として確実に取る
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
    const held = summary.decisions.find((d) => d.decision === 'HOLD' && (d.reason ?? '').includes('vix_warning'))
    expect(held?.reason).toContain('vix_warning')
    expect(held?.reason).toContain('qty rounded to 0')
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
    // uptrendBars は BUY 判定になるので、SELL を出すため avgPrice を低く置いて take-profit を踏ませる
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
    expect(summary.buys).toBe(0)
    // CodeRabbit #216 4th: summary.sells / execution intent / decision log の 3 点で SELL passthrough を実証する
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(execution.calls[0]).toMatchObject({ side: 'SELL' })
    const sellDecision = summary.decisions.find((d) => d.decision === 'SELL')
    expect(sellDecision).toBeDefined()
    expect(sellDecision?.order?.side).toBe('SELL')
    const vixHold = summary.decisions.find(
      (d) => d.decision === 'HOLD' && (d.reason ?? '').includes('vix_critical'),
    )
    expect(vixHold).toBeUndefined()
  })
})

describe('runPullbackScheduler news shock gate (news-shock-gate PR 2)', () => {
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

  it('enforce mode blocks all BUY when regime is critical (sizeScale = 0)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      newsShockGate: {
        mode: 'enforce',
        decision: {
          regime: 'critical',
          sizeScale: 0,
          reason: 'news_shock_critical: 5.1x tone-2.3 (block)',
          ratio: 5.1,
          toneDrop: 2.3,
          asOf: now.toISOString(),
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const held = summary.decisions.find(
      (d) => d.decision === 'HOLD' && (d.reason ?? '').includes('news_shock_critical'),
    )
    expect(held?.reason).toContain('risk: news_shock_critical')
    expect(summary.newsShock?.regime).toBe('critical')
  })

  it('enforce mode halves BUY quantity in warning regime (sizeScale = 0.5)', async () => {
    const baseQty = await probeBaseQty()
    expect(baseQty).toBeGreaterThan(1)

    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      newsShockGate: {
        mode: 'enforce',
        decision: {
          regime: 'warning',
          sizeScale: 0.5,
          reason: 'news_shock_warning: 2.8x (size x0.5)',
          ratio: 2.8,
          toneDrop: null,
          asOf: now.toISOString(),
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(Math.floor(baseQty * 0.5))
    expect(summary.newsShock?.regime).toBe('warning')
  })

  it('multiplies with VIX scale (finalScale = vixScale × newsShockScale)', async () => {
    const baseQty = await probeBaseQty()
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
      newsShockGate: {
        mode: 'enforce',
        decision: {
          regime: 'warning',
          sizeScale: 0.5,
          reason: 'news_shock_warning: 2.8x (size x0.5)',
          ratio: 2.8,
          toneDrop: null,
          asOf: now.toISOString(),
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    // VIX と news は逐次 floor 適用 (既存 half-entry × VIX と同じ流儀) — 一括 0.25 倍ではない
    expect(intent.quantity).toBe(Math.floor(Math.floor(baseQty * 0.5) * 0.5))
  })

  it('either gate at zero blocks the BUY (binding gate reason is preserved)', async () => {
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
      newsShockGate: {
        mode: 'enforce',
        decision: {
          regime: 'critical',
          sizeScale: 0,
          reason: 'news_shock_critical: 5.1x tone-2.3 (block)',
          ratio: 5.1,
          toneDrop: 2.3,
          asOf: now.toISOString(),
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const held = summary.decisions.find(
      (d) => d.decision === 'HOLD' && (d.reason ?? '').includes('news_shock_critical'),
    )
    expect(held?.reason).toContain('news_shock_critical')
    expect(held?.reason).not.toContain('vix_')
  })

  it('observe mode does not change BUY quantity even when regime is critical', async () => {
    const baseQty = await probeBaseQty()
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      newsShockGate: {
        mode: 'observe',
        decision: {
          regime: 'critical',
          sizeScale: 0,
          reason: 'news_shock_critical: 5.1x tone-2.3 (block)',
          ratio: 5.1,
          toneDrop: 2.3,
          asOf: now.toISOString(),
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(baseQty)
    const decision = summary.decisions.find((d) => d.decision === 'BUY')
    const trace = decision?.trace?.find((t) => t.label === 'risk.news_shock')
    expect(trace).toBeDefined()
    expect(trace?.message).toContain('news_shock_critical')
    expect(trace?.message).toContain('observe')
  })

  it('skips the news shock gate entirely (no trace) when newsShockGate is omitted (off / back-compat)', async () => {
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
    expect(summary.newsShock).toBeUndefined()
    const decision = summary.decisions.find((d) => d.decision === 'BUY')
    const trace = decision?.trace?.find((t) => t.label === 'risk.news_shock')
    expect(trace).toBeUndefined()
  })

  it('does not block SELL even when news shock gate is critical (enforce)', async () => {
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
      newsShockGate: {
        mode: 'enforce',
        decision: {
          regime: 'critical',
          sizeScale: 0,
          reason: 'news_shock_critical: 5.1x tone-2.3 (block)',
          ratio: 5.1,
          toneDrop: 2.3,
          asOf: now.toISOString(),
        },
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(execution.calls[0]).toMatchObject({ side: 'SELL' })
    const newsHold = summary.decisions.find(
      (d) => d.decision === 'HOLD' && (d.reason ?? '').includes('news_shock_critical'),
    )
    expect(newsHold).toBeUndefined()
  })
})

describe('runPullbackScheduler extended hours gate (issue #709 Phase 6)', () => {
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

  it('option omitted (off / back-compat): no trace, qty unaffected', async () => {
    const baseQty = await probeBaseQty()
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
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(baseQty)
    const decision = summary.decisions.find((d) => d.decision === 'BUY')
    const trace = decision?.trace?.find((t) => t.label === 'risk.extended_hours')
    expect(trace).toBeUndefined()
  })

  it('observe mode traces the WARNING decision but does not change BUY quantity', async () => {
    const baseQty = await probeBaseQty()
    const execution = mockExecution()
    const decisions = new Map([
      [
        'AAPL',
        {
          action: 'reduce_entry' as const,
          multiplier: 0.5,
          reason: 'extended_hours: WARNING (premarket gap/stop proximity)',
        },
      ],
    ])
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      extendedHoursGate: { mode: 'observe', decisions },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(baseQty)
    const decision = summary.decisions.find((d) => d.decision === 'BUY')
    const trace = decision?.trace?.find((t) => t.label === 'risk.extended_hours')
    expect(trace).toBeDefined()
    expect(trace?.message).toContain('WARNING')
    expect(trace?.message).toContain('observe')
  })

  it('enforce mode halves BUY quantity on WARNING (reduce_entry, multiplier 0.5)', async () => {
    const baseQty = await probeBaseQty()
    expect(baseQty).toBeGreaterThan(1)
    const execution = mockExecution()
    const decisions = new Map([
      [
        'AAPL',
        {
          action: 'reduce_entry' as const,
          multiplier: 0.5,
          reason: 'extended_hours: WARNING (premarket gap/stop proximity)',
        },
      ],
    ])
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      extendedHoursGate: { mode: 'enforce', decisions },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(Math.floor(baseQty * 0.5))
  })

  it('enforce mode blocks the BUY on STOP_AT_OPEN_CANDIDATE (block_entry, multiplier 0)', async () => {
    const execution = mockExecution()
    const decisions = new Map([
      [
        'AAPL',
        {
          action: 'block_entry' as const,
          multiplier: 0,
          reason: 'extended_hours: STOP_AT_OPEN_CANDIDATE (premarket below effective stop)',
        },
      ],
    ])
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      extendedHoursGate: { mode: 'enforce', decisions },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const held = summary.decisions.find(
      (d) => d.decision === 'HOLD' && (d.reason ?? '').includes('STOP_AT_OPEN_CANDIDATE'),
    )
    expect(held?.reason).toContain('risk: extended_hours: STOP_AT_OPEN_CANDIDATE')
  })

  it('does not block SELL even when extended hours gate is enforce + block_entry', async () => {
    const sellingState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 5, avgPrice: 100, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const decisions = new Map([
      [
        'AAPL',
        {
          action: 'block_entry' as const,
          multiplier: 0,
          reason: 'extended_hours: STOP_AT_OPEN_CANDIDATE (premarket below effective stop)',
        },
      ],
    ])
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: sellingState }),
      execution,
      extendedHoursGate: { mode: 'enforce', decisions },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(execution.calls[0]).toMatchObject({ side: 'SELL' })
  })

  it('a symbol absent from the decisions map is unaffected (per-symbol no-op)', async () => {
    const baseQty = await probeBaseQty()
    const execution = mockExecution()
    const decisions = new Map([
      [
        'MSFT',
        {
          action: 'block_entry' as const,
          multiplier: 0,
          reason: 'extended_hours: STOP_AT_OPEN_CANDIDATE (premarket below effective stop)',
        },
      ],
    ])
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      extendedHoursGate: { mode: 'enforce', decisions },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(baseQty)
    const decision = summary.decisions.find((d) => d.decision === 'BUY')
    const trace = decision?.trace?.find((t) => t.label === 'risk.extended_hours')
    expect(trace).toBeUndefined()
  })
})

describe('runPullbackScheduler SELL_QTY_EXCEED fallback (#215 follow-up)', () => {
  // uptrendBars() の last close を crash させ、held position の trailing stop を発火させる安価な近道
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
      settledCash: 100_000, // per-symbol gate wouldn't trip if it were passed; currently unused (no-op)
    }
  }

  // WebullHttpClient が実際に投げる形を mirror — body snippet は isSellQtyExceedError が読めるよう message に埋め込む
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

    expect(execution.calls).toHaveLength(2)
    const firstIntent = execution.calls[0] as { side: string; quantity: number }
    const secondIntent = execution.calls[1] as { side: string; quantity: number }
    expect(firstIntent.side).toBe('SELL')
    expect(firstIntent.quantity).toBe(8)
    expect(secondIntent.side).toBe('SELL')
    expect(secondIntent.quantity).toBe(4)

    expect(summary.sells).toBe(1)
    expect(summary.errors).toHaveLength(0)

    expect(overrideCalls).toHaveLength(1)
    expect(overrideCalls[0]).toMatchObject({
      symbol: 'AAPL',
      args: { qty: 0 },
    })
    expect(overrideCalls[0]?.args.reason).toContain('sell_qty_fallback')

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
    const errDecision = summary.decisions.find((d) => d.decision === 'REJECT')
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
    // the 417 is artificial on a BUY signal, but proves the fallback is gated on side='SELL'
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
  // broker stub fill が ratio guard で reject されると DO state は更新されず、cron は毎 tick BUY を送ってしまう。
  // cooldown gate は直近 N 分で sanity_failed が観測されていれば BUY を block する。

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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    // DB read failure should not silently let BUY through — the broker side may have accumulated phantom shares
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.reason).toContain('sanity_failed cooldown active')
  })

  it('does not invoke check on the SELL path (existing position exit not gated)', async () => {
    // SELL は sanity_failed の根本原因ではなく、entry を凍結したいだけで exit を妨げる必要はない
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

    expect(checkSpy).not.toHaveBeenCalled()
    if (summary.sells > 0) {
      expect((execution.calls[0] as { side: string }).side).toBe('SELL')
    }
  })

  it('does not affect other symbols when one symbol is in cooldown', async () => {
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
    expect(reject?.decision).toBe('SKIP')
    expect(reject?.reason).toContain('sanity_failed cooldown active')
  })
})

describe('runPullbackScheduler per-symbol rule override (#316)', () => {
  // 3x leveraged ETF を念頭に、銘柄ごとに timeStopDays / kAtr を上書きできることを検証する
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
    // 再エントリーガードも既存 scheduler テストでは無効化 (0)。plumbing 検証は専用ケース。
    maxStopToTpRatio: 2.0,
    reentryMinAtrBelowLastExit: 0,
    reentryGuardBusinessDays: 0,
  }

  it('applies timeStopDays override to the matching symbol and falls through for others', async () => {
    // avgPrice=117 ≈ last close 117.5 なので take-profit/stop-loss は発火せず、time-stop だけが起きる
    const heldState = (symbol: string): SymbolState => ({
      ...emptySymbolState(symbol, () => now),
      position: {
        qty: 5,
        avgPrice: 117,
        // 7 BD 前: default (10d) は未到達、override (5d) では到達する境界
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
    expect(soxlDecision?.decision).toBe('SELL')
    expect(soxlDecision?.reason).toMatch(/time-stop hit.*>=\s*5d/)
    expect(aaplDecision?.decision).toBe('HOLD')
    expect(aaplDecision?.reason ?? '').not.toMatch(/time-stop hit/)
  })

  it('uses defaultRule when rulesMap is empty (NULL override fall-through)', async () => {
    const heldState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: {
        qty: 5,
        avgPrice: 117,
        openedAt: new Date('2026-04-09T00:00:00.000Z').toISOString(), // 7 BD 前 → default (10d) 未到達
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
      symbolLotSizeMap: { SOXL: 1 },
      now: () => now,
    })

    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('SKIP')
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
    expect(aapl?.decision).toBe('HOLD')
    expect(aapl?.reason).toMatch(/lot-size-round/)
  })
})

describe('runPullbackScheduler budget-alloc basis fail-closed (#417 buying-power)', () => {
  it('fail-closed (no BUY) for a budget symbol when budgetBasisJpy is undefined (total_capital_jpy 未設定)', async () => {
    // 幻の資本で sizing すると過大発注になり Webull 417 を招くため発注見送りにする
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
    expect(aapl?.decision).toBe('HOLD')
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
    expect(aapl?.decision).toBe('SKIP')
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
    expect(aapl?.decision).toBe('SKIP')
    expect(aapl?.reason).toMatch(/insufficient buying power/)
  })

  it('shared pool covers only the first of two BUYs (sequential decrement)', async () => {
    // symbolCap で notional を 1 銘柄 ≈ ¥49,937 に固定、pool ¥60,000 → 2 件目は残余力不足
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
    const rejected = summary.decisions.filter((d) => d.decision === 'SKIP')
    expect(rejected.some((d) => /insufficient buying power/.test(d.reason ?? ''))).toBe(true)
  })
})

describe('runPullbackScheduler global max order notional cap', () => {
  // budget-alloc mode で target を固定し cap 後の qty を検証する (risk-% sizing は notional が動き predictability が低い)
  it('caps notional to the global cap when no symbol cap is set (10 shares → 5)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      symbolBudgetAllocPctMap: { AAPL: 1 },
      budgetBasisJpy: 1175, // target=1175 → uncapped qty = floor(1175/117.5) = 10
      fxJpyPerSymbolCcy: 1,
      maxOrderNotional: 587.5, // → capped target 587.5 → qty = floor(587.5/117.5) = 5
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(5)
  })

  it('per-symbol cap wins when smaller than the global cap (min semantics)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      symbolBudgetAllocPctMap: { AAPL: 1 },
      budgetBasisJpy: 1175,
      fxJpyPerSymbolCcy: 1,
      symbolCapMap: { AAPL: 300 }, // smaller than the global cap below
      maxOrderNotional: 587.5,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    // floor(300/117.5) = 2, not floor(587.5/117.5) = 5 → symbol cap bound.
    expect(intent.quantity).toBe(2)
  })
})

describe('runPullbackScheduler portfolio exposure cap gate', () => {
  it('fail-closed: rejects BUY when the exposure ledger is unavailable', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      exposureCap: createUnavailableExposureLedger('total_capital_jpy unset'),
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const aapl = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(aapl?.decision).toBe('SKIP')
    expect(aapl?.reason).toMatch(/portfolio exposure cap unavailable/)
  })

  it('places a BUY and decrements the exposure ledger when remaining covers notional', async () => {
    const execution = mockExecution()
    const ledger = createExposureLedger({ ceilingJpy: 1_000_000_000, currentJpy: 0 })
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      fxJpyPerSymbolCcy: 150,
      exposureCap: ledger,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect(ledger.remainingJpy).toBeLessThan(1_000_000_000)
  })

  it('shared exposure ledger covers only the first of two BUYs (sequential decrement)', async () => {
    const execution = mockExecution()
    const ledger = createExposureLedger({ ceilingJpy: 60_000, currentJpy: 0 })
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
      exposureCap: ledger,
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const rejected = summary.decisions.filter((d) => d.decision === 'SKIP')
    expect(rejected.some((d) => /portfolio exposure cap/.test(d.reason ?? ''))).toBe(true)
  })

  it('SELL (stop-loss exit) is not blocked by an unavailable exposure ledger', async () => {
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 5, avgPrice: 200, openedAt: new Date('2026-01-01T00:00:00.000Z').toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()), // last close 117.5 << avgPrice 200 → stop hit
      positionStore: makeStore({ AAPL: heldState }),
      execution,
      exposureCap: createUnavailableExposureLedger('total_capital_jpy unset'),
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    expect((execution.calls[0] as { side: string }).side).toBe('SELL')
  })
})

describe('runPullbackScheduler broker-error decision embeds order amount (#417)', () => {
  it('includes qty + USD/JPY notional in the REJECT reason for a USD symbol', async () => {
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
    const err = summary.decisions.find((d) => d.decision === 'REJECT')
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
    const err = summary.decisions.find((d) => d.decision === 'REJECT')
    expect(err?.reason).toMatch(/発注内容: \d+口 @ ¥/)
    expect(err?.reason).not.toContain('USD/JPY')
  })
})

describe('runPullbackScheduler broker submit decision taxonomy (SKIP/REJECT/ERROR)', () => {
  function throwingExecution(err: Error): Execution & { calls: unknown[] } {
    const calls: unknown[] = []
    return {
      calls,
      async execute(intent) {
        calls.push(intent)
        throw err
      },
    }
  }

  async function runWith(err: Error) {
    return runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: throwingExecution(err),
      symbolLotSizeMap: { AAPL: 1 },
      now: () => now,
    })
  }

  it('BrokerRequestError 4xx (確定拒否) → REJECT', async () => {
    const summary = await runWith(
      new BrokerClientError(
        'Webull request failed permanently with status 417: {"error_code":"OAUTH_OPENAPI_ORDER_BUYING_POWER_NOT_ENOUGH"}',
        'placeOrder',
        { brokerStatus: 417 },
      ),
    )
    const d = summary.decisions.find((x) => x.symbol === 'AAPL')
    expect(d?.decision).toBe('REJECT')
    expect(d?.reason).toMatch(/^broker submit error: /)
    // summary 構造は従来どおり errors 側に載る (分類のみの変更)
    expect(summary.errors).toHaveLength(1)
  })

  it('BrokerRequestError 5xx (一時的) → ERROR', async () => {
    const summary = await runWith(
      new BrokerServerError(
        'Webull request failed after 3 attempts with last status 502: <no body>',
        'placeOrder',
        { brokerStatus: 502 },
      ),
    )
    const d = summary.decisions.find((x) => x.symbol === 'AAPL')
    expect(d?.decision).toBe('ERROR')
    expect(d?.reason).toMatch(/^broker submit error: /)
  })

  it('非 BrokerRequestError (ネットワーク断など) → ERROR', async () => {
    const summary = await runWith(new Error('fetch failed: network down'))
    const d = summary.decisions.find((x) => x.symbol === 'AAPL')
    expect(d?.decision).toBe('ERROR')
    expect(d?.reason).toMatch(/^broker submit error: /)
  })

  it('BrokerRateLimitError 429 (rate limit、一時的) → ERROR (REJECT にしない)', async () => {
    const summary = await runWith(
      new BrokerRateLimitError(
        'Webull request failed after 3 attempts with last status 429: <no body>',
        'placeOrder',
        { brokerStatus: 429 },
      ),
    )
    const d = summary.decisions.find((x) => x.symbol === 'AAPL')
    expect(d?.decision).toBe('ERROR')
    expect(d?.reason).toMatch(/^broker submit error: /)
  })

  it('内部ゲート見送り (broker 未到達) → SKIP (broker には一切 submit しない)', async () => {
    const execution = throwingExecution(new Error('must not be called'))
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      symbolLotSizeMap: { AAPL: 1 },
      entrySuppressedSymbols: { AAPL: 'role: cash_parking (entry 無効)' },
      now: () => now,
    })
    const d = summary.decisions.find((x) => x.symbol === 'AAPL')
    expect(d?.decision).toBe('SKIP')
    expect(execution.calls).toHaveLength(0)
    expect(summary.errors).toHaveLength(0)
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

  // 15分 cron は force-close (引け前15分) と新規 entry を同じ window で両立できないため、直前の新規 BUY を止める
  describe('no new entry within 30min of US close', () => {
    // 2026-04-20 月曜、EDT → 引け 20:00 UTC。
    const noEntryWindow = new Date('2026-04-20T19:45:00.000Z') // 15:45 ET (引け15分前、force-close 境界と重複)
    const beforeNoEntryWindow = new Date('2026-04-20T19:20:00.000Z') // 15:20 ET (30分window の外)

    it('holds a flat intraday-only symbol with an entry setup at 15:45 ET (0 BUYs)', async () => {
      const execution = mockExecution()
      const summary = await runPullbackScheduler({
        symbols: ['QQQ'],
        equity: 100_000,
        barClient: mockBarClient(uptrendBars()),
        positionStore: makeStore({}),
        execution,
        defaultRule: TEST_DEFAULT_RULE,
        intradayOnlySymbols: new Set(['QQQ']),
        now: () => noEntryWindow,
      })
      expect(summary.buys).toBe(0)
      expect(execution.calls).toHaveLength(0)
      const decision = summary.decisions.find((d) => d.symbol === 'QQQ')
      expect(decision?.decision).toBe('HOLD')
      expect(decision?.trace?.map((s) => s.label)).toContain('entry.intraday_no_entry')
    })

    it('still allows the BUY at 15:20 ET (outside the 30min window)', async () => {
      const execution = mockExecution()
      const summary = await runPullbackScheduler({
        symbols: ['QQQ'],
        equity: 100_000,
        barClient: mockBarClient(uptrendBars()),
        positionStore: makeStore({}),
        execution,
        defaultRule: TEST_DEFAULT_RULE,
        intradayOnlySymbols: new Set(['QQQ']),
        now: () => beforeNoEntryWindow,
      })
      expect(summary.buys).toBe(1)
    })

    it('does not hold a non-intraday-only symbol at 15:45 ET (BUY proceeds)', async () => {
      const execution = mockExecution()
      const summary = await runPullbackScheduler({
        symbols: ['QQQ'],
        equity: 100_000,
        barClient: mockBarClient(uptrendBars()),
        positionStore: makeStore({}),
        execution,
        defaultRule: TEST_DEFAULT_RULE,
        intradayOnlySymbols: new Set(['TQQQ']), // QQQ は対象外
        now: () => noEntryWindow,
      })
      expect(summary.buys).toBe(1)
    })

    it('vetoes a HALF-eligible entry_gate HOLD at 15:45 ET even when the symbol also qualifies for HALF promotion (#452)', async () => {
      // veto を HALF 昇格判定より前に行わないと、昇格判定が BUY を復活させてしまう
      const HALF_RULE = { ...TEST_DEFAULT_RULE, pullbackMin: -0.035 }
      const execution = mockExecution()
      const summary = await runPullbackScheduler({
        symbols: ['QQQ'],
        equity: 100_000,
        barClient: mockBarClient(uptrendBars()),
        positionStore: makeStore({}),
        execution,
        defaultRule: HALF_RULE,
        intradayOnlySymbols: new Set(['QQQ']),
        halfEntrySymbols: new Set(['QQQ']),
        now: () => noEntryWindow,
      })
      expect(summary.buys).toBe(0)
      expect(execution.calls).toHaveLength(0)
      const decision = summary.decisions.find((d) => d.symbol === 'QQQ')
      expect(decision?.decision).toBe('HOLD')
      expect(decision?.trace?.map((s) => s.label)).toContain('entry.intraday_no_entry')
    })
  })
})

describe('runPullbackScheduler role entry suppression (#452)', () => {
  it('rejects BUY for a suppressed symbol with the supplied reason', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      entrySuppressedSymbols: { SGOV: 'role: cash_parking entry is not enabled (#452)' },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.symbol).toBe('SGOV')
    expect(reject?.reason).toContain('cash_parking')
    expect(reject?.trace?.map((s) => s.label)).toContain('risk.role_entry_suppressed')
  })

  it('does not affect non-suppressed symbols in the same run', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV', 'AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      entrySuppressedSymbols: { SGOV: 'role: cash_parking entry is not enabled (#452)' },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect((execution.calls[0] as { symbol: string }).symbol).toBe('AAPL')
  })

  it('does not gate the SELL path (exit of a held position still runs)', async () => {
    // role を後から変えた銘柄に保有が残っていても exit は従来どおり動く (fail-closed は entry 側のみ)
    const execution = mockExecution()
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: {
        qty: 5,
        avgPrice: 80,
        openedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState }),
      execution,
      entrySuppressedSymbols: { AAPL: 'role: inverse_hedge entry is not enabled (#452)' },
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    expect((execution.calls[0] as { side: string }).side).toBe('SELL')
  })

  it('skips the gate when option is omitted (back-compat)', async () => {
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

// #658: TEST_DEFAULT_RULE で評価すると price=47.1187/atr20=2.35 (bars を逆算)、pullback=-6.5% (許容バンド
// [-0.072,-0.06) 内) のみ未通過、他 6 gate は全通過 → HALF/pullback_deep。
// 旧実装は entry status の再導出だけを見て BUY 0.5x に昇格させていたが、実際は reentry guard
// (前回売値 45.8302 に対し price 47.1187 が高すぎる) が早期 return で HOLD を確定させており、
// 7 gate 集合に無い再エントリーガードは再導出では検知できなかった。
function reentryHalfMissBars(): DailyBar[] {
  const SPREAD_ABS = 1.175 // high-low per bar -> atr20 = 2.35
  const start = 43
  const peak = 47.1187 / (1 - 0.065) - SPREAD_ABS // -> high20d = 47.1187/0.935, pullback = -6.5%
  const final = 47.1187
  const synthClose = (i: number, close: number): DailyBar => {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
    return { date, open: close, high: close + SPREAD_ABS, low: close - SPREAD_ABS, close }
  }
  const bars: DailyBar[] = []
  for (let i = 0; i < 40; i += 1) bars.push(synthClose(i, start - 4 + i * 0.1))
  for (let i = 40; i < 55; i += 1) bars.push(synthClose(i, start + ((peak - start) * (i - 40)) / 14))
  bars.push(synthClose(55, peak))
  bars.push(synthClose(56, peak - (peak - final) * 0.25))
  bars.push(synthClose(57, peak - (peak - final) * 0.5))
  bars.push(synthClose(58, peak - (peak - final) * 0.8))
  bars.push(synthClose(59, final))
  return bars
}

describe('runPullbackScheduler half entry (#452 段階判定)', () => {
  // uptrendBars() の pullback ≈ -3.69%。pullbackMin -0.035 だと僅差で落ち (許容バンド -0.042 以内) HALF 候補、
  // -0.025 だとバンド外で WATCH (発注なし)
  const HALF_RULE = { ...TEST_DEFAULT_RULE, pullbackMin: -0.035 }
  const WATCH_RULE = { ...TEST_DEFAULT_RULE, pullbackMin: -0.025, pullbackMax: -0.03 }

  it('upgrades a near-miss HOLD to BUY at 0.5x sizing for half-entry enabled symbols', async () => {
    // 基準: 同条件で全 gate 通過なら full qty が出る。
    const fullExecution = mockExecution()
    await runPullbackScheduler({
      symbols: ['QQQ'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: fullExecution,
      defaultRule: TEST_DEFAULT_RULE,
      now: () => now,
    })
    const fullQty = (fullExecution.calls[0] as { quantity: number }).quantity
    expect(fullQty).toBeGreaterThan(1)

    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['QQQ'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      defaultRule: HALF_RULE,
      halfEntrySymbols: new Set(['QQQ']),
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { quantity: number; side: string }
    expect(intent.side).toBe('BUY')
    expect(intent.quantity).toBe(Math.floor(fullQty * 0.5))
    const buy = summary.decisions.find((d) => d.decision === 'BUY')
    expect(buy?.reason).toContain('half entry (0.5x)')
    expect(buy?.trace?.map((s) => s.label)).toContain('entry.half_status')
  })

  it('keeps the legacy binary behavior when the symbol is not half-entry enabled (role NULL 回帰)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      defaultRule: HALF_RULE,
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.holds).toBe(1)
    expect(execution.calls).toHaveLength(0)
  })

  it('does not order on WATCH (single gate miss beyond the tolerance band)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['QQQ'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      defaultRule: WATCH_RULE,
      halfEntrySymbols: new Set(['QQQ']),
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.holds).toBe(1)
    expect(execution.calls).toHaveLength(0)
  })

  it('half entry still passes through downstream risk gates (inverse-pair exposure rejects) (#452)', async () => {
    const execution = mockExecution()
    const inverseHeld: SymbolState = {
      ...emptySymbolState('SQQQ', () => now),
      position: { qty: 3, avgPrice: 20, openedAt: now.toISOString() },
    }
    const summary = await runPullbackScheduler({
      symbols: ['QQQ'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SQQQ: inverseHeld }),
      execution,
      defaultRule: HALF_RULE,
      halfEntrySymbols: new Set(['QQQ']),
      perSymbolRisk: {
        inversePairs: { QQQ: 'SQQQ', SQQQ: 'QQQ' },
        spreadLimits: { US: 0.0025, JP: 0.006 },
        staleQuoteMs: 900_000,
        gapRejectPct: 0.03,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.reason).toContain('inverse')
  })

  // #660: lastExitPrice を明示設定して価格比較ガード本来の経路を通す
  // (lastExecutedPrice のままだと #660 移行期 fail-closed 経路に落ちてしまう)。
  it('does not promote a re-entry-guard HOLD even when the underlying gates would derive HALF (#658)', async () => {
    const execution = mockExecution()
    const guardedState: SymbolState = {
      ...emptySymbolState('SQQQ', () => now),
      lastExitPrice: 45.8302,
      // now (2026-04-20 Mon) の 2 営業日前 (Thu) → businessDaysSinceExit = 2 < 3。
      lastExitAt: '2026-04-16T14:30:00.000Z',
    }
    const summary = await runPullbackScheduler({
      symbols: ['SQQQ'],
      equity: 100_000,
      barClient: mockBarClient(reentryHalfMissBars()),
      positionStore: makeStore({ SQQQ: guardedState }),
      execution,
      defaultRule: TEST_DEFAULT_RULE,
      halfEntrySymbols: new Set(['SQQQ']),
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'SQQQ')
    expect(decision?.decision).toBe('HOLD')
    expect(decision?.reason).toMatch(/re-entry guard/)
    expect(decision?.reason).toContain('45.8302')
    expect(decision?.reason).toContain('43.48')
    expect(decision?.trace?.map((s) => s.label)).toContain('entry.reentry_below_last_exit')
    expect(decision?.trace?.map((s) => s.label)).not.toContain('entry.half_status')
  })

  it('promotes the same HALF-eligible symbol once the re-entry guard window has elapsed (#658)', async () => {
    const execution = mockExecution()
    const staleExitState: SymbolState = {
      ...emptySymbolState('SQQQ', () => now),
      lastExitPrice: 45.8302,
      // ~6 営業日前 → businessDaysSinceExit >= 3 → ガード無効化。
      lastExitAt: '2026-04-10T14:30:00.000Z',
    }
    const summary = await runPullbackScheduler({
      symbols: ['SQQQ'],
      equity: 100_000,
      barClient: mockBarClient(reentryHalfMissBars()),
      positionStore: makeStore({ SQQQ: staleExitState }),
      execution,
      defaultRule: TEST_DEFAULT_RULE,
      halfEntrySymbols: new Set(['SQQQ']),
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { side: string }
    expect(intent.side).toBe('BUY')
    const buy = summary.decisions.find((d) => d.decision === 'BUY')
    expect(buy?.reason).toContain('half entry (0.5x)')
    expect(buy?.trace?.map((s) => s.label)).toContain('entry.half_status')
  })
})

describe('runPullbackScheduler cash rebalance / entry snapshots (#452 Layer 3)', () => {
  it('collects per-symbol entry snapshots (status / price / heldQty)', async () => {
    const heldState: SymbolState = {
      ...emptySymbolState('SOXS', () => now),
      position: { qty: 7, avgPrice: 100, openedAt: now.toISOString() },
    }
    const summary = await runPullbackScheduler({
      symbols: ['AAPL', 'SOXS'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SOXS: heldState }),
      execution: mockExecution(),
      now: () => now,
    })
    expect(summary.entrySnapshots.AAPL).toEqual({ status: 'ENTRY', price: 117.5, heldQty: 0 })
    expect(summary.entrySnapshots.SOXS?.heldQty).toBe(7)
  })

  it('cashRebalanceQuantityMap forces a fixed-quantity BUY bypassing pullback gates', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      cashRebalanceQuantityMap: { SGOV: 80 },
      // 通常評価なら WATCH/NG になる厳しい rule でも rebalance は通る
      defaultRule: { ...TEST_DEFAULT_RULE, minReturn50d: 5 },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    const intent = execution.calls[0] as { symbol: string; side: string; quantity: number }
    expect(intent).toMatchObject({ symbol: 'SGOV', side: 'BUY', quantity: 80 })
    const buy = summary.decisions.find((d) => d.decision === 'BUY')
    expect(buy?.reason).toContain('cash allocation rebalance')
    expect(buy?.trace?.map((s) => s.label)).toContain('entry.cash_rebalance')
  })

  it('cash rebalance respects pending-order lock (no double submit)', async () => {
    const execution = mockExecution()
    const pendingState: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      pendingOrder: {
        clientOrderId: 'coid-1',
        side: 'BUY',
        submittedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: pendingState }),
      execution,
      cashRebalanceQuantityMap: { SGOV: 80 },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
  })

  it('cash rebalance still fails closed without lot_size when map mode is on', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution,
      cashRebalanceQuantityMap: { SGOV: 80 },
      symbolLotSizeMap: {}, // lot 必須モード + SGOV 未設定
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    expect(summary.rejected[0]?.reason).toContain('missing-lot-size')
  })

  it('cash rebalance never overrides a strategy SELL (stop-loss exit wins)', async () => {
    // avgPrice 200 vs last close 117.5 は -4% stop を大きく超えるため decide() は SELL を返す
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 5, avgPrice: 200, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState }),
      execution,
      cashRebalanceQuantityMap: { AAPL: 80 },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    expect((execution.calls[0] as { side: string }).side).toBe('SELL')
    const decision = summary.decisions.find((d) => d.symbol === 'AAPL')
    expect(decision?.decision).toBe('SELL')
    const step = decision?.trace?.find((s) => s.label === 'entry.cash_rebalance')
    expect(step?.passed).toBe(false)
    expect(decision?.reason).toContain('cash rebalance skipped: strategy exit takes precedence')
  })

  it('cash rebalance respects post-exit cooldown', async () => {
    const flatState: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      cooldownUntil: new Date(now.getTime() + 60_000).toISOString(),
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: flatState }),
      execution,
      cashRebalanceQuantityMap: { SGOV: 80 },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'SGOV')
    const step = decision?.trace?.find((s) => s.label === 'entry.cash_rebalance')
    expect(step?.passed).toBe(false)
    expect(decision?.reason).toContain('cash rebalance skipped: cooldown active until')
  })

  it('cash rebalance respects the re-entry guard window', async () => {
    // reentryGuardBusinessDays=3。lastExitAt 1 business day 前 → bd=1 < 3 → guard 有効
    const withinGuard: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      lastExitAt: '2026-04-17T14:30:00.000Z',
      lastExitPrice: 100,
    }
    const execution1 = mockExecution()
    const withinSummary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: withinGuard }),
      execution: execution1,
      cashRebalanceQuantityMap: { SGOV: 80 },
      now: () => now,
    })
    expect(withinSummary.buys).toBe(0)
    expect(execution1.calls).toHaveLength(0)
    const withinDecision = withinSummary.decisions.find((d) => d.symbol === 'SGOV')
    const withinStep = withinDecision?.trace?.find((s) => s.label === 'entry.cash_rebalance')
    expect(withinStep?.passed).toBe(false)
    expect(withinDecision?.reason).toContain('cash rebalance skipped: re-entry guard window')

    // lastExitAt 10 business days 前 (2026-04-06 月) → bd=10 >= 3 → guard 失効、BUY 通る。
    const pastGuard: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      lastExitAt: '2026-04-06T14:30:00.000Z',
      lastExitPrice: 100,
    }
    const execution2 = mockExecution()
    const pastSummary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: pastGuard }),
      execution: execution2,
      cashRebalanceQuantityMap: { SGOV: 80 },
      now: () => now,
    })
    expect(pastSummary.buys).toBe(1)
    expect(execution2.calls).toHaveLength(1)
  })

  it('cashRebalanceSellQuantityMap emits a partial SELL toward active weight (#452 follow-up)', async () => {
    // avgPrice 112 vs last close 117.5 → pnl ≈ +4.9%、stop/TP どちらにも掛からず HOLD になる held position
    const heldState: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      position: { qty: 100, avgPrice: 112, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: heldState }),
      execution,
      cashRebalanceSellQuantityMap: { SGOV: 30 },
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    const intent = execution.calls[0] as { symbol: string; side: string; quantity: number }
    expect(intent).toMatchObject({ symbol: 'SGOV', side: 'SELL', quantity: 30 })
    const sell = summary.decisions.find((d) => d.decision === 'SELL')
    expect(sell?.reason).toContain('cash allocation rebalance: sell 30 toward active weight')
    expect(sell?.trace?.map((s) => s.label)).toContain('exit.cash_rebalance')
  })

  it('cashRebalanceSellQuantityMap の要求数量が保有数量を超える場合は保有数量に clamp する', async () => {
    const heldState: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      position: { qty: 10, avgPrice: 112, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: heldState }),
      execution,
      cashRebalanceSellQuantityMap: { SGOV: 30 }, // > 保有 10
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    const intent = execution.calls[0] as { quantity: number }
    expect(intent.quantity).toBe(10)
  })

  it('cash rebalance SELL は strategy exit (stop-loss) を上書きしない (全量売却が優先、二重発注なし)', async () => {
    // avgPrice 200 vs last close 117.5 → 深い含み損で stop-loss 経由の SELL (全量 5 株) になる
    const heldState: SymbolState = {
      ...emptySymbolState('AAPL', () => now),
      position: { qty: 5, avgPrice: 200, openedAt: now.toISOString() },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['AAPL'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ AAPL: heldState }),
      execution,
      cashRebalanceSellQuantityMap: { AAPL: 2 },
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    expect(execution.calls).toHaveLength(1)
    const intent = execution.calls[0] as { quantity: number; side: string }
    expect(intent.side).toBe('SELL')
    expect(intent.quantity).toBe(5) // strategy exit の全量、cash rebalance の 2 ではない
    const decision = summary.decisions.find((d) => d.symbol === 'AAPL')
    const step = decision?.trace?.find((s) => s.label === 'exit.cash_rebalance')
    expect(step?.passed).toBe(false)
    expect(decision?.reason).not.toContain('cash allocation rebalance: sell')
  })

  it('cash rebalance SELL は pending order ロックを尊重する (二重発注なし)', async () => {
    const pendingState: SymbolState = {
      ...emptySymbolState('SGOV', () => now),
      position: { qty: 100, avgPrice: 112, openedAt: now.toISOString() },
      pendingOrder: {
        clientOrderId: 'coid-1',
        side: 'SELL',
        submittedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      },
    }
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ SGOV: pendingState }),
      execution,
      cashRebalanceSellQuantityMap: { SGOV: 30 },
      now: () => now,
    })
    expect(summary.sells).toBe(0)
    expect(execution.calls).toHaveLength(0)
  })

  it('保有が無ければ cash rebalance SELL は何もしない', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SGOV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}), // 保有なし
      execution,
      cashRebalanceSellQuantityMap: { SGOV: 30 },
      // entry 側の BUY signal と混同しないよう、通常評価は HOLD 相当に倒す。
      defaultRule: { ...TEST_DEFAULT_RULE, minReturn50d: 5 },
      now: () => now,
    })
    expect(summary.sells).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const decision = summary.decisions.find((d) => d.symbol === 'SGOV')
    const step = decision?.trace?.find((s) => s.label === 'exit.cash_rebalance')
    expect(step?.passed).toBe(false)
  })
})

describe('inverse_hedge role enabled but inverse-pair gate still wins (#457)', () => {
  it('role 有効化後も相手保有中の BUY は inverse-pair gate で reject', async () => {
    const { buildEntrySuppressedSymbols } = await import(
      '../../../src/trading/strategy/symbolRuleResolution'
    )
    const suppressed = buildEntrySuppressedSymbols({ SQQQ: 'inverse_hedge' })
    expect(suppressed).toEqual({})

    const execution = mockExecution()
    const counterpartHeld: SymbolState = {
      ...emptySymbolState('TQQQ', () => now),
      position: { qty: 2, avgPrice: 50, openedAt: now.toISOString() },
    }
    const summary = await runPullbackScheduler({
      symbols: ['SQQQ'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ TQQQ: counterpartHeld }),
      execution,
      entrySuppressedSymbols: suppressed,
      perSymbolRisk: {
        inversePairs: { SQQQ: 'TQQQ', TQQQ: 'SQQQ' },
        spreadLimits: { US: 0.0025, JP: 0.006 },
        staleQuoteMs: 900_000,
        gapRejectPct: 0.03,
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
    expect(reject?.reason).toContain('inverse')
  })
})

describe('runPullbackScheduler TICKER_IS_DENY hook (#460)', () => {
  const denyError = () =>
    new BrokerClientError(
      'Webull request failed permanently with status 417: {"message":"The current security is not available.","error_code":"OAUTH_OPENAPI_TICKER_IS_DENY"}',
      'placeOrder',
      { brokerStatus: 417 },
    )

  function throwingExecution(err: Error): Execution & { calls: unknown[] } {
    const calls: unknown[] = []
    return {
      calls,
      async execute(intent) {
        calls.push(intent)
        throw err
      },
    }
  }

  it('calls onTickerDeny when a BUY submit is denied per-ticker', async () => {
    const hook = vi.fn(async () => undefined)
    const summary = await runPullbackScheduler({
      symbols: ['USMV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: throwingExecution(denyError()),
      onTickerDeny: hook,
      now: () => now,
    })
    expect(hook).toHaveBeenCalledWith('USMV')
    expect(summary.errors).toHaveLength(1)
    // broker 417 確定拒否なので REJECT decision / journal は従来どおり残る (hook は追加動作)
    expect(summary.decisions.find((d) => d.decision === 'REJECT')?.reason).toContain('TICKER_IS_DENY')
  })

  it('does not call the hook for other broker errors', async () => {
    const hook = vi.fn(async () => undefined)
    await runPullbackScheduler({
      symbols: ['USMV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: throwingExecution(new BrokerServerError('boom', 'placeOrder', { brokerStatus: 500 })),
      onTickerDeny: hook,
      now: () => now,
    })
    expect(hook).not.toHaveBeenCalled()
  })

  it('does not call the hook on the SELL path (保有 orphan 化を避ける)', async () => {
    // SELL submit が deny で落ちても、銘柄は評価対象に残り exit は次 tick で再試行される
    const hook = vi.fn(async () => undefined)
    const heldState: SymbolState = {
      ...emptySymbolState('USMV', () => now),
      position: {
        qty: 5,
        avgPrice: 80,
        openedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['USMV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({ USMV: heldState }),
      execution: throwingExecution(denyError()),
      onTickerDeny: hook,
      now: () => now,
    })
    expect(summary.errors).toHaveLength(1)
    expect(hook).not.toHaveBeenCalled()
  })

  it('skips the hook when option is omitted (back-compat)', async () => {
    const summary = await runPullbackScheduler({
      symbols: ['USMV'],
      equity: 100_000,
      barClient: mockBarClient(uptrendBars()),
      positionStore: makeStore({}),
      execution: throwingExecution(denyError()),
      now: () => now,
    })
    expect(summary.errors).toHaveLength(1)
  })
})

describe('runPullbackScheduler pair regime layer (#472)', () => {
  const REGIME_PAIR = {
    bullSymbol: 'SOXL',
    bearSymbol: 'SOXS',
    proxySymbol: 'SOXX',
    invalidConfig: null,
  }
  const THRESHOLDS = { bullEnter: 0.03, bullExit: 0.01, bearEnter: -0.04, bearExit: -0.015 }

  /** now (2026-04-20) の前日で終わる proxy bars。ratio 1.003 → bull / 1.0 → neutral。 */
  function proxyBars(ratio: number): DailyBar[] {
    const end = Date.parse('2026-04-19T00:00:00.000Z')
    return Array.from({ length: 80 }, (_, i) => {
      const close = 100 * ratio ** i
      return {
        date: new Date(end - (79 - i) * 86_400_000).toISOString().slice(0, 10),
        open: close,
        high: close * 1.005,
        low: close * 0.995,
        close,
      }
    })
  }

  /** symbol ごとに bars を返す barClient (proxy と取引銘柄で別系列)。 */
  function mapBarClient(map: Record<string, DailyBar[]>): BarClient {
    return {
      getDailyBars: vi.fn(async (symbol: string) => {
        const bars = map[symbol.toUpperCase()]
        if (!bars) throw new Error(`no bars for ${symbol}`)
        return bars
      }),
    }
  }

  it('enforce: zone=bull はブル側 BUY を通し、ベア側 BUY を SKIP する', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL', 'SOXS'],
      equity: 100_000,
      barClient: mapBarClient({ SOXL: uptrendBars(), SOXS: uptrendBars(), SOXX: proxyBars(1.003) }),
      positionStore: makeStore({}),
      execution,
      pairRegime: { mode: 'enforce', thresholds: THRESHOLDS, pairs: [REGIME_PAIR] },
      now: () => now,
    })
    expect(summary.buys).toBe(1)
    expect((execution.calls[0] as { symbol: string }).symbol).toBe('SOXL')
    const reject = summary.decisions.find((d) => d.decision === 'SKIP' && d.symbol === 'SOXS')
    expect(reject?.reason).toContain('pair_regime: zone=bull blocks bear entry')
    expect(reject?.trace?.map((s) => s.label)).toContain('risk.pair_regime')
  })

  it('enforce: zone=neutral は両側 BUY を SKIP する (chop 帯の遮断)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL', 'SOXS'],
      equity: 100_000,
      barClient: mapBarClient({ SOXL: uptrendBars(), SOXS: uptrendBars(), SOXX: proxyBars(1.0) }),
      positionStore: makeStore({}),
      execution,
      pairRegime: { mode: 'enforce', thresholds: THRESHOLDS, pairs: [REGIME_PAIR] },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(execution.calls).toHaveLength(0)
    expect(summary.rejected.filter((r) => r.reason.includes('pair_regime'))).toHaveLength(2)
  })

  it('enforce: proxy fetch 失敗は unknown → 両側 BUY block (fail-closed)、exit は素通り', async () => {
    const execution = mockExecution()
    const heldState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      position: {
        qty: 5,
        avgPrice: 80, // +47% → take_profit SELL が出る
        openedAt: new Date('2026-04-17T00:00:00.000Z').toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['SOXL', 'SOXS'],
      equity: 100_000,
      barClient: mapBarClient({ SOXL: uptrendBars(), SOXS: uptrendBars() }), // SOXX なし → throw
      positionStore: makeStore({ SOXL: heldState }),
      execution,
      pairRegime: { mode: 'enforce', thresholds: THRESHOLDS, pairs: [REGIME_PAIR] },
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    const reject = summary.decisions.find((d) => d.decision === 'SKIP' && d.symbol === 'SOXS')
    expect(reject?.reason).toContain('zone=unknown')
  })

  it('observe: gate せず trace に zone と「enforce なら SKIP」を残す', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXS'],
      equity: 100_000,
      barClient: mapBarClient({ SOXS: uptrendBars(), SOXX: proxyBars(1.003) }),
      positionStore: makeStore({}),
      execution,
      pairRegime: { mode: 'observe', thresholds: THRESHOLDS, pairs: [REGIME_PAIR] },
      now: () => now,
    })
    expect(summary.buys).toBe(1) // block しない
    const buy = summary.decisions.find((d) => d.decision === 'BUY')
    const regimeStep = buy?.trace?.find((s) => s.label === 'regime.zone')
    expect(regimeStep).toBeDefined()
    expect(JSON.stringify(regimeStep)).toContain('observe')
  })

  it('enforce: 保有と反対 zone への flip で regime_flip SELL を出す', async () => {
    const execution = mockExecution()
    const heldState: SymbolState = {
      ...emptySymbolState('SOXS', () => now),
      position: {
        qty: 3,
        avgPrice: 115, // +2.2% — TP/stop/time にかからない
        openedAt: new Date('2026-04-17T00:00:00.000Z').toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['SOXS'],
      equity: 100_000,
      barClient: mapBarClient({ SOXS: uptrendBars(), SOXX: proxyBars(1.003) }), // zone=bull vs ベア保有
      positionStore: makeStore({ SOXS: heldState }),
      execution,
      pairRegime: { mode: 'enforce', thresholds: THRESHOLDS, pairs: [REGIME_PAIR] },
      now: () => now,
    })
    expect(summary.sells).toBe(1)
    const sell = summary.decisions.find((d) => d.decision === 'SELL')
    expect(sell?.reason).toContain('pair regime flip')
    expect(sell?.trace?.map((s) => s.label)).toContain('exit.regime_flip')
  })

  it('enforce: 既存 exit (TP) が先に出ていれば regime_flip は副次理由として trace に残る', async () => {
    const execution = mockExecution()
    const heldState: SymbolState = {
      ...emptySymbolState('SOXS', () => now),
      position: {
        qty: 3,
        avgPrice: 80, // +47% → take_profit SELL
        openedAt: new Date('2026-04-17T00:00:00.000Z').toISOString(),
      },
    }
    const summary = await runPullbackScheduler({
      symbols: ['SOXS'],
      equity: 100_000,
      barClient: mapBarClient({ SOXS: uptrendBars(), SOXX: proxyBars(1.003) }),
      positionStore: makeStore({ SOXS: heldState }),
      execution,
      pairRegime: { mode: 'enforce', thresholds: THRESHOLDS, pairs: [REGIME_PAIR] },
      now: () => now,
    })
    const sell = summary.decisions.find((d) => d.decision === 'SELL')
    expect(sell?.reason).not.toContain('pair regime flip') // 主理由は既存 exit のまま
    expect(sell?.trace?.map((s) => s.label)).toContain('exit.regime_flip_secondary')
  })

  it('misconfig ペアは unknown 扱いで BUY block (黙って無効化しない)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mapBarClient({ SOXL: uptrendBars(), SOXX: proxyBars(1.003) }),
      positionStore: makeStore({}),
      execution,
      pairRegime: {
        mode: 'enforce',
        thresholds: THRESHOLDS,
        pairs: [{ ...REGIME_PAIR, invalidConfig: 'regime_bull_symbol must be SOXL or SOXS' }],
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.rejected[0]?.reason).toContain('zone=unknown')
  })
  it('重複ペア設定の symbol は unknown に倒れる (非決定性の排除、CodeRabbit #473)', async () => {
    const execution = mockExecution()
    const summary = await runPullbackScheduler({
      symbols: ['SOXL'],
      equity: 100_000,
      barClient: mapBarClient({ SOXL: uptrendBars(), SOXX: proxyBars(1.003), QQQ: proxyBars(1.003) }),
      positionStore: makeStore({}),
      execution,
      pairRegime: {
        mode: 'enforce',
        thresholds: THRESHOLDS,
        pairs: [
          REGIME_PAIR,
          { bullSymbol: 'SOXL', bearSymbol: 'SQQQ', proxySymbol: 'QQQ', invalidConfig: null },
        ],
      },
      now: () => now,
    })
    expect(summary.buys).toBe(0)
    expect(summary.rejected[0]?.reason).toContain('zone=unknown')
    expect(summary.rejected[0]?.reason).toContain('duplicate pair config')
  })
})
