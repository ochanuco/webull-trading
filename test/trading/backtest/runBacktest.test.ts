import { describe, expect, it } from 'vitest'
import {
  computeMaxDrawdown,
  computeSharpe,
  runBacktest,
  type BacktestParams,
} from '../../../src/trading/backtest/runBacktest'
import type { DailyBar } from '../../../src/trading/strategy/indicators'
import { TEST_DEFAULT_RULE } from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

const BASE_PARAMS: BacktestParams = {
  symbol: 'TEST',
  from: '2025-01-01',
  to: '2025-12-31',
  initialCash: 10_000,
  rule: TEST_DEFAULT_RULE,
}

/**
 * Build a synthetic price series. Start at `start`, advance daily with the
 * supplied multipliers (close = previous close * factor). High/low are close
 * ±0.001% so ATR stays small but non-zero.
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

/**
 * 50+ warmup bars at constant ~+1%/d so the trend filter clears.
 * #318 で return lookback は 20d に短縮されたが、+1%/d × 20d ≈ +22% > +8% で
 * 引き続き trend filter を通過する。
 */
function uptrendWarmup(start: number): DailyBar[] {
  return buildBars(start, Array(60).fill(1.01))
}

describe('runBacktest', () => {
  it('returns an empty result for empty bars', async () => {
    const result = await runBacktest([], BASE_PARAMS)
    expect(result.trades).toEqual([])
    expect(result.totalPnl).toBe(0)
    expect(result.totalReturn).toBe(0)
    expect(result.equityCurve).toEqual([])
    expect(result.totalTrades).toBe(0)
  })

  it('produces no trades when bars are pure downtrend (no BUY signal)', async () => {
    // Constant 1% daily decline → trend return < 0 → entry.trend_50d_return fails → HOLD.
    // (trace 識別子 `entry.trend_50d_return` は #318 後も historical 維持、実 lookback は 20d。)
    const bars = buildBars(100, Array(120).fill(0.99))
    const result = await runBacktest(bars, BASE_PARAMS)
    expect(result.totalTrades).toBe(0)
    expect(result.totalPnl).toBe(0)
    // Equity should stay at initialCash because no position is ever opened.
    expect(result.equityCurve.at(-1)?.equity).toBe(BASE_PARAMS.initialCash)
  })

  it('opens a position then closes via take-profit on a deep pullback + recovery', async () => {
    // 60-day uptrend warmup, then a single ~-5% pullback day, then strong rally.
    const warmup = buildBars(100, Array(60).fill(1.01))
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95, // -5% pullback to trigger BUY (in [-6%, -3%])
    }
    // After BUY, simulate a +10% recovery over the next few days to trigger TP (>=7%).
    const rally = buildBars(pullbackDay.close, [1.04, 1.04, 1.04], '2025-04-02')
    const bars = [...warmup, pullbackDay, ...rally]
    const result = await runBacktest(bars, BASE_PARAMS)
    expect(result.totalTrades).toBeGreaterThanOrEqual(1)
    const first = result.trades[0]!
    expect(first.exitReason === 'TP' || first.exitReason === 'END_OF_DATA').toBe(true)
  })

  it('records STOP exit when price drops past stopPct after entry', async () => {
    const warmup = buildBars(100, Array(60).fill(1.01))
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    // Sharp -10% drop after entry to hit stopPct=-0.04.
    const drop = buildBars(pullbackDay.close, [0.9, 0.95], '2025-04-02')
    const bars = [...warmup, pullbackDay, ...drop]
    const result = await runBacktest(bars, BASE_PARAMS)
    expect(result.totalTrades).toBeGreaterThanOrEqual(1)
    const first = result.trades[0]!
    expect(first.exitReason).toBe('STOP')
    expect(first.realizedPnl).toBeLessThan(0)
  })

  it('forces END_OF_DATA exit when position is still open at the last bar', async () => {
    const warmup = buildBars(100, Array(60).fill(1.01))
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    // After entry, hold flat (~+0.5% drift) so neither TP nor STOP fires before
    // we run out of bars. timeStopDays=10 default is also avoided by a short
    // tail.
    const flat = buildBars(pullbackDay.close, [1.005, 1.005, 1.005], '2025-04-02')
    const bars = [...warmup, pullbackDay, ...flat]
    const result = await runBacktest(bars, BASE_PARAMS)
    expect(result.totalTrades).toBeGreaterThanOrEqual(1)
    expect(result.trades.at(-1)?.exitReason).toBe('END_OF_DATA')
  })

  it('totalPnl matches sum of trade pnls and equity ends at initialCash + totalPnl', async () => {
    const warmup = buildBars(100, Array(60).fill(1.01))
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const rally = buildBars(pullbackDay.close, [1.04, 1.04, 1.04], '2025-04-02')
    const bars = [...warmup, pullbackDay, ...rally]
    const result = await runBacktest(bars, BASE_PARAMS)
    const sum = result.trades.reduce((acc, t) => acc + t.realizedPnl, 0)
    expect(result.totalPnl).toBeCloseTo(sum, 6)
    // After all trades closed, ending equity should be roughly initialCash + totalPnl.
    expect(result.equityCurve.at(-1)?.equity).toBeCloseTo(
      BASE_PARAMS.initialCash + result.totalPnl,
      4,
    )
  })

  it('respects a SHORT timeStopDays rule by exiting via TIME_STOP', async () => {
    const warmup = buildBars(100, Array(60).fill(1.01))
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    // Hold flat for many bars so neither TP nor STOP fires. Use a very small
    // timeStopDays=2 so TIME_STOP triggers before END_OF_DATA.
    const flat = buildBars(pullbackDay.close, Array(15).fill(1.001), '2025-04-02')
    const bars = [...warmup, pullbackDay, ...flat]
    const result = await runBacktest(bars, {
      ...BASE_PARAMS,
      rule: { ...TEST_DEFAULT_RULE, timeStopDays: 2 },
    })
    expect(result.totalTrades).toBeGreaterThanOrEqual(1)
    const reasons = result.trades.map((t) => t.exitReason)
    expect(reasons.some((r) => r === 'TIME_STOP')).toBe(true)
  })
})

