import { describe, expect, it } from 'vitest'
import {
  buildBuyabilityView,
  computeEntryDistance,
  type EvalIndicatorPoint,
} from '../../../src/trading/strategy/entryDistance'
import {
  TEST_DEFAULT_RULE,
  type PullbackIndicators,
} from '../../../src/trading/strategy/strategies/PullbackUptrendStrategy'

// TEST_DEFAULT_RULE: minReturn50d 0.08 / requireAboveSma50 true /
// maxSma50DeviationPct 0.6 / maxAtrRatio 1.5 / pullbackMax -0.03 / pullbackMin -0.06
const RULE = TEST_DEFAULT_RULE

function ind(overrides: Partial<PullbackIndicators>): PullbackIndicators {
  return {
    price: 95,
    sma50: 90,
    return50d: 0.12,
    high20d: 100, // band = [94, 97]
    atr20: 1,
    baselineAtr20: 1,
    ...overrides,
  }
}

describe('computeEntryDistance', () => {
  it('全ゲート通過 → buyable、entryPrice = 現価格、priceMove 0', () => {
    const d = computeEntryDistance(ind({ price: 95 }), RULE)
    expect(d.buyable).toBe(true)
    expect(d.bindingGate).toBeNull()
    expect(d.entryPrice).toBeCloseTo(95, 6)
    expect(d.priceMove).toBeCloseTo(0, 6)
  })

  it('押し目が浅すぎ (価格が band 上端より上) → band 上端まで下落が必要', () => {
    const d = computeEntryDistance(ind({ price: 99 }), RULE) // pullback -0.01 > -0.03
    expect(d.buyable).toBe(false)
    expect(d.bindingGate?.key).toBe('pullback_shallow')
    expect(d.entryPrice).toBeCloseTo(97, 6) // high20d 100 * (1 + -0.03)
    expect(d.priceMove).toBeLessThan(0) // 下落が必要
    expect(d.priceMove).toBeCloseTo((97 - 99) / 99, 6)
  })

  it('押し目が深すぎ (価格が band 下端より下) → band 下端まで上昇が必要', () => {
    const d = computeEntryDistance(ind({ price: 92 }), RULE) // pullback -0.08 < -0.06
    expect(d.buyable).toBe(false)
    expect(d.bindingGate?.key).toBe('pullback_deep')
    expect(d.entryPrice).toBeCloseTo(94, 6) // high20d 100 * (1 + -0.06)
    expect(d.priceMove).toBeGreaterThan(0) // 上昇が必要
  })

  it('トレンド不足 (価格非依存) → entryPrice null (価格を動かしても入場不可)', () => {
    const d = computeEntryDistance(ind({ return50d: 0.02 }), RULE)
    expect(d.buyable).toBe(false)
    expect(d.bindingGate?.key).toBe('trend')
    expect(d.entryPrice).toBeNull()
    expect(d.priceMove).toBeNull()
  })

  it('ボラ過熱 (価格非依存) → binding=volatility、entryPrice null', () => {
    const d = computeEntryDistance(ind({ atr20: 3, baselineAtr20: 1 }), RULE) // ratio 3 > 1.5
    expect(d.bindingGate?.key).toBe('volatility')
    expect(d.entryPrice).toBeNull()
  })

  it('過熱と押し目 band が両立しない → binding=overextension、entryPrice null', () => {
    // sma50 50 / high20d 100: band [94,97] だが過熱上限は 50*1.6=80。
    // 価格で同時成立できないので「価格を動かすだけでは入場不可」。
    const d = computeEntryDistance(ind({ sma50: 50, price: 95, high20d: 100 }), RULE)
    expect(d.bindingGate?.key).toBe('overextension')
    expect(d.entryPrice).toBeNull()
  })

  it('過熱が上限を価格距離として制約する (band 上端 > 過熱上限のとき過熱上限を採る)', () => {
    // sma50 95, high20d 100: band [94,97]、過熱上限 95*(1+0.05)=99.75 (緩めた rule)。
    // ここでは過熱が緩いので band 上端 97 が entry。過熱が band 内に食い込むケースを
    // 作るため maxSma50DeviationPct を絞る。
    const tightRule = { ...RULE, maxSma50DeviationPct: 0.005 } // 上限 95*1.005=95.475
    const d = computeEntryDistance(ind({ sma50: 95, price: 99, high20d: 100 }), tightRule)
    // band [94,97] ∩ (>95) ∩ (<=95.475) = [95, 95.475] → 現価格99 に最も近い点 95.475
    expect(d.entryPrice).toBeCloseTo(95.475, 3)
  })

  it('ゲート列は entryDecision と同じ 7 ゲート', () => {
    const d = computeEntryDistance(ind({}), RULE)
    expect(d.gates.map((g) => g.key)).toEqual([
      'trend',
      'above_sma50',
      'overextension',
      'volatility',
      'high20d_valid',
      'pullback_shallow',
      'pullback_deep',
    ])
  })
})

describe('buildBuyabilityView', () => {
  function evalsFromPrices(prices: number[]): EvalIndicatorPoint[] {
    return prices.map((price, i) => ({
      timestamp: `2026-06-0${i + 1}T14:00:00.000Z`,
      indicators: ind({ price }),
    }))
  }

  it('空なら current null / trend unknown', () => {
    const v = buildBuyabilityView([], RULE)
    expect(v.current).toBeNull()
    expect(v.trend).toBe('unknown')
    expect(v.etaTradingDays).toBeNull()
  })

  it('距離が縮小していく → trend closing + 参考ETA 正値', () => {
    // 99.5→97.5 と band 上端 97 に近づく (priceMove の絶対値が縮小)
    const v = buildBuyabilityView(evalsFromPrices([99.5, 99, 98.5, 98, 97.5]), RULE)
    expect(v.trend).toBe('closing')
    expect(v.etaTradingDays).not.toBeNull()
    expect(v.etaTradingDays!).toBeGreaterThan(0)
    expect(v.current?.buyable).toBe(false)
  })

  it('距離が拡大していく → trend widening + ETA null', () => {
    const v = buildBuyabilityView(evalsFromPrices([97.5, 98, 98.5, 99, 99.5]), RULE)
    expect(v.trend).toBe('widening')
    expect(v.etaTradingDays).toBeNull()
  })

  it('距離が横ばい → trend flat + ETA null', () => {
    const v = buildBuyabilityView(evalsFromPrices([99, 99, 99, 99, 99]), RULE)
    expect(v.trend).toBe('flat')
    expect(v.etaTradingDays).toBeNull()
  })

  it('最新が buyable なら current.buyable true', () => {
    const v = buildBuyabilityView(evalsFromPrices([99, 98, 97, 96, 95]), RULE)
    expect(v.current?.buyable).toBe(true)
  })
})
