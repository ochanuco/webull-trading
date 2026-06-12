import { describe, expect, it } from 'vitest'
import {
  buildCashRebalancePlan,
  computeConditionalAllocation,
  type AllocationComputeInput,
} from '../../../src/trading/strategy/conditionalAllocation'

const baseInput = (): AllocationComputeInput => ({
  targetWeights: { SGOV: 0.7, QQQ: 0.2, TQQQ: 0.05, SOXL: 0.05 },
  policy: {
    entryRequired: new Set(['QQQ', 'TQQQ', 'SOXL']),
    alwaysActive: new Set(['SGOV']),
    cashFallback: { QQQ: ['SGOV'], TQQQ: ['SGOV'], SOXL: ['SGOV'] },
  },
  entryStatuses: { SGOV: 'NG', QQQ: 'ENTRY', TQQQ: 'WATCH', SOXL: 'NG' },
  heldSymbols: new Set(),
  symbolCurrency: { SGOV: 'USD', QQQ: 'USD', TQQQ: 'USD', SOXL: 'USD' },
})

describe('computeConditionalAllocation (#452 Layer 3)', () => {
  it('issue #450 の設定例: 未通過のレバ枠が SGOV へ退避される', () => {
    const view = computeConditionalAllocation(baseInput())
    // QQQ は ENTRY → target 維持。TQQQ/SOXL は未通過 → 0、SGOV へ +10%。
    expect(view.bySymbol.QQQ!.activeWeight).toBeCloseTo(0.2, 9)
    expect(view.bySymbol.TQQQ!.activeWeight).toBe(0)
    expect(view.bySymbol.TQQQ!.rerouteTo).toEqual(['SGOV'])
    expect(view.bySymbol.SOXL!.activeWeight).toBe(0)
    expect(view.bySymbol.SGOV!.activeWeight).toBeCloseTo(0.8, 9)
    expect(view.bySymbol.SGOV!.reroutedInWeight).toBeCloseTo(0.1, 9)
  })

  it('always_active は判定 NG でも常時 target = active (cash_parking)', () => {
    const view = computeConditionalAllocation(baseInput())
    // SGOV 自身の判定は NG だが always_active なので退避前で 0.7 を維持。
    expect(view.bySymbol.SGOV!.activeWeight).toBeGreaterThanOrEqual(0.7)
    expect(view.bySymbol.SGOV!.reason).toContain('always_active')
  })

  it('HALF も発注対象なので配分有効', () => {
    const input = baseInput()
    input.entryStatuses.TQQQ = 'HALF'
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.TQQQ!.activeWeight).toBeCloseTo(0.05, 9)
  })

  it('entry_required でない銘柄は従来挙動 (常時枠有効、挙動変更なし)', () => {
    const input = baseInput()
    input.policy.entryRequired = new Set()
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.TQQQ!.activeWeight).toBeCloseTo(0.05, 9)
    expect(view.bySymbol.SGOV!.activeWeight).toBeCloseTo(0.7, 9)
  })

  it('建玉保有中は未通過でも退避しない (exit 経路が管理)', () => {
    const input = baseInput()
    input.heldSymbols = new Set(['SOXL'])
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.SOXL!.activeWeight).toBeCloseTo(0.05, 9)
    expect(view.bySymbol.SGOV!.reroutedInWeight).toBeCloseTo(0.05, 9) // TQQQ 分のみ
  })

  it('評価データの無い entry_required 銘柄は未通過扱い (fail-closed) で退避', () => {
    const input = baseInput()
    delete input.entryStatuses.SOXL
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.SOXL!.activeWeight).toBe(0)
    expect(view.bySymbol.SOXL!.reason).toContain('評価データ無し')
  })

  it('退避先が通貨不一致なら退避しない (現金のまま、fail-closed)', () => {
    const input = baseInput()
    input.symbolCurrency.TQQQ = 'JPY'
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.TQQQ!.activeWeight).toBe(0)
    expect(view.bySymbol.TQQQ!.rerouteTo).toBeUndefined()
    expect(view.bySymbol.SGOV!.reroutedInWeight).toBeCloseTo(0.05, 9) // SOXL 分のみ
  })

  it('退避先未設定は実配分 0 のまま (現金待機)', () => {
    const input = baseInput()
    delete input.policy.cashFallback.SOXL
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.SOXL!.activeWeight).toBe(0)
    expect(view.bySymbol.SOXL!.rerouteTo).toBeUndefined()
  })

  it('target を持たない退避先も bySymbol に現れる (退避受入のみ)', () => {
    const input = baseInput()
    delete input.targetWeights.SGOV
    input.policy.alwaysActive = new Set()
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.SGOV!.targetWeight).toBe(0)
    expect(view.bySymbol.SGOV!.activeWeight).toBeCloseTo(0.1, 9)
  })
})

