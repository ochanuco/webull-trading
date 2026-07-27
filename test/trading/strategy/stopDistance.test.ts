import { describe, expect, it } from 'vitest'
import { resolveStopDistance } from '../../../src/trading/strategy/stopDistance'

const base = {
  price: 100,
  stopPct: -0.04,
  takeProfitPct: 0.07,
  atr20: 1,
  kAtr: 2,
  maxStopToTpRatio: 2,
}

describe('resolveStopDistance', () => {
  it('pct stop が floor になる (ATR が小さい)', () => {
    // atr 1 * kAtr 2 = 2 < pct 4 → pct が勝つ
    const r = resolveStopDistance({ ...base, atr20: 1 })
    expect(r.distance).toBe(4)
    expect(r.effectiveStopPct).toBeCloseTo(-0.04)
    expect(r.dominant).toBe('pct')
  })

  it('ATR stop が pct を上回れば ATR を採る (cap 内)', () => {
    // atr 3 * 2 = 6 > pct 4、cap = 7 * 2 = 14 なので素通り
    const r = resolveStopDistance({ ...base, atr20: 3 })
    expect(r.distance).toBe(6)
    expect(r.dominant).toBe('atr')
  })

  it('ATR stop が TP の倍数上限を超えたら cap する', () => {
    // atr 15 * 2 = 30 → cap = |100 * 0.07| * 2 = 14
    const r = resolveStopDistance({ ...base, atr20: 15 })
    expect(r.distance).toBeCloseTo(14, 10)
    expect(r.effectiveStopPct).toBeCloseTo(-0.14)
    expect(r.dominant).toBe('tp-cap')
  })

  it('cap が名目 pct stop より狭い場合は pct stop が勝つ (stop を狭めない)', () => {
    // TP 1% * ratio 2 = cap 2 < pct stop 4 → pct
    const r = resolveStopDistance({ ...base, takeProfitPct: 0.01, atr20: 15 })
    expect(r.distance).toBe(4)
    expect(r.dominant).toBe('pct')
  })

  it('ratio 0 で cap 無効 (従来の ATR 連動そのまま)', () => {
    const r = resolveStopDistance({ ...base, atr20: 15, maxStopToTpRatio: 0 })
    expect(r.distance).toBe(30)
    expect(r.dominant).toBe('atr')
  })

  it('takeProfitPct が 0 / 未設定相当なら cap 無効', () => {
    const r = resolveStopDistance({ ...base, atr20: 15, takeProfitPct: 0 })
    expect(r.distance).toBe(30)
  })

  it('atr20 が非有限 / 0 でも pct stop に落ちる', () => {
    expect(resolveStopDistance({ ...base, atr20: Number.NaN }).distance).toBe(4)
    expect(resolveStopDistance({ ...base, atr20: 0 }).distance).toBe(4)
  })

  it('price が不正なら距離 0 + 名目 stopPct を返す (呼び出し側が invalid-stop で弾く)', () => {
    const r = resolveStopDistance({ ...base, price: 0, atr20: 0 })
    expect(r.distance).toBe(0)
    expect(r.effectiveStopPct).toBe(-0.04)
  })

  // 本番実測 (SOXL): atr20/price = 22% → kAtr 2.0 で stop -44%、TP は +7%。
  // R:R 0.16 という壊れた比率が cap で 0.5 に矯正されることを固定する。
  it('SOXL 実測パラメタで R:R が 0.5 以上になる', () => {
    const r = resolveStopDistance({
      price: 136.81,
      stopPct: -0.04,
      takeProfitPct: 0.07,
      atr20: 30.39,
      kAtr: 2,
      maxStopToTpRatio: 2,
    })
    const rr = 0.07 / Math.abs(r.effectiveStopPct)
    expect(rr).toBeGreaterThanOrEqual(0.5)
    expect(r.dominant).toBe('tp-cap')
  })
})
