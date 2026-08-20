import { describe, expect, it } from 'vitest'
import {
  runLifecycleBacktest,
  type EntryPolicy,
  type LifecycleBacktestParams,
} from '../../../src/trading/backtest/runLifecycleBacktest'
import type { DailyBar } from '../../../src/trading/strategy/indicators'
import { TEST_DEFAULT_RULE } from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

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

/**
 * A gentle multi-day decline (-0.5%/day) off the warmup peak. Empirically
 * (verified against `computeEntryDistance` directly): 2025-04-01..04-05 are
 * probe-eligible (setup intact, pullback not yet in the [-6%,-3%] band),
 * 04-06/04-07 cross into the band (full-eligible), 04-08+ the trend gate
 * itself fails (20d return decays below the 8% floor).
 */
function gentleDecline(fromClose: number): DailyBar[] {
  return buildBars(fromClose, Array(10).fill(0.995), '2025-04-01')
}

const STAGED_POLICY: EntryPolicy = {
  kind: 'staged',
  fractions: { probe: 0.25, confirm: 0.25, full: 0.5 },
  confirmDays: 3,
}

function baseParams(entryPolicy: EntryPolicy, overrides?: Partial<LifecycleBacktestParams>): LifecycleBacktestParams {
  return {
    symbol: 'TEST',
    from: '2025-01-01',
    to: '2025-12-31',
    initialCash: 10_000,
    rule: TEST_DEFAULT_RULE,
    entryPolicy,
    feePctOfNotional: 0,
    feeFixedPerOrder: 0,
    ...overrides,
  }
}

