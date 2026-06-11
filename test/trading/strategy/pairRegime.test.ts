import { describe, expect, it } from 'vitest'
import {
  evaluatePairRegime,
  validatePairRegimeThresholds,
  type PairRegimeThresholds,
} from '../../../src/trading/strategy/pairRegime'
import type { DailyBar } from '../../../src/trading/strategy/indicators'

const now = new Date('2026-04-20T14:30:00.000Z') // 月曜 (NY 2026-04-20)

const T: PairRegimeThresholds = {
  bullEnter: 0.03,
  bullExit: 0.01,
  bearEnter: -0.04,
  bearExit: -0.015,
}

/** 終値列から、now の前日 (2026-04-19) で終わる連続日付の bars を作る。 */
function barsOf(closes: number[], endDate = '2026-04-19'): DailyBar[] {
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  return closes.map((close, i) => ({
    date: new Date(end - (closes.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
  }))
}

const growth = (n: number, ratio: number, start = 100): number[] =>
  Array.from({ length: n }, (_, i) => start * ratio ** i)

describe('evaluatePairRegime (#472)', () => {
  it('上昇系列 (20d +6%) は bull', () => {
    const d = evaluatePairRegime(barsOf(growth(80, 1.003)), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d.zone).toBe('bull')
    expect(d.score).toBeGreaterThan(0.03)
    expect(d.asOfDate).toBe('2026-04-19')
  })

  it('下落系列 (20d −6%) は bear', () => {
    const d = evaluatePairRegime(barsOf(growth(80, 0.997)), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d.zone).toBe('bear')
    expect(d.score).toBeLessThan(-0.04)
  })

  it('横ばいは neutral', () => {
    const d = evaluatePairRegime(barsOf(Array(80).fill(100)), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d.zone).toBe('neutral')
    expect(d.score).toBe(0)
  })

  it('hysteresis: bull 進入後に score が +2% (enter 未満 / exit 超) へ落ちても bull を維持', () => {
    const closes = growth(80, 1.003)
    // 最終 score をちょうど +2% に落とす (bullExit +1% は上回る)
    closes[closes.length - 1] = closes[closes.length - 1 - 20]! * 1.02
    const d = evaluatePairRegime(barsOf(closes), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d.zone).toBe('bull')
    expect(d.score).toBeCloseTo(0.02, 6)
  })

  it('bull → bear は直接遷移しない (急落 1 score では neutral 止まり、2 score 目で bear)', () => {
    const base = growth(80, 1.003)
    const crashOnce = [...base]
    crashOnce[crashOnce.length - 1] = crashOnce[crashOnce.length - 1 - 20]! * 0.94 // score −6%
    const d1 = evaluatePairRegime(barsOf(crashOnce), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d1.zone).toBe('neutral')

    const crashTwice = [...base]
    crashTwice[crashTwice.length - 2] = crashTwice[crashTwice.length - 2 - 20]! * 0.94
    crashTwice[crashTwice.length - 1] = crashTwice[crashTwice.length - 1 - 20]! * 0.94
    const d2 = evaluatePairRegime(barsOf(crashTwice), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d2.zone).toBe('bear')
  })

  it('当日 (進行中) の bar は無視される — intraday を混ぜても結果が変わらない (AC 3)', () => {
    const base = barsOf(growth(80, 1.003))
    const withToday = [
      ...base,
      { date: '2026-04-20', open: 1, high: 1, low: 1, close: 1 }, // 異常値の進行中 bar
    ]
    const a = evaluatePairRegime(base, { proxySymbol: 'QQQ', thresholds: T, now })
    const b = evaluatePairRegime(withToday, { proxySymbol: 'QQQ', thresholds: T, now })
    expect(b).toEqual(a)
  })

  it('bars 不足は unknown (fail-closed)', () => {
    const d = evaluatePairRegime(barsOf(growth(15, 1.003)), { proxySymbol: 'QQQ', thresholds: T, now })
    expect(d.zone).toBe('unknown')
    expect(d.reason).toContain('insufficient')
  })

  it('最終完結 bar が 5 暦日超 stale なら unknown', () => {
    const d = evaluatePairRegime(barsOf(growth(80, 1.003), '2026-04-10'), {
      proxySymbol: 'QQQ',
      thresholds: T,
      now,
    })
    expect(d.zone).toBe('unknown')
    expect(d.reason).toContain('stale')
  })

  it('閾値の順序破壊は unknown (黙って続行しない)', () => {
    const bad = { ...T, bullExit: 0.05 } // bullExit > bullEnter
    const d = evaluatePairRegime(barsOf(growth(80, 1.003)), { proxySymbol: 'QQQ', thresholds: bad, now })
    expect(d.zone).toBe('unknown')
    expect(d.reason).toContain('misconfigured')
    expect(validatePairRegimeThresholds(bad)).toBe(false)
    expect(validatePairRegimeThresholds(T)).toBe(true)
  })

  it('同じ入力からは常に同じ zone (stateless walk の決定論、AC 2)', () => {
    const bars = barsOf(growth(80, 1.003))
    const a = evaluatePairRegime(bars, { proxySymbol: 'QQQ', thresholds: T, now })
    const b = evaluatePairRegime(bars, { proxySymbol: 'QQQ', thresholds: T, now })
    expect(b).toEqual(a)
  })
})
