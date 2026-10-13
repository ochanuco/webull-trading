import { describe, expect, it } from 'vitest'
import {
  replayLookbackBars,
  replayModel,
  sliceReplayWindow,
} from '../../../src/trading/models/replay'
import type { StrategyModelSpec } from '../../../src/trading/models/strategyModel'
import type { DailyBar } from '../../../src/trading/strategy/indicators'

const SPEC: StrategyModelSpec = {
  kind: 'pullback_uptrend',
  params: {
    stopPct: -0.04,
    takeProfitPct: 0.05,
    timeStopDays: 10,
    pullbackMax: -0.01,
    pullbackMin: -0.12,
    minReturn50d: -1,
    requireAboveSma50: false,
    kAtr: 2,
    maxSma50DeviationPct: 5,
    maxAtrRatio: 100,
    maxStopToTpRatio: 0,
    atrBaselineMode: 'percentile',
  },
}

/** Oscillating uptrend on weekdays starting 2025-01-01, scaled by `scale`. */
function bars(count: number, scale = 1, start = '2025-01-01'): DailyBar[] {
  const out: DailyBar[] = []
  const d = new Date(`${start}T00:00:00.000Z`)
  let i = 0
  while (out.length < count) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) {
      const close = scale * 100 * 1.003 ** i * (1 + 0.05 * Math.sin(i / 3))
      out.push({ date: d.toISOString().slice(0, 10), open: close, high: close * 1.01, low: close * 0.99, close })
      i += 1
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

const WINDOW = { from: '2025-04-01', to: '2025-12-31', initialCashUsd: 10_000, initialCashJpy: 1_500_000 }

describe('sliceReplayWindow', () => {
  it('keeps 60 warmup bars before from and drops bars after to', () => {
    const all = bars(300)
    const sliced = sliceReplayWindow(all, '2025-06-02', '2025-08-29')!
    const liveStart = sliced.findIndex((b) => b.date >= '2025-06-02')
    expect(liveStart).toBe(60)
    expect(sliced[sliced.length - 1]!.date <= '2025-08-29').toBe(true)
  })

  it('returns null when no bar falls inside the window', () => {
    expect(sliceReplayWindow(bars(50), '2026-01-01', '2026-02-01')).toBeNull()
  })
})

describe('replayLookbackBars', () => {
  it('spans from `from` to today, not just the window', () => {
    const today = new Date('2026-10-13T00:00:00.000Z')
    expect(replayLookbackBars('2026-10-01', today)).toBeLessThan(replayLookbackBars('2024-10-01', today))
    expect(replayLookbackBars('2024-10-01', today)).toBeGreaterThan(500)
  })
})

describe('replayModel', () => {
  it('is deterministic for the same model and bars', async () => {
    const input = new Map([['SOXL', bars(320)]])
    const a = await replayModel(SPEC, input, WINDOW)
    const b = await replayModel(SPEC, input, WINDOW)
    expect(a).toEqual(b)
    expect(a.metrics.totalTrades).toBeGreaterThan(0)
  })

  it('aggregates trades across symbols and keeps P&L per currency', async () => {
    const result = await replayModel(
      SPEC,
      new Map([
        ['SOXL', bars(320)],
        ['1570', bars(320, 200)],
      ]),
      WINDOW,
    )
    const perSymbolTrades = result.perSymbol.reduce((n, s) => n + s.metrics.totalTrades, 0)
    expect(result.metrics.totalTrades).toBe(perSymbolTrades)
    const reasons = result.metrics.exitReasons
    expect(reasons.TP + reasons.STOP + reasons.TIME_STOP + reasons.END_OF_DATA).toBe(perSymbolTrades)
    expect(result.metrics.pnlByCurrency.USD).toBe(result.perSymbol[0]!.metrics.pnlByCurrency.USD)
    expect(result.metrics.pnlByCurrency.JPY).toBe(result.perSymbol[1]!.metrics.pnlByCurrency.JPY)
  })

  it('combines symbols as an equal-weight normalized curve', async () => {
    const solo = await replayModel(SPEC, new Map([['SOXL', bars(320)]]), WINDOW)
    const pair = await replayModel(
      SPEC,
      new Map([
        ['SOXL', bars(320)],
        ['SOXX', bars(320)],
      ]),
      WINDOW,
    )
    expect(solo.equityCurve[0]!.date >= WINDOW.from).toBe(true)
    expect(pair.equityCurve.map((p) => p.equity)).toEqual(solo.equityCurve.map((p) => p.equity))
    expect(pair.metrics.totalReturn).toBeCloseTo(solo.metrics.totalReturn, 12)
  })

  it('skips a symbol with no bars in the window instead of failing the replay', async () => {
    const result = await replayModel(
      SPEC,
      new Map([
        ['SOXL', bars(320)],
        ['OLD', bars(40, 1, '2023-01-02')],
      ]),
      WINDOW,
    )
    expect(result.skippedSymbols).toEqual(['OLD'])
    expect(result.perSymbol.map((s) => s.symbol)).toEqual(['SOXL'])
  })
})