describe('computeConditionalAllocation × 多分岐退避 (#496 等分割)', () => {
  it('複数先は設定数で等分割し、無効な先の取り分は現金のまま (再正規化しない)', () => {
    const view = computeConditionalAllocation({
      targetWeights: { AAPL: 0.6 },
      policy: {
        entryRequired: new Set(['AAPL']),
        alwaysActive: new Set(),
        cashFallback: { AAPL: ['SGOV', 'USMV', '1357'] }, // 1357 は JPY = 無効
      },
      entryStatuses: { AAPL: 'WATCH' },
      heldSymbols: new Set(),
      symbolCurrency: { AAPL: 'USD', SGOV: 'USD', USMV: 'USD', '1357': 'JPY' },
    })
    // 設定 3 件で等分割 (各 0.2)。無効な 1357 の取り分は流れない = 合計 0.4 のみ退避
    expect(view.bySymbol.SGOV!.reroutedInWeight).toBeCloseTo(0.2)
    expect(view.bySymbol.USMV!.reroutedInWeight).toBeCloseTo(0.2)
    expect(view.bySymbol['1357']).toBeUndefined()
    expect(view.bySymbol.AAPL!.rerouteTo).toEqual(['SGOV', 'USMV'])
    expect(view.bySymbol.AAPL!.reason).toContain('等分割')
  })
})

describe('computeConditionalAllocation × インバース対 (枠共有の退避抑止)', () => {
  const pairInput = (): AllocationComputeInput => ({
    targetWeights: { SOXL: 0.5, SOXS: 0.5 },
    policy: {
      entryRequired: new Set(['SOXL', 'SOXS']),
      alwaysActive: new Set(),
      cashFallback: { SOXL: ['VUG'], SOXS: ['VUG'] },
    },
    entryStatuses: { SOXL: 'WATCH', SOXS: 'WATCH' },
    heldSymbols: new Set(),
    symbolCurrency: { SOXL: 'USD', SOXS: 'USD', VUG: 'USD' },
    inversePairs: { SOXL: 'SOXS', SOXS: 'SOXL' },
  })

  it('両側未通過でも退避は片側分のみ (対の 1 枠が二重に流れない)', () => {
    const view = computeConditionalAllocation(pairInput())
    const vug = view.bySymbol.VUG!
    expect(vug.reroutedInWeight).toBeCloseTo(0.5) // 1.0 (二重) ではなく 0.5
    const rerouted = [view.bySymbol.SOXL!, view.bySymbol.SOXS!].filter((a) => a.rerouteTo !== undefined)
    expect(rerouted).toHaveLength(1)
    const suppressed = [view.bySymbol.SOXL!, view.bySymbol.SOXS!].find((a) => a.rerouteTo === undefined)!
    expect(suppressed.activeWeight).toBe(0)
    expect(suppressed.reason).toContain('二重退避なし')
  })

  it('相方が保有中なら退避しない (枠は使用中)', () => {
    const input = pairInput()
    input.heldSymbols = new Set(['SOXL'])
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.SOXS!.rerouteTo).toBeUndefined()
    expect(view.bySymbol.SOXS!.reason).toContain('使用中')
    expect(view.bySymbol.VUG).toBeUndefined() // 退避ゼロなので VUG に枠は流れない
  })

  it('相方が判定通過 (ENTRY) なら退避しない', () => {
    const input = pairInput()
    input.entryStatuses = { SOXL: 'ENTRY', SOXS: 'WATCH' }
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.SOXL!.activeWeight).toBeCloseTo(0.5)
    expect(view.bySymbol.SOXS!.rerouteTo).toBeUndefined()
    expect(view.bySymbol.SOXS!.reason).toContain('使用中')
  })

  it('inversePairs 未指定は従来挙動 (互換)', () => {
    const input = pairInput()
    delete (input as { inversePairs?: unknown }).inversePairs
    const view = computeConditionalAllocation(input)
    expect(view.bySymbol.VUG!.reroutedInWeight).toBeCloseTo(1.0)
  })
})

