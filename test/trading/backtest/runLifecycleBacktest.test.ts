import { describe, expect, it } from 'vitest'
import {
  evaluateReentry,
  nextStagedEntryStep,
  runLifecycleBacktest,
  type EntryPolicy,
  type ExitPolicy,
  type LifecycleBacktestParams,
  type ReentryEvalInput,
  type StagedEntryStepState,
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

/**
 * `partial-trailing` ExitPolicy (issue #709 Phase 4). All cases use `entryPolicy: {kind:'full'}`
 * so `entryPrice` is a single fill and pnl% math is easy to hand-check; the `preset` exit engine
 * is unaffected by any of this (proven separately by the untouched Phase 3 regression suite).
 */
describe('runLifecycleBacktest — partial-trailing exit policy (#709 Phase 4)', () => {
  const PARTIAL_TRAILING: ExitPolicy = {
    kind: 'partial-trailing',
    tpFraction: 0.5,
    trailKAtr: 2,
    timeStopExtensionDays: 0,
  }

  function fullEntryPullbackBars(rallyFactors: number[], tailFactors: number[] = []): {
    bars: DailyBar[]
    pullbackDay: DailyBar
  } {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const rally = buildBars(pullbackDay.close, rallyFactors, '2025-04-02')
    const tail =
      tailFactors.length > 0
        ? buildBars(rally[rally.length - 1]!.close, tailFactors, '2025-04-07')
        : []
    return { bars: [...warmup, pullbackDay, ...rally, ...tail], pullbackDay }
  }

  it('sells floor(qty * tpFraction) on the TP bar, keeps the residual open, and books entry/exit cash+cost correctly', async () => {
    const { bars } = fullEntryPullbackBars([1.04, 1.04, 1.04])
    const feeConfig = { feePctOfNotional: 0.001, feeFixedPerOrder: 0.5 }
    const result = await runLifecycleBacktest(bars, {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: TEST_DEFAULT_RULE,
      entryPolicy: { kind: 'full' },
      exitPolicy: PARTIAL_TRAILING,
      ...feeConfig,
    })

    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    const fullQty = trade.entryLegs[0]!.qty
    expect(trade.exitLegs.map((l) => l.label)).toEqual(['partial_tp', 'final'])
    const [partialLeg, finalLeg] = trade.exitLegs as [
      (typeof trade.exitLegs)[0],
      (typeof trade.exitLegs)[1],
    ]
    expect(partialLeg.qty).toBe(Math.floor(fullQty * 0.5))
    expect(finalLeg.qty).toBe(fullQty - partialLeg.qty)
    expect(trade.qty).toBe(fullQty)
    // exitPrice is the qty-weighted average across both exit legs, not either leg's own price.
    const weightedExit =
      (partialLeg.qty * partialLeg.price + finalLeg.qty * finalLeg.price) / trade.qty
    expect(trade.exitPrice).toBeCloseTo(weightedExit, 9)

    const entryLeg = trade.entryLegs[0]!
    const expectedEntryCost =
      entryLeg.qty * entryLeg.price * feeConfig.feePctOfNotional + feeConfig.feeFixedPerOrder
    const expectedPartialCost =
      partialLeg.qty * partialLeg.price * feeConfig.feePctOfNotional + feeConfig.feeFixedPerOrder
    const expectedFinalCost =
      finalLeg.qty * finalLeg.price * feeConfig.feePctOfNotional + feeConfig.feeFixedPerOrder
    expect(entryLeg.cost).toBeCloseTo(expectedEntryCost, 9)
    expect(partialLeg.cost).toBeCloseTo(expectedPartialCost, 9)
    expect(finalLeg.cost).toBeCloseTo(expectedFinalCost, 9)
    expect(result.totalCost).toBeCloseTo(expectedEntryCost + expectedPartialCost + expectedFinalCost, 6)
    // Cash conservation: ending equity always reconciles to initialCash + totalPnl regardless of
    // how many legs the round trip took to close.
    expect(result.equityCurve.at(-1)?.equity).toBeCloseTo(result.params.initialCash + result.totalPnl, 4)
  })

  it('falls back to a full TP exit (single "final" leg) when the tpFraction floor leaves no residual', async () => {
    const { bars } = fullEntryPullbackBars([1.04, 1.04, 1.04])
    // initialCash sized so the entry fills exactly 1 share — floor(1 * 0.5) = 0, so the partial
    // sale would be a 0-share leg; the engine must fall back to a full TP close instead.
    const result = await runLifecycleBacktest(bars, {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 200,
      rule: TEST_DEFAULT_RULE,
      entryPolicy: { kind: 'full' },
      exitPolicy: PARTIAL_TRAILING,
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    })

    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.entryLegs[0]!.qty).toBe(1)
    expect(trade.exitReason).toBe('TP')
    expect(trade.exitLegs.map((l) => l.label)).toEqual(['final'])
    expect(trade.qty).toBe(1)
  })

  it('arms the ATR trailing stop only after a partial TP, and exits the residual once close breaks the trail', async () => {
    const { bars } = fullEntryPullbackBars([1.04, 1.04, 1.04, 1.03, 1.03], [0.9])
    const result = await runLifecycleBacktest(bars, {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: TEST_DEFAULT_RULE,
      entryPolicy: { kind: 'full' },
      exitPolicy: { ...PARTIAL_TRAILING, trailKAtr: 1.5 },
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    })

    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.exitReason).toBe('TRAIL')
    expect(trade.exitLegs.map((l) => l.label)).toEqual(['partial_tp', 'final'])
    // The trail exit still nets a profit — the residual rode a big chunk of the rally before
    // giving it back, it wasn't stopped out at a loss.
    expect(trade.realizedPnl).toBeGreaterThan(0)
  })

  it('still applies the hard stop (avgPrice basis) to the residual after a partial TP, even though a smaller drop would also breach the trail', async () => {
    const { bars } = fullEntryPullbackBars([1.04, 1.04, 1.04], [0.75])
    const result = await runLifecycleBacktest(bars, {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: TEST_DEFAULT_RULE,
      entryPolicy: { kind: 'full' },
      exitPolicy: PARTIAL_TRAILING,
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    })

    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.exitReason).toBe('STOP')
    expect(trade.exitLegs.map((l) => l.label)).toEqual(['partial_tp', 'final'])
    // A crash steep enough to blow through the hard stop wipes out the gain the partial TP
    // locked in — net pnl goes negative even though the first leg sold at a profit.
    expect(trade.realizedPnl).toBeLessThan(0)
  })

  function timeStopExtensionBars(contDays: number): DailyBar[] {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    // A mild +0.3%/day continuation (not a sharp rally, not a decline): keeps pnl well under TP
    // and the hard-stop distance the whole window, so time-stop is the only thing that can fire.
    // Empirically (verified directly against `computeEntryDistance`): the trend gate chain holds
    // through business-day 5 (2025-04-08) and has failed (trend gate) by business-day 6
    // (2025-04-09) — chosen so one scenario's extended deadline lands inside the "still holds"
    // window and the other's original deadline lands after the gate has already failed.
    const cont = buildBars(pullbackDay.close, Array(contDays).fill(1.003), '2025-04-02')
    return [...warmup, pullbackDay, ...cont]
  }

  it('extends the time-stop deadline once while the trend gate chain still holds, then force-exits at the extended deadline', async () => {
    const bars = timeStopExtensionBars(7) // ends exactly at business-day 5 (2025-04-08)
    const result = await runLifecycleBacktest(bars, {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: { ...TEST_DEFAULT_RULE, timeStopDays: 2 },
      entryPolicy: { kind: 'full' },
      exitPolicy: { ...PARTIAL_TRAILING, timeStopExtensionDays: 3 },
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    })

    // Without the extension this would have closed on 2025-04-03 (business-day 2). Closing on
    // 2025-04-08 instead (business-day 5 = 2 + 3) proves the one-shot extension fired — and since
    // the trend gate chain is still intact on 2025-04-08 (see `timeStopExtensionBars`), the exit
    // there also proves the extension is a hard cap, not something that re-extends indefinitely
    // while the trend keeps holding.
    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.exitReason).toBe('TIME_STOP')
    expect(trade.exitTimestamp.slice(0, 10)).toBe('2025-04-08')
  })

  it('does not extend the time-stop when the trend gate chain has already failed by the original deadline', async () => {
    const bars = timeStopExtensionBars(8) // ends exactly at business-day 6 (2025-04-09)
    const result = await runLifecycleBacktest(bars, {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: { ...TEST_DEFAULT_RULE, timeStopDays: 6 },
      entryPolicy: { kind: 'full' },
      exitPolicy: { ...PARTIAL_TRAILING, timeStopExtensionDays: 3 },
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    })

    // The trend gate has already failed by business-day 6 (2025-04-09, see
    // `timeStopExtensionBars`), so the extension condition never fires — the exit lands on the
    // *original* deadline (2025-04-09), not the would-be-extended 2025-04-14.
    expect(result.trades).toHaveLength(1)
    const trade = result.trades[0]!
    expect(trade.exitReason).toBe('TIME_STOP')
    expect(trade.exitTimestamp.slice(0, 10)).toBe('2025-04-09')
  })

  it('preset exitPolicy (default when omitted) is unaffected by the partial-trailing engine', async () => {
    const { bars } = fullEntryPullbackBars([1.04, 1.04, 1.04])
    const withoutExitPolicy: LifecycleBacktestParams = {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: TEST_DEFAULT_RULE,
      entryPolicy: { kind: 'full' },
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    }
    const explicitPreset: LifecycleBacktestParams = {
      ...withoutExitPolicy,
      exitPolicy: { kind: 'preset' },
    }
    const [implicit, explicit] = await Promise.all([
      runLifecycleBacktest(bars, withoutExitPolicy),
      runLifecycleBacktest(bars, explicitPreset),
    ])

    expect(implicit.trades).toHaveLength(1)
    // preset always closes in one leg — no partial_tp, whole qty at once.
    expect(implicit.trades[0]!.exitLegs.map((l) => l.label)).toEqual(['final'])
    expect(implicit.trades[0]!.exitReason).toBe('TP')
    expect(implicit.totalPnl).toBeCloseTo(explicit.totalPnl, 9)
    expect(implicit.trades[0]!.qty).toBe(explicit.trades[0]!.qty)
  })
})
describe('nextStagedEntryStep (#713 review)', () => {
  const policy = STAGED_POLICY as Extract<EntryPolicy, { kind: 'staged' }>
  const holding = (probeStreak: number, hasConfirmLeg = false): StagedEntryStepState => ({
    hasConfirmLeg,
    probeStreak,
    remainingFraction: 0.75,
  })

  it('resets the probe streak when eligibility breaks before the confirm leg', () => {
    // probe 2 日目 (streak 2) → 途切れ bar → streak 0 に戻る
    const broken = nextStagedEntryStep(holding(2), { fullEligible: false, probeEligible: false }, policy)
    expect(broken).toEqual({ action: 'none', probeStreak: 0 })
    // その後 eligible が再開しても、連続 3 bar 目まで confirm は出ない
    const s1 = nextStagedEntryStep(holding(0), { fullEligible: false, probeEligible: true }, policy)
    expect(s1).toEqual({ action: 'none', probeStreak: 1 })
    const s2 = nextStagedEntryStep(holding(1), { fullEligible: false, probeEligible: true }, policy)
    expect(s2).toEqual({ action: 'none', probeStreak: 2 })
    const s3 = nextStagedEntryStep(holding(2), { fullEligible: false, probeEligible: true }, policy)
    expect(s3).toEqual({ action: 'fill_confirm', probeStreak: 3 })
  })

  it('keeps streak untouched after the confirm leg and when fully invested', () => {
    const afterConfirm = nextStagedEntryStep(holding(3, true), { fullEligible: false, probeEligible: false }, policy)
    expect(afterConfirm).toEqual({ action: 'none', probeStreak: 3 })
    const full = nextStagedEntryStep(
      { hasConfirmLeg: true, probeStreak: 3, remainingFraction: 0 },
      { fullEligible: true, probeEligible: false },
      policy,
    )
    expect(full).toEqual({ action: 'none', probeStreak: 3 })
  })
})