describe('runLifecycleBacktest — staged entry state machine', () => {
  it('fills probe, then confirm after confirmDays streak, then the full remainder on the first fullEligible bar', async () => {
    const warmup = uptrendWarmup(100)
    const decline = gentleDecline(warmup[warmup.length - 1]!.close)
    const bars = [...warmup, ...decline]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    expect(result.trades).toHaveLength(1)
    const legs = result.trades[0]!.entryLegs
    expect(legs.map((l) => l.label)).toEqual(['probe', 'confirm', 'full'])
    expect(legs[0]!.date).toBe('2025-04-01')
    expect(legs[1]!.date).toBe('2025-04-03') // streak: 04-01=1, 04-02=2, 04-03=3 >= confirmDays
    expect(legs[2]!.date).toBe('2025-04-06') // first fullEligible bar
    expect(legs[0]!.fraction).toBeCloseTo(0.25, 9)
    expect(legs[1]!.fraction).toBeCloseTo(0.25, 9)
    expect(legs[2]!.fraction).toBeCloseTo(0.5, 9)
    // avgPrice is the qty-weighted mean of the three legs.
    const totalQty = legs.reduce((s, l) => s + l.qty, 0)
    const weighted = legs.reduce((s, l) => s + l.qty * l.price, 0) / totalQty
    expect(result.trades[0]!.entryPrice).toBeCloseTo(weighted, 6)
    expect(result.trades[0]!.qty).toBe(totalQty)
  })

  it('invests all fractions at once when the pullback arrives before any probe (fullEligible from flat)', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const tail = buildBars(pullbackDay.close, [1.001, 1.001], '2025-04-02')
    const bars = [...warmup, pullbackDay, ...tail]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    expect(result.trades).toHaveLength(1)
    const legs = result.trades[0]!.entryLegs
    expect(legs).toHaveLength(1)
    expect(legs[0]!.label).toBe('full')
    expect(legs[0]!.fraction).toBeCloseTo(1, 9)
    expect(legs[0]!.date).toBe('2025-04-01')
  })

  it('stops out on the probe leg alone when price crashes before confirm fires', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const probeDay = buildBars(last, [0.995], '2025-04-01')
    const crash = buildBars(probeDay[0]!.close, [0.8], '2025-04-02')
    const bars = [...warmup, ...probeDay, ...crash]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.entryLegs).toHaveLength(1)
    expect(trade.entryLegs[0]!.label).toBe('probe')
    expect(trade.exitReason).toBe('STOP')
    expect(trade.realizedPnl).toBeLessThan(0)
  })

  it('exits via TP for the full staged position once pnl crosses takeProfitPct', async () => {
    const warmup = uptrendWarmup(100)
    const decline = gentleDecline(warmup[warmup.length - 1]!.close)
    const rally = buildBars(decline[decline.length - 1]!.close, [1.03, 1.03, 1.03, 1.03], '2025-04-11')
    const bars = [...warmup, ...decline, ...rally]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    expect(result.trades.length).toBeGreaterThanOrEqual(1)
    const first = result.trades[0]!
    expect(first.entryLegs.map((l) => l.label)).toEqual(['probe', 'confirm', 'full'])
    expect(first.exitReason).toBe('TP')
    expect(first.realizedPnl).toBeGreaterThan(0)
  })

  it('exits via TIME_STOP measured from the first (probe) entry date, not the last leg', async () => {
    const warmup = uptrendWarmup(100)
    const decline = gentleDecline(warmup[warmup.length - 1]!.close)
    const flat = buildBars(decline[decline.length - 1]!.close, Array(15).fill(1.0005), '2025-04-11')
    const bars = [...warmup, ...decline, ...flat]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.entryLegs[0]!.date).toBe('2025-04-01') // probe date anchors the time-stop clock
    expect(trade.exitReason).toBe('TIME_STOP')
  })

  it('charges fees on every leg fill and the exit, reducing cash/totalCost/realizedPnl vs. the fee=0 run', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const tail = buildBars(pullbackDay.close, [1.001, 1.001], '2025-04-02')
    const bars = [...warmup, pullbackDay, ...tail]

    const free = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))
    const feeConfig = { feePctOfNotional: 0.0022, feeFixedPerOrder: 1 }
    const withFee = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY, feeConfig))

    expect(withFee.totalCost).toBeGreaterThan(0)
    // One entry leg (BUY) + one exit (END_OF_DATA close) = 2 fee-bearing fills.
    const entryNotional = withFee.trades[0]!.entryLegs[0]!.qty * withFee.trades[0]!.entryLegs[0]!.price
    const exitNotional = withFee.trades[0]!.qty * withFee.trades[0]!.exitPrice
    const expectedCost =
      entryNotional * feeConfig.feePctOfNotional +
      feeConfig.feeFixedPerOrder +
      (exitNotional * feeConfig.feePctOfNotional + feeConfig.feeFixedPerOrder)
    expect(withFee.totalCost).toBeCloseTo(expectedCost, 6)
    expect(withFee.trades[0]!.cost).toBeCloseTo(expectedCost, 6)
    expect(withFee.totalPnl).toBeCloseTo(free.totalPnl - expectedCost, 6)
    // Net cash accounting: final equity should still reconcile to initialCash + totalPnl.
    expect(withFee.equityCurve.at(-1)?.equity).toBeCloseTo(
      withFee.params.initialCash + withFee.totalPnl,
      4,
    )
  })

  it('computes turnover as (all BUY leg + SELL notional) / initialCash', async () => {
    const warmup = uptrendWarmup(100)
    const decline = gentleDecline(warmup[warmup.length - 1]!.close)
    const bars = [...warmup, ...decline]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    let notional = 0
    for (const t of result.trades) {
      for (const leg of t.entryLegs) notional += leg.qty * leg.price
      notional += t.qty * t.exitPrice
    }
    expect(result.turnover).toBeCloseTo(notional / result.params.initialCash, 9)
  })

  it('computes cagr from totalReturn annualized over the post-warmup bar count', async () => {
    const warmup = uptrendWarmup(100)
    const decline = gentleDecline(warmup[warmup.length - 1]!.close)
    const bars = [...warmup, ...decline]
    const result = await runLifecycleBacktest(bars, baseParams(STAGED_POLICY))

    const liveBarCount = bars.length - 60
    const expected = (1 + result.totalReturn) ** (252 / liveBarCount) - 1
    expect(result.cagr).toBeCloseTo(expected, 9)
  })

  it('returns cagr=0 for empty bars', async () => {
    const result = await runLifecycleBacktest([], baseParams(STAGED_POLICY))
    expect(result.cagr).toBe(0)
    expect(result.trades).toEqual([])
  })
})
