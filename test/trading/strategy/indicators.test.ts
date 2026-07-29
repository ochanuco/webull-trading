import { describe, expect, it } from 'vitest'
import {
  computeHoldBusinessDays,
  computePullbackIndicators,
  type DailyBar,
} from '../../../src/trading/strategy/indicators'

function makeBars(closes: number[]): DailyBar[] {
  return closes.map((close, i) => {
    const iso = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
    return { date: iso, open: close, high: close * 1.01, low: close * 0.99, close }
  })
}

describe('computePullbackIndicators', () => {
  it('returns null when fewer than 50 bars are provided', () => {
    expect(computePullbackIndicators(makeBars([1, 2, 3]))).toBeNull()
  })

  it('computes sma50 / return50d (20d) / high20d (10d) / low20d from the tail window', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const result = computePullbackIndicators(makeBars(closes))
    expect(result).not.toBeNull()
    const r = result!
    expect(r.price).toBe(159)
    // sma50 = average of closes 110..159 = (110+159)/2 = 134.5
    expect(r.sma50).toBeCloseTo(134.5, 4)
    // #318: return lookback は 20 営業日。last vs closes[-20] = closes[40] = 140
    // → (159 - 140)/140
    expect(r.return50d).toBeCloseTo((159 - 140) / 140, 4)
    // #318: high lookback は 10 営業日。max of highs for last 10 bars。
    // highs are close*1.01、最新 10 closes = 150..159 → max = 159 * 1.01。
    expect(r.high20d).toBeCloseTo(159 * 1.01, 4)
    // low20d は変更なし (20 日窓のまま、dashboard 表示用)。
    // lows are close*0.99, last 20 closes are 140..159 → min = 140 * 0.99
    expect(r.low20d).toBeCloseTo(140 * 0.99, 4)
    // #momentum: breakoutHigh20 = 当日を除く直近20日の終値高値。
    // closes[-21..-1] = closes 139..158 → max = 158 (当日 159 は除外)。
    expect(r.breakoutHigh20).toBe(158)
  })

  it('breakoutHigh20 は当日終値を含めない (自己参照防止)', () => {
    // 単調増加なら当日が常に最高値。breakoutHigh20 は前日(=当日除く最高)になる。
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const r = computePullbackIndicators(makeBars(closes))!
    // 当日 close = 159。breakoutHigh20 は 158 (当日を除外) で、159 にはならない。
    expect(r.breakoutHigh20).toBe(158)
    expect(r.breakoutHigh20).toBeLessThan(r.price)
  })

  it('low20d picks the smallest low even when not the most recent bar', () => {
    // 60 closes mostly increasing, but last 20 includes a dip to enforce the
    // 20-bar window semantics. Set bar[55].low artificially low.
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const bars = makeBars(closes)
    bars[55]!.low = 50 // dip in last 20
    const r = computePullbackIndicators(bars)!
    expect(r.low20d).toBeCloseTo(50, 4)
  })

  describe('intradayPrice override', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const bars = makeBars(closes)
    // #318: daily close ベースの fixture 値: last = 159, sma50 = 134.5、
    // return50d (実体は 20d) = (159-140)/140、high20d (実体は 10d) = 159*1.01。
    const dailyOnly = computePullbackIndicators(bars)!

    it('uses intradayPrice as price when provided and positive', () => {
      const r = computePullbackIndicators(bars, 200)!
      expect(r.price).toBe(200)
      // daily 系 indicator は intraday の影響を受けない
      expect(r.sma50).toBeCloseTo(dailyOnly.sma50, 4)
      expect(r.return50d).toBeCloseTo(dailyOnly.return50d, 4)
      expect(r.high20d).toBeCloseTo(dailyOnly.high20d, 4)
      expect(r.low20d).toBeCloseTo(dailyOnly.low20d, 4)
      expect(r.atr20).toBeCloseTo(dailyOnly.atr20, 4)
      expect(r.baselineAtr20).toBeCloseTo(dailyOnly.baselineAtr20, 4)
    })

    it('falls back to daily close when intradayPrice is omitted', () => {
      const r = computePullbackIndicators(bars)!
      expect(r.price).toBe(159)
    })

    it('falls back to daily close when intradayPrice is null', () => {
      const r = computePullbackIndicators(bars, null)!
      expect(r.price).toBe(159)
    })

    it('falls back to daily close on NaN / Infinity / 0 / negative', () => {
      expect(computePullbackIndicators(bars, Number.NaN)!.price).toBe(159)
      expect(computePullbackIndicators(bars, Number.POSITIVE_INFINITY)!.price).toBe(159)
      expect(computePullbackIndicators(bars, 0)!.price).toBe(159)
      expect(computePullbackIndicators(bars, -10)!.price).toBe(159)
    })
  })
})