describe('fee-inclusive cash clamp (#713 review)', () => {
  it('never lets cash go negative when a fixed fee rides on a cash-clamped fill', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const result = await runLifecycleBacktest(
      [...warmup, pullbackDay],
      baseParams({ kind: 'full' }, { feeFixedPerOrder: 50, feePctOfNotional: 0.01 }),
    )
    // fill が起きたかに関わらず equity 曲線に負の cash が現れないこと
    for (const p of result.equityCurve) {
      expect(p.equity).toBeGreaterThanOrEqual(0)
    }
    expect(result.totalCost).toBeGreaterThanOrEqual(0)
  })
})

describe('staged entry × partial-trailing interaction', () => {
  it('freezes entry-leg additions once a partial TP has fired on the round trip', async () => {
    // probe/confirm (0.5 投入) → rally で partial TP → 再度押し目圏に入っても
    // 残り fraction の追加建てをしないこと。trail/hard-stop/time-stop を遠ざけて
    // 「open のまま押し目再来」を作る。
    const warmup = uptrendWarmup(100)
    const decline = gentleDecline(warmup[warmup.length - 1]!.close)
    const probePhase = decline.slice(0, 4) // 04-01..04-04: probe→confirm (streak 3)
    const rally = buildBars(probePhase[probePhase.length - 1]!.close, [1.03, 1.03, 1.03], '2025-04-05')
    const pullback2 = buildBars(rally[rally.length - 1]!.close, Array(6).fill(0.99), '2025-04-08')
    const bars = [...warmup, ...probePhase, ...rally, ...pullback2]
    const result = await runLifecycleBacktest(bars, {
      ...baseParams(STAGED_POLICY),
      rule: { ...TEST_DEFAULT_RULE, timeStopDays: 60 },
      exitPolicy: { kind: 'partial-trailing', tpFraction: 0.5, trailKAtr: 10, timeStopExtensionDays: 0 },
    })

    expect(result.trades.length).toBeGreaterThanOrEqual(1)
    const trade = result.trades[0]!
    const partial = trade.exitLegs.find((l) => l.label === 'partial_tp')
    expect(partial).toBeDefined()
    // entry leg は partial TP の日以降に 1 本も増えていない
    for (const leg of trade.entryLegs) {
      expect(leg.date <= partial!.date).toBe(true)
    }
    expect(trade.entryLegs.map((l) => l.label)).not.toContain('full')
  })
})