describe('buildCashRebalancePlan (#452 Layer 3)', () => {
  const view = computeConditionalAllocation(baseInput()) // SGOV active 0.8

  const planInput = () => ({
    allocation: view,
    snapshots: {
      SGOV: { status: 'NG' as const, price: 100, heldQty: 0 },
      QQQ: { status: 'ENTRY' as const, price: 400, heldQty: 0 },
      TQQQ: { status: 'WATCH' as const, price: 60, heldQty: 0 },
      SOXL: { status: 'NG' as const, price: 30, heldQty: 0 },
    },
    budgetBasisJpy: 1_500_000,
    fxJpyPerCcy: ((ccy) => (ccy === 'JPY' ? 1 : 150)) as (
      ccy: 'USD' | 'JPY',
    ) => number | undefined,
    symbolCurrency: { SGOV: 'USD' as const },
    symbolLotSize: { SGOV: 1 } as Record<string, number>,
    symbolMaxNotional: {},
    maxOrderNotional: { USD: 1_000_000, JPY: 100_000_000 },
  })

  it('cash 側 (退避受入 / always_active) だけ BUY 計画になる', () => {
    const plan = buildCashRebalancePlan(planInput())
    // desired = 0.8 * 1.5M = 1.2M JPY = $8,000 → 80 株 @ $100。
    expect(plan.orders).toEqual([{ symbol: 'SGOV', quantity: 80, estimatedNotional: 8000 }])
  })

  it('保有が目標以上なら BUY しない (BUY-only、自動 SELL なし)', () => {
    const input = planInput()
    input.snapshots.SGOV = { status: 'NG', price: 100, heldQty: 90 } // $9,000 > $8,000
    const plan = buildCashRebalancePlan(input)
    expect(plan.orders).toEqual([])
    expect(plan.skipped.find((s) => s.symbol === 'SGOV')?.reason).toContain('BUY-only')
  })

  it('不足分だけ買う (差分 BUY)', () => {
    const input = planInput()
    input.snapshots.SGOV = { status: 'NG', price: 100, heldQty: 30 } // $3,000 → 残 $5,000
    const plan = buildCashRebalancePlan(input)
    expect(plan.orders[0]?.quantity).toBe(50)
  })

  it('lot 未設定 / price 無し / fx 無しは fail-closed で skip', () => {
    const noLot = planInput()
    noLot.symbolLotSize = {}
    expect(buildCashRebalancePlan(noLot).orders).toEqual([])

    const noSnap = planInput()
    delete (noSnap.snapshots as Record<string, unknown>).SGOV
    expect(buildCashRebalancePlan(noSnap).orders).toEqual([])

    const noFx = planInput()
    noFx.fxJpyPerCcy = () => undefined
    expect(buildCashRebalancePlan(noFx).orders).toEqual([])
  })

  it('1 注文上限 (symbol / global) で clamp する', () => {
    const input = planInput()
    input.symbolMaxNotional = { SGOV: 2000 } // $2,000 cap
    const plan = buildCashRebalancePlan(input)
    expect(plan.orders[0]?.quantity).toBe(20)
  })
})