describe('computeHoldBusinessDays', () => {
  it('counts weekday-only days between open and now (US)', () => {
    // Mon 2026-04-13 open, Fri 2026-04-17 now → 4 business days
    expect(
      computeHoldBusinessDays(
        '2026-04-13T10:00:00.000Z',
        new Date('2026-04-17T10:00:00.000Z'),
        'US',
      ),
    ).toBe(4)
  })

  it('skips weekends (US)', () => {
    // Fri open, next Mon now → 1 business day (weekend does not count)
    expect(
      computeHoldBusinessDays(
        '2026-04-17T10:00:00.000Z',
        new Date('2026-04-20T10:00:00.000Z'),
        'US',
      ),
    ).toBe(1)
  })

  it('returns 0 for an invalid ISO', () => {
    expect(computeHoldBusinessDays('not-a-date', new Date(), 'US')).toBe(0)
  })
})

// #atr-baseline-window: baseline は既定で直近 20 本 (atr20 の窓) を内包する。
// opt-in で除外でき、その場合だけ「直近 vs それ以前」の素直な比率になる。
describe('computePullbackIndicators baseline ATR window', () => {
  /** 前半 40 本は静穏 (幅 1%)、直近 20 本だけボラを 5 倍にした系列。 */
  function volSpikeBars(): DailyBar[] {
    return Array.from({ length: 61 }, (_, i) => {
      const close = 100
      const spread = i >= 41 ? 0.05 : 0.01
      const iso = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
      return {
        date: iso,
        open: close,
        high: close * (1 + spread),
        low: close * (1 - spread),
        close,
      }
    })
  }

  it('overlap では baseline に直近の急騰分が混ざり、比率が鈍る', () => {
    const r = computePullbackIndicators(volSpikeBars(), null, { baselineMode: 'overlap' })!
    const ratio = r.atr20 / r.baselineAtr20
    // 実際のボラ差は 5 倍だが、baseline が直近を含むので比率は大幅に縮む。
    expect(ratio).toBeLessThan(3)
  })

  it("baselineMode: 'exclude-recent' で実際のボラ差 (5 倍) に近い比率になる", () => {
    const r = computePullbackIndicators(volSpikeBars(), null, {
      baselineMode: 'exclude-recent',
    })!
    const ratio = r.atr20 / r.baselineAtr20
    expect(ratio).toBeGreaterThan(4)
  })

  it('最小 bar 数 (50) でも除外後に十分なサンプルが残る', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i)
    const excluded = computePullbackIndicators(makeBars(closes), null, {
      baselineMode: 'exclude-recent',
    })!
    // TR 49 本 − 直近 20 本 = 29 本。0 除算や空平均にならないことを固定する。
    expect(excluded.baselineAtr20).toBeGreaterThan(0)
    expect(Number.isFinite(excluded.atr20 / excluded.baselineAtr20)).toBe(true)
  })
})

// #atr-baseline-window: 既定の percentile は「その銘柄自身の atr20 分布の p80」。
// 銘柄ごとのボラ水準 (SOXL 22% vs VUG 1.7%) に依存せず高ボラ局面を検出する。
describe('percentile baseline (既定)', () => {
  /** 前半 40 本は静穏、直近 20 本だけボラ 5 倍。 */
  function volSpikeBars(): DailyBar[] {
    return Array.from({ length: 61 }, (_, i) => {
      const spread = i >= 41 ? 0.05 : 0.01
      return {
        date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
        open: 100,
        high: 100 * (1 + spread),
        low: 100 * (1 - spread),
        close: 100,
      }
    })
  }

  it('急騰局面では atr20 が p80 を超える (比率 > 1)', () => {
    const r = computePullbackIndicators(volSpikeBars(), null, { baselineMode: 'percentile' })!
    expect(r.atr20 / r.baselineAtr20).toBeGreaterThan(1)
  })

  it('平常時は p80 を超えない (比率 <= 1)', () => {
    const calm = Array.from({ length: 61 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
    }))
    const r = computePullbackIndicators(calm, null, { baselineMode: 'percentile' })!
    expect(r.atr20 / r.baselineAtr20).toBeLessThanOrEqual(1)
  })

  it('未指定なら percentile が既定', () => {
    const bars = volSpikeBars()
    const explicit = computePullbackIndicators(bars, null, { baselineMode: 'percentile' })!
    const implicit = computePullbackIndicators(bars)!
    expect(implicit.baselineAtr20).toBeCloseTo(explicit.baselineAtr20, 10)
  })
})
