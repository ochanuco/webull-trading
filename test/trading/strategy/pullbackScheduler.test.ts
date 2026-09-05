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
    // 押し目 (momentum 未指定): 新高値なので HOLD = 発注なし。
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

    // momentum 指定: 同 bars でブレイク BUY。signal は通常経路で execution まで到達。
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

  // #reentry: flat な state に前回手仕舞い (lastExitPrice + lastExitAt) が
  // 残っていると、scheduler がそれを strategy に plumb し、窓内 & 値幅不足なら
  // BUY を price 軸ガードで止める (uptrendBars は本来 BUY する fixture)。
  it('blocks a would-be BUY when re-entry price guard is active (recent exit near price)', async () => {
    const recentlyExited: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      // 直近 BUY fixture の last close = 117.5。前回売値をそこに置くと
      // ceiling = 117.5 - 1*ATR < 117.5 なので必ずガードに掛かる。
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

  // #660: overridePosition (sync-holdings 経由) は position を null にするだけで
  // lastExecutedPrice は古い BUY 価格のまま残りうる。lastExitAt も無い
  // (= 一度も exit していない、または旧 state のまま) 銘柄は未取引扱いなので、
  // その stale lastExecutedPrice をガード基準に「推論」してはいけない —
  // 従来どおり無条件で BUY を通す。
  it('treats a symbol with no lastExitAt as never-exited and does not infer a guard from stale lastExecutedPrice', async () => {
    const neverExitedState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      // sync-holdings 由来の残骸: 古い BUY 価格が居座っている想定。
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

  // #660 (CodeRabbit follow-up): lastExitAt は #582 で先行導入済みだが
  // lastExitPrice は本フィールドの新規追加。そのため deploy 直前にガード窓内
  // (reentryGuardBusinessDays 未満) で exit した銘柄は、lastExitAt はあるのに
  // lastExitPrice が無い移行期の state になりうる。ここを fail-open (無条件
  // BUY 許可) にすると、まさにガードで守るべき窓内で無防備に買い直せてしまう
  // (SQQQ 事故と同型のリスク窓)。窓内なら価格不明でも entry を保留する
  // (fail-closed) べき。
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

  // 窓経過後は lastExitPrice が無くても自然に fail-open へ戻る (恒久 block ではない)。
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

  // #660: lastExitPrice が明示的に設定されていれば、それを基準にガードが発火
  // する — lastExecutedPrice の値は無視される (両者を意図的に食い違わせて確認)。
  it('drives the re-entry guard from lastExitPrice, ignoring a differing lastExecutedPrice', async () => {
    const explicitExitState: SymbolState = {
      ...emptySymbolState('SOXL', () => now),
      // lastExecutedPrice はガードに使われないダミー値 (無関係に高い値)。
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    // #intraday-only force-close signal (SELL) を経路として使う: decide() 自体は
    // cooldownUntil 未来だと HOLD を返すため、cooldown 中の SELL を作るには
    // decide() 後に override する既存経路 (intraday close) を借りる。
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    // vix_critical 起因の HOLD が混ざっていないこと (SELL 銘柄は VIX 無関係で通る)。
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
    // VIX (0.5x) を先に floor し、その結果へさらに news (0.5x) を floor する
    // 逐次適用 (既存 half-entry × VIX と同じ流儀)。0.5 × 0.5 = 0.25 相当。
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
    // binding gate (news) の reason が出て、vix の reason は出ない。
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
    const reject = summary.decisions.find((d) => d.decision === 'SKIP')
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
    expect(reject?.decision).toBe('SKIP')
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
    // 再エントリーガードも既存 scheduler テストでは無効化 (0)。plumbing 検証は専用ケース。
    maxStopToTpRatio: 2.0,
    reentryMinAtrBelowLastExit: 0,
    reentryGuardBusinessDays: 0,
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
    expect(aapl?.decision).toBe('HOLD')
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
    const rejected = summary.decisions.filter((d) => d.decision === 'SKIP')
    expect(rejected.some((d) => /insufficient buying power/.test(d.reason ?? ''))).toBe(true)
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
    // role を後から cash_parking 等に変えた銘柄に保有が残っていても
    // stop / time-stop / TP の exit は従来どおり動く (fail-closed は entry 側のみ)。
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

// #658 実害回帰フィクスチャ: 2026-07-29 SQQQ 実害の再現用 bars。TEST_DEFAULT_RULE
// で評価すると price=47.1187 / atr20=2.35 (実測値と一致するよう bars を逆算)、
// pullback=-6.5% (pullbackMin=-0.06 の許容バンド [-0.072, -0.06) 内) のみが
// 未通過で、他の 6 gate は全通過 → deriveEntryStatusFromIndicators は
// status='HALF' / halfGate.key='pullback_deep' を返す (値は
// `pnpm exec vitest run` で実行確認済み、下記コメントに実測値を記載)。
//
// 旧実装 (scheduler が signal.action==='HOLD' のたびに指標から entry status を
// 再導出していた) は、この HALF 判定**だけ**を見て BUY 0.5x に昇格させていた。
// 実際には reentry guard (前回売値 45.8302 に対し price 47.1187 が高すぎる) が
// entryDecision の最初の早期 return で HOLD を確定させており、7 gate 集合に
// 存在しない再エントリーガードは再導出では検知できなかった。
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
  // uptrendBars() の pullback は (117.5-122)/122 ≈ -3.69%。pullbackMin を
  // -0.035 に絞ると pullback_deep だけが僅差で落ち (許容バンド -0.042 以内)、
  // HALF 候補になる。-0.025 ならバンド外 → WATCH (発注なし)。
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

  it('half entry still passes through downstream risk gates (inverse-pair exposure rejects)', async () => {
    // HALF でも逆ポジ保有中は発注しない (#452 safety)。perSymbolRisk の
    // inverse-pair gate が BUY intent を reject することを確認する。
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

  // #658 実害回帰 (2026-07-29 SQQQ): reentryHalfMissBars() は entry gate 視点で
  // 見れば HALF (pullback_deep 僅差) だが、reentry guard 由来の HOLD
  // (holdCause='guard') なので昇格しないこと。#660 で再エントリーガードの基準が
  // lastExitPrice (明示フィールド) に変わったので、それを設定して価格比較ガード
  // (47.1187 > 43.4802 = 45.8302 - 1*2.35) 本来の経路を通す (lastExecutedPrice
  // のままだと lastExitPrice===null の #660 移行期 fail-closed 経路に落ちてしまい、
  // 価格ガードそのものは検証できない)。
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
    // 前回売値 45.8302 由来の ceiling (= 45.8302 - 1*2.35 = 43.48, reason は
    // toFixed(2) 表示) が出ること = legacy fail-closed 経路 (#660) ではなく
    // 価格比較ガード本来の経路であること。
    expect(decision?.reason).toContain('45.8302')
    expect(decision?.reason).toContain('43.48')
    expect(decision?.trace?.map((s) => s.label)).toContain('entry.reentry_below_last_exit')
    expect(decision?.trace?.map((s) => s.label)).not.toContain('entry.half_status')
  })

  // #658: 再エントリーガードの窓 (既定 3 営業日) を過ぎれば guard は無効化され、
  // 同じ HALF 相当の gate 状況は通常どおり 0.5x に昇格する (= 昇格ロジック自体は
  // holdCause='entry_gate' の場合に生きていることの確認)。
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
    // downtrend 相当でも (= 通常なら HOLD でも) cash 銘柄は指定数量で BUY する。
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
    // avgPrice 200 vs uptrendBars last close 117.5 → deep loss, well past the
    // -4% stop → decide() returns SELL regardless of the rebalance map.
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
    // TEST_DEFAULT_RULE.reentryGuardBusinessDays = 3。lastExitAt 1 business day
    // 前 (2026-04-17 金, now = 2026-04-20 月) → bd=1 < 3 → guard 有効、BUY なし。
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
})

describe('inverse_hedge role enabled but inverse-pair gate still wins (#457)', () => {
  it('role 有効化後も相手保有中の BUY は inverse-pair gate で reject', async () => {
    // #457 で inverse_hedge の entry 抑止は外れた (= buildEntrySuppressedSymbols
    // が空を返す) が、両建て防止 (inverse_pairs) は下流で引き続き効くこと。
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
    // time stop で SELL が出る保有を持たせ、SELL submit が deny で落ちても
    // hook は呼ばれない (= 銘柄は評価対象に残り、exit は次 tick で再試行)。
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
    // SOXL は保有中 → strategy の SELL (TP) がそのまま通る (unknown でも exit は妨げない)
    expect(summary.sells).toBe(1)
    // SOXS の BUY は unknown で block
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