/**
 * `evaluateReentry` (issue #709 Phase 5). `TEST_DEFAULT_RULE` sets
 * `reentryMinAtrBelowLastExit: 1.0` / `reentryGuardBusinessDays: 3`, matched against
 * `businessDaysBetween` directly-verified date pairs (2025-04-08 is a Tuesday: 1 business day to
 * 04-09, 3 to 04-11, 4 to 04-14, 5 to 04-15).
 */
describe('evaluateReentry (#709 Phase 5)', () => {
  const rule = TEST_DEFAULT_RULE

  function input(overrides: Partial<ReentryEvalInput>): ReentryEvalInput {
    return {
      policy: { kind: 'none' },
      lastExit: null,
      todayYmd: '2025-04-09',
      price: 100,
      atr20: 2,
      rule,
      trendContinues: true,
      entryPolicyKind: 'full',
      ...overrides,
    }
  }

  it("'none' always allows, even with a recent bad exit", () => {
    const result = evaluateReentry(
      input({
        policy: { kind: 'none' },
        lastExit: { price: 100, dateYmd: '2025-04-08', reason: 'STOP' },
        price: 500,
        trendContinues: false,
      }),
    )
    expect(result).toEqual({ allowed: true, probeOnly: false })
  })

  it('no prior exit always allows, regardless of policy', () => {
    const result = evaluateReentry(
      input({ policy: { kind: 'reason-aware', slWaitDays: 30 }, lastExit: null }),
    )
    expect(result).toEqual({ allowed: true, probeOnly: false })
  })

  describe('price-guard', () => {
    const lastExit = { price: 100, dateYmd: '2025-04-08', reason: 'TP' as const }

    it('blocks within the guard window when price is above the ceiling (last exit - 1*atr20)', () => {
      const result = evaluateReentry(
        input({ policy: { kind: 'price-guard' }, lastExit, todayYmd: '2025-04-09', price: 99, atr20: 2 }),
      )
      expect(result).toEqual({ allowed: false, probeOnly: false })
    })

    it('allows within the guard window once price reaches the ceiling', () => {
      const result = evaluateReentry(
        input({ policy: { kind: 'price-guard' }, lastExit, todayYmd: '2025-04-09', price: 98, atr20: 2 }),
      )
      expect(result).toEqual({ allowed: true, probeOnly: false })
    })

    it('allows unconditionally once the guard window (businessDaysBetween >= reentryGuardBusinessDays) has passed', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'price-guard' },
          lastExit,
          todayYmd: '2025-04-11', // 3 business days since 04-08 == reentryGuardBusinessDays
          price: 150, // well above the ceiling — would block if the window were still active
          atr20: 2,
        }),
      )
      expect(result).toEqual({ allowed: true, probeOnly: false })
    })
  })

  describe("'reason-aware' — STOP", () => {
    it('blocks unconditionally while businessDays < slWaitDays, even if trend has recaptured', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit: { price: 100, dateYmd: '2025-04-08', reason: 'STOP' },
          todayYmd: '2025-04-14', // 4 business days < slWaitDays 5
          trendContinues: true,
        }),
      )
      expect(result).toEqual({ allowed: false, probeOnly: false })
    })

    it('blocks past the wait window if the trend has not recaptured', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit: { price: 100, dateYmd: '2025-04-08', reason: 'STOP' },
          todayYmd: '2025-04-15', // 5 business days >= slWaitDays 5
          trendContinues: false,
        }),
      )
      expect(result).toEqual({ allowed: false, probeOnly: false })
    })

    it('allows past the wait window once the trend gate chain has recaptured', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit: { price: 100, dateYmd: '2025-04-08', reason: 'STOP' },
          todayYmd: '2025-04-15', // 5 business days >= slWaitDays 5
          trendContinues: true,
        }),
      )
      expect(result).toEqual({ allowed: true, probeOnly: false })
    })
  })

  describe("'reason-aware' — TP / TRAIL", () => {
    it('applies the same price-guard ceiling as the guard-only policy', () => {
      const lastExit = { price: 100, dateYmd: '2025-04-08', reason: 'TP' as const }
      const blocked = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit,
          todayYmd: '2025-04-09',
          price: 99,
          atr20: 2,
        }),
      )
      expect(blocked).toEqual({ allowed: false, probeOnly: false })

      const allowedByPrice = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit: { ...lastExit, reason: 'TRAIL' },
          todayYmd: '2025-04-09',
          price: 98,
          atr20: 2,
        }),
      )
      expect(allowedByPrice).toEqual({ allowed: true, probeOnly: false })
    })
  })

  describe("'reason-aware' — TIME_STOP", () => {
    const lastExit = { price: 100, dateYmd: '2025-04-08', reason: 'TIME_STOP' as const }

    it('blocks when the trend gate chain has not recaptured', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit,
          trendContinues: false,
          entryPolicyKind: 'full',
        }),
      )
      expect(result).toEqual({ allowed: false, probeOnly: false })
    })

    it('allows a full-entry policy unrestricted once the trend has recaptured (no probe concept)', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit,
          trendContinues: true,
          entryPolicyKind: 'full',
        }),
      )
      expect(result).toEqual({ allowed: true, probeOnly: false })
    })

    it('demotes a staged-entry policy to probe-only once the trend has recaptured', () => {
      const result = evaluateReentry(
        input({
          policy: { kind: 'reason-aware', slWaitDays: 5 },
          lastExit,
          trendContinues: true,
          entryPolicyKind: 'staged',
        }),
      )
      expect(result).toEqual({ allowed: true, probeOnly: true })
    })
  })
})

