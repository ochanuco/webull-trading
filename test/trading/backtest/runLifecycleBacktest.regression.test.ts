import { describe, expect, it } from 'vitest'
import { runBacktest, type BacktestParams } from '../../../src/trading/backtest/runBacktest'
import {
  runLifecycleBacktest,
  type LifecycleBacktestParams,
} from '../../../src/trading/backtest/runLifecycleBacktest'
import type { DailyBar } from '../../../src/trading/strategy/indicators'
import { TEST_DEFAULT_RULE } from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

/**
 * Regression guarantee (issue #709 Phase 3): `runLifecycleBacktest` with
 * `entryPolicy: {kind: 'full'}` and zero fees must reproduce `runBacktest`
 * trade-for-trade and PnL-for-PnL against identical bars/rule. A mismatch
 * here means the lifecycle harness's entry/exit replication has drifted from
 * `PullbackUptrendStrategy` — fix the harness, never the strategy.
 */

function buildBars(start: number, factors: number[], startDate = '2025-01-01'): DailyBar[] {
  const bars: DailyBar[] = []
  let close = start
  let date = new Date(`${startDate}T00:00:00.000Z`)
  for (let i = 0; i < factors.length; i += 1) {
    close = close * factors[i]!
    bars.push({
      date: date.toISOString().slice(0, 10),
      open: close * 0.999,
      high: close * 1.001,
      low: close * 0.998,
      close,
    })
    date = new Date(date.getTime() + 86_400_000)
  }
  return bars
}

function uptrendWarmup(start: number): DailyBar[] {
  return buildBars(start, Array(60).fill(1.01))
}

const BASE_BACKTEST_PARAMS: BacktestParams = {
  symbol: 'TEST',
  from: '2025-01-01',
  to: '2025-12-31',
  initialCash: 10_000,
  rule: TEST_DEFAULT_RULE,
}

function fullPolicyParams(): LifecycleBacktestParams {
  return {
    symbol: BASE_BACKTEST_PARAMS.symbol,
    from: BASE_BACKTEST_PARAMS.from,
    to: BASE_BACKTEST_PARAMS.to,
    initialCash: BASE_BACKTEST_PARAMS.initialCash,
    rule: TEST_DEFAULT_RULE,
    entryPolicy: { kind: 'full' },
    feePctOfNotional: 0,
    feeFixedPerOrder: 0,
  }
}

async function assertParity(bars: DailyBar[]): Promise<void> {
  const legacy = await runBacktest(bars, BASE_BACKTEST_PARAMS)
  const lifecycle = await runLifecycleBacktest(bars, fullPolicyParams())

  expect(lifecycle.totalTrades).toBe(legacy.totalTrades)
  expect(lifecycle.trades).toHaveLength(legacy.trades.length)
  legacy.trades.forEach((legacyTrade, idx) => {
    const lifecycleTrade = lifecycle.trades[idx]!
    expect(lifecycleTrade.entryTimestamp).toBe(legacyTrade.entryTimestamp)
    expect(lifecycleTrade.exitTimestamp).toBe(legacyTrade.exitTimestamp)
    expect(lifecycleTrade.entryPrice).toBeCloseTo(legacyTrade.entryPrice, 9)
    expect(lifecycleTrade.exitPrice).toBeCloseTo(legacyTrade.exitPrice, 9)
    expect(lifecycleTrade.qty).toBe(legacyTrade.qty)
    expect(lifecycleTrade.realizedPnl).toBeCloseTo(legacyTrade.realizedPnl, 9)
    expect(lifecycleTrade.exitReason).toBe(legacyTrade.exitReason)
    expect(lifecycleTrade.holdingDays).toBe(legacyTrade.holdingDays)
    // The one-shot entry policy should always fill in a single 'full' leg.
    expect(lifecycleTrade.entryLegs).toHaveLength(1)
    expect(lifecycleTrade.entryLegs[0]!.label).toBe('full')
  })
  expect(lifecycle.totalPnl).toBeCloseTo(legacy.totalPnl, 9)
}

describe('runLifecycleBacktest regression parity (full entry policy, fee=0)', () => {
  it('matches runBacktest on empty bars', async () => {
    await assertParity([])
  })

  it('matches runBacktest on a pure downtrend (no BUY signal)', async () => {
    await assertParity(buildBars(100, Array(120).fill(0.99)))
  })

  it('matches runBacktest: pullback entry then TP exit on recovery', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const rally = buildBars(pullbackDay.close, [1.04, 1.04, 1.04], '2025-04-02')
    await assertParity([...warmup, pullbackDay, ...rally])
  })

  it('matches runBacktest: pullback entry then STOP exit on a sharp drop', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const drop = buildBars(pullbackDay.close, [0.9, 0.95], '2025-04-02')
    await assertParity([...warmup, pullbackDay, ...drop])
  })

  it('matches runBacktest: TIME_STOP exit under a short timeStopDays rule', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const flat = buildBars(pullbackDay.close, Array(15).fill(1.001), '2025-04-02')
    const bars = [...warmup, pullbackDay, ...flat]

    const shortTimeStopRule = { ...TEST_DEFAULT_RULE, timeStopDays: 2 }
    const legacy = await runBacktest(bars, { ...BASE_BACKTEST_PARAMS, rule: shortTimeStopRule })
    const lifecycle = await runLifecycleBacktest(bars, {
      ...fullPolicyParams(),
      rule: shortTimeStopRule,
    })
    expect(lifecycle.totalTrades).toBe(legacy.totalTrades)
    expect(legacy.trades.some((t) => t.exitReason === 'TIME_STOP')).toBe(true)
    legacy.trades.forEach((legacyTrade, idx) => {
      expect(lifecycle.trades[idx]!.exitReason).toBe(legacyTrade.exitReason)
      expect(lifecycle.trades[idx]!.realizedPnl).toBeCloseTo(legacyTrade.realizedPnl, 9)
    })
  })

  it('matches runBacktest: forced END_OF_DATA close on a still-open position', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const flat = buildBars(pullbackDay.close, [1.005, 1.005, 1.005], '2025-04-02')
    await assertParity([...warmup, pullbackDay, ...flat])
  })
})