describe('computeSharpe', () => {
  it('returns 0 for empty input', () => {
    expect(computeSharpe([])).toBe(0)
  })

  it('returns 0 for a single return (under-defined)', () => {
    expect(computeSharpe([0.01])).toBe(0)
  })

  it('returns 0 when stdev is 0 (all returns identical)', () => {
    expect(computeSharpe([0.01, 0.01, 0.01, 0.01])).toBe(0)
  })

  it('returns positive for a positive mean / non-zero variance', () => {
    // Simulate ~+0.1%/d ± noise.
    const returns = [0.001, 0.002, 0.0005, 0.0015, 0.001, 0.0005, 0.0012]
    const sharpe = computeSharpe(returns)
    expect(sharpe).toBeGreaterThan(0)
    expect(Number.isFinite(sharpe)).toBe(true)
  })

  it('returns negative for a negative mean', () => {
    const returns = [-0.001, -0.002, -0.0005, -0.0015, -0.001]
    expect(computeSharpe(returns)).toBeLessThan(0)
  })
})

describe('computeMaxDrawdown', () => {
  it('returns zeros for empty input', () => {
    expect(computeMaxDrawdown([])).toEqual({ maxDd: 0, maxDdPct: 0 })
  })

  it('returns zeros for a strictly increasing series', () => {
    expect(computeMaxDrawdown([1, 2, 3, 4, 5])).toEqual({ maxDd: 0, maxDdPct: 0 })
  })

  it('captures the deepest peak-to-trough drop', () => {
    const r = computeMaxDrawdown([100, 120, 90, 110, 80, 130])
    // Peak 120 → trough 80 = -40 = -33.3%.
    expect(r.maxDd).toBe(-40)
    expect(r.maxDdPct).toBeCloseTo(-40 / 120, 6)
  })

  it('only counts the worst drawdown, not the cumulative', () => {
    const r = computeMaxDrawdown([100, 90, 110, 80, 120])
    // Worst is 110 → 80 = -30 (not 100→90 = -10).
    expect(r.maxDd).toBe(-30)
    expect(r.maxDdPct).toBeCloseTo(-30 / 110, 6)
  })
})
