import { describe, expect, it } from 'vitest'
import {
  NO_TRADE_COST,
  estimateOrderCost,
  estimateRoundTripCost,
  netRealizedPnl,
} from '../../../src/trading/domain/tradingCost'

describe('estimateOrderCost', () => {
  it('料率と固定費を足す', () => {
    expect(estimateOrderCost(1000, { feePctOfNotional: 0.002, feeFixedPerOrder: 1 })).toBeCloseTo(3)
  })

  it('未設定 (既定) なら 0', () => {
    expect(estimateOrderCost(1000, NO_TRADE_COST)).toBe(0)
  })

  it('notional が不正でも固定費だけは残る (料率は 0 扱い)', () => {
    const cfg = { feePctOfNotional: 0.002, feeFixedPerOrder: 1 }
    expect(estimateOrderCost(Number.NaN, cfg)).toBe(1)
    expect(estimateOrderCost(-100, cfg)).toBe(1)
  })

  it('負値 / 非有限の設定は 0 に倒す (コストを負にして PnL を水増ししない)', () => {
    expect(estimateOrderCost(1000, { feePctOfNotional: -0.5, feeFixedPerOrder: -10 })).toBe(0)
    expect(
      estimateOrderCost(1000, { feePctOfNotional: Number.NaN, feeFixedPerOrder: Number.NaN }),
    ).toBe(0)
  })
})

describe('estimateRoundTripCost', () => {
  it('entry と exit の両脚を足す', () => {
    const cfg = { feePctOfNotional: 0.001, feeFixedPerOrder: 0.5 }
    // 1000*0.001+0.5 + 1100*0.001+0.5 = 1.5 + 1.6
    expect(estimateRoundTripCost(1000, 1100, cfg)).toBeCloseTo(3.1)
  })
})

describe('netRealizedPnl', () => {
  it('コスト未設定なら gross と一致する (既存挙動の回帰保証)', () => {
    const r = netRealizedPnl({
      avgPrice: 40,
      exitPrice: 43,
      quantity: 5,
      config: NO_TRADE_COST,
    })
    expect(r.gross).toBe(15)
    expect(r.cost).toBe(0)
    expect(r.net).toBe(15)
  })

  // 本番実測 (SQQQ 5 株 @40.775 → 42.9401、gross +10.83)。往復 0.22% だと
  // コストは約 0.92 で、勝ち幅の 8% 相当が消える。
  it('実測トレードで gross から往復コストを引く', () => {
    const r = netRealizedPnl({
      avgPrice: 40.775,
      exitPrice: 42.9401,
      quantity: 5,
      config: { feePctOfNotional: 0.0022, feeFixedPerOrder: 0 },
    })
    expect(r.gross).toBeCloseTo(10.83, 2)
    expect(r.cost).toBeCloseTo(0.92, 2)
    expect(r.net).toBeCloseTo(9.9, 1)
  })

  it('小さい勝ちはコストで負けに転じ得る', () => {
    const r = netRealizedPnl({
      avgPrice: 100,
      exitPrice: 100.5,
      quantity: 1,
      config: { feePctOfNotional: 0, feeFixedPerOrder: 1 },
    })
    expect(r.gross).toBeCloseTo(0.5)
    expect(r.net).toBeCloseTo(-1.5)
  })
})