/**
 * Harness integration (#709 Phase 5): `reentryPolicy: 'reason-aware'` blocks a would-be re-entry
 * after a STOP that `reentryPolicy: 'none'` (Phase 3/4 behavior) takes, on the identical bars.
 *
 * A single sharp crash (-20% one day) after the initial entry both triggers the STOP and wrecks
 * the 50d-return trend gate — `distance.buyable`/`trendContinues` stay false for weeks while the
 * gate recovers. The +2%/day rebound restores `trendContinues` (all non-pullback gates pass) on
 * 2025-04-20, at which point the position is still flat and (staged) `probeEligible` — the first
 * bar either policy could actually re-enter on. `businessDaysBetween('2025-04-02', '2025-04-20')`
 * (the STOP date to that bar) is 12; `slWaitDays: 15` keeps the STOP-wait block active there, so
 * `'reason-aware'` still blocks while `'none'` fires the probe fill — proving the gate, not
 * happenstance, is what's different between the two runs.
 */
describe('runLifecycleBacktest — reason-aware reentryPolicy blocks a re-entry `none` takes (#709 Phase 5)', () => {
  it('does not re-enter after a STOP within slWaitDays, while `none` does on the identical bars', async () => {
    const warmup = uptrendWarmup(100)
    const last = warmup[warmup.length - 1]!.close
    const pullbackDay: DailyBar = {
      date: '2025-04-01',
      open: last,
      high: last,
      low: last * 0.94,
      close: last * 0.95,
    }
    const crash: DailyBar = {
      date: '2025-04-02',
      open: pullbackDay.close,
      high: pullbackDay.close,
      low: pullbackDay.close * 0.8,
      close: pullbackDay.close * 0.8,
    }
    const rebound = buildBars(crash.close, Array(20).fill(1.02), '2025-04-03')
    const bars = [...warmup, pullbackDay, crash, ...rebound]
    const staged: EntryPolicy = {
      kind: 'staged',
      fractions: { probe: 0.25, confirm: 0.25, full: 0.5 },
      confirmDays: 3,
    }
    const base = {
      symbol: 'TEST',
      from: '2025-01-01',
      to: '2025-12-31',
      initialCash: 10_000,
      rule: TEST_DEFAULT_RULE,
      entryPolicy: staged,
      feePctOfNotional: 0,
      feeFixedPerOrder: 0,
    } as const

    const withoutGate = await runLifecycleBacktest(bars, { ...base, reentryPolicy: { kind: 'none' } })
    const withGate = await runLifecycleBacktest(bars, {
      ...base,
      reentryPolicy: { kind: 'reason-aware', slWaitDays: 15 },
    })

    // `none`: STOP exit, then a second round trip re-entering once the trend gate recovers
    // (forced closed at end-of-data — the window doesn't run long enough for a real exit signal).
    expect(withoutGate.trades).toHaveLength(2)
    expect(withoutGate.trades[0]!.exitReason).toBe('STOP')
    expect(withoutGate.trades[1]!.entryLegs[0]!.label).toBe('probe')
    expect(withoutGate.trades[1]!.entryLegs[0]!.date).toBe('2025-04-20')

    // `reason-aware` (slWaitDays: 15 > the 12 business days from the STOP to 2025-04-20): the
    // exact same re-entry opportunity is blocked outright — only the original STOP round trip.
    expect(withGate.trades).toHaveLength(1)
    expect(withGate.trades[0]!.exitReason).toBe('STOP')
  })
})
