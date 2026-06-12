import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import type { EntryStatus } from './entryStatus'

/**
 * 条件連動配分 (#452 Layer 3 / #450)。`budget_alloc_pct` を **target weight
 * (目標配分)** として扱い、実配分 (active weight) を entry 判定に連動させる:
 *
 *   - `always_active` (cash_parking 用): 常時 active = target
 *   - `entry_required`: ENTRY / HALF (発注対象) か建玉保有中のみ active = target。
 *     未通過 (WATCH / NG / 評価データ無し) は active = 0 で、浮いた分は
 *     `cash_fallback_symbol` の active に積み増す (退避)
 *   - どちらでもない: 従来どおり常時 active = target (挙動変更なし)
 *
 * 退避は**同一通貨間のみ** — 通貨が異なる退避先は skip して現金のまま
 * (fail-closed: 為替を跨ぐ自動退避はしない)。建玉保有中の銘柄は entry gate が
 * 新規 entry 用の条件なので退避しない (exit は stop / time-stop / TP が管理)。
 *
 * このモジュールは**計算のみ** (pure)。退避先への自動発注は
 * `global_config.cash_fallback_orders_enabled` (default false) が on の時だけ
 * runStrategyCron が別途行う。off の間は判定・表示のみ。
 */

export interface ConditionalAllocationPolicy {
  /** entry_required=true の集合。 */
  entryRequired: ReadonlySet<string>
  /** always_active=true の集合。 */
  alwaysActive: ReadonlySet<string>
  /** symbol → 退避先 symbol。 */
  cashFallback: Record<string, string>
}

export interface AllocationComputeInput {
  /** symbol → target weight (fraction 0<w<=1、budget_alloc_pct)。 */
  targetWeights: Record<string, number>
  policy: ConditionalAllocationPolicy
  /** symbol → 最新の段階判定。評価できなかった銘柄は不在 (= 未通過扱い、fail-closed)。 */
  entryStatuses: Record<string, EntryStatus>
  /** 建玉保有中 (qty > 0) の symbol 集合。 */
  heldSymbols: ReadonlySet<string>
  /** symbol → 通貨。退避の同一通貨チェックに使う (不在は 'USD' 扱い)。 */
  symbolCurrency: Record<string, SymbolCurrency>
  /**
   * インバース対 (両方向 map)。対は **1 枠を共有**する (#315) ため、退避の
   * 二重流出を抑止するのに使う (#452 follow-up): 両側が同時に未通過のとき
   * 退避できるのは片側分のみ、相方が枠を使用中 (保有 or 判定通過) のときは
   * 退避自体しない。未指定は従来挙動 (対を知らない)。
   */
  inversePairs?: Record<string, string>
}

export interface SymbolAllocation {
  symbol: string
  /** 設定上の目標配分 (budget_alloc_pct)。 */
  targetWeight: number
  /** 判定連動後の実配分。退避受入分を含む。 */
  activeWeight: number
  /** 自銘柄の枠が退避された先 (退避なしは undefined)。 */
  rerouteTo?: string
  /** 退避 / 据え置きの理由 (操作者向け)。 */
  reason: string
  /** 他銘柄から退避で受け入れた weight 合計 (退避先のみ > 0)。 */
  reroutedInWeight: number
}

export interface AllocationView {
  /** target weight を持つ銘柄 + 退避を受けた銘柄。 */
  bySymbol: Record<string, SymbolAllocation>
}

/** 発注対象になる段階判定 (#452 PR 2 と同義: ENTRY / HALF のみ)。 */
function isEntryEligible(status: EntryStatus | undefined): boolean {
  return status === 'ENTRY' || status === 'HALF'
}

export function computeConditionalAllocation(input: AllocationComputeInput): AllocationView {
  const bySymbol: Record<string, SymbolAllocation> = {}
  const ensure = (symbol: string, targetWeight: number): SymbolAllocation => {
    bySymbol[symbol] ??= {
      symbol,
      targetWeight,
      activeWeight: targetWeight,
      reason: '',
      reroutedInWeight: 0,
    }
    return bySymbol[symbol]!
  }

  for (const [symbol, target] of Object.entries(input.targetWeights)) {
    if (!Number.isFinite(target) || target <= 0) continue
    const alloc = ensure(symbol, target)
    if (input.policy.alwaysActive.has(symbol)) {
      alloc.reason = 'always_active: 常時配分対象'
      continue
    }
    if (!input.policy.entryRequired.has(symbol)) {
      alloc.reason = '従来挙動 (entry_required off): 常時枠有効'
      continue
    }
    if (input.heldSymbols.has(symbol)) {
      alloc.reason = '建玉保有中: 配分は使用中 (exit は stop / time-stop / TP が管理)'
      continue
    }
    const status = input.entryStatuses[symbol]
    if (isEntryEligible(status)) {
      alloc.reason = `entry 判定 ${status}: 配分有効`
      continue
    }
    // 未通過 (WATCH / NG / 評価不能) → 実配分 0。退避先があり同一通貨なら積み増す。
    alloc.activeWeight = 0
    const statusLabel = status ?? '評価データ無し'
    const fallback = input.policy.cashFallback[symbol]
    if (fallback === undefined) {
      alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 (退避先未設定 → 現金のまま)`
      continue
    }
    const ownCurrency = input.symbolCurrency[symbol] ?? 'USD'
    const fallbackCurrency = input.symbolCurrency[fallback] ?? 'USD'
    if (ownCurrency !== fallbackCurrency) {
      alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 (退避先 ${fallback} と通貨不一致 → 現金のまま)`
      continue
    }
    // 対の枠は 1 つ (#315): 相方が枠を使用中 (保有 or 判定通過) なら退避しない。
    // 両側とも未通過なら退避できるのは片側分のみ — 先頭 (Object.entries の
    // 反復順で先に処理された側) が退避済みなら、こちらは枠なしとして止める。
    const partner = input.inversePairs?.[symbol]
    if (partner !== undefined) {
      const partnerHeld = input.heldSymbols.has(partner)
      const partnerEligible = isEntryEligible(input.entryStatuses[partner])
      if (partnerHeld || partnerEligible) {
        alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 (対の枠は ${partner} が使用中 → 退避なし)`
        continue
      }
      const partnerAlloc = bySymbol[partner]
      if (partnerAlloc !== undefined && partnerAlloc.rerouteTo !== undefined) {
        alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 (対の枠は ${partner} 側から退避済み → 二重退避なし)`
        continue
      }
    }
    alloc.rerouteTo = fallback
    alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 → ${fallback} へ退避`
    const fallbackAlloc = ensure(fallback, input.targetWeights[fallback] ?? 0)
    fallbackAlloc.activeWeight += target
    fallbackAlloc.reroutedInWeight += target
    if (fallbackAlloc.reason === '') {
      fallbackAlloc.reason = '退避受入のみ (自身の target なし)'
    }
  }
  return { bySymbol }
}

/** runStrategyCron が pass 1 の scheduler summary から集める per-symbol 観測値。 */
export interface EntrySnapshot {
  status: EntryStatus
  /** 評価時の価格 (intraday or daily close)。 */
  price: number
  /** 建玉数量 (未保有は 0)。 */
  heldQty: number
}

export interface CashRebalancePlanInput {
  allocation: AllocationView
  snapshots: Record<string, EntrySnapshot>
  /** 口座総額 (JPY、total_capital_jpy)。 */
  budgetBasisJpy: number
  /** symbol 通貨 → JPY レート resolver (JPY=1、USD=USD/JPY)。取得失敗は undefined。 */
  fxJpyPerCcy: (currency: SymbolCurrency) => number | undefined
  symbolCurrency: Record<string, SymbolCurrency>
  /** symbol → lot size。不在は fail-closed (発注計画から除外)。 */
  symbolLotSize: Record<string, number>
  /** symbol → 1 注文 notional 上限 (symbol_config.max_notional)。 */
  symbolMaxNotional: Record<string, number>
  /** 通貨別 global 1 注文上限。 */
  maxOrderNotional: Record<SymbolCurrency, number>
}

export interface CashRebalanceOrder {
  symbol: string
  quantity: number
  /** 概算 notional (symbol 通貨)。実際の execution では再計算される。 */
  estimatedNotional: number
}

export interface CashRebalanceSkip {
  symbol: string
  reason: string
}

export interface CashRebalancePlan {
  orders: CashRebalanceOrder[]
  skipped: CashRebalanceSkip[]
}

/**
 * cash fallback / always_active 銘柄の「目標配分に対する不足分」を BUY 数量に
 * 落とす (#452 Layer 3)。**BUY-only**: 退避元が再 entry して active が縮んでも
 * 退避先を自動 SELL はしない (待機資金の取り崩しは operator 判断 — 後続 issue)。
 *
 * fail-closed 系: price / lot / fx が無い銘柄は発注計画に入れない。上限は
 * min(差分, symbol max_notional, 通貨別 global max_order_notional) を lot に
 * floor する。
 */
export function buildCashRebalancePlan(input: CashRebalancePlanInput): CashRebalancePlan {
  const orders: CashRebalanceOrder[] = []
  const skipped: CashRebalanceSkip[] = []
  for (const alloc of Object.values(input.allocation.bySymbol)) {
    // 発注対象は「退避を受けた or always_active で target を持つ」cash 側のみ。
    // 通常の entry_required / 従来挙動銘柄の枠は pullback 戦略経路が使う。
    if (alloc.activeWeight <= 0) continue
    if (alloc.reroutedInWeight <= 0 && !alloc.reason.startsWith('always_active')) continue
    const symbol = alloc.symbol
    const snapshot = input.snapshots[symbol]
    if (!snapshot || !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
      skipped.push({ symbol, reason: 'no fresh price snapshot (fail-closed)' })
      continue
    }
    const currency = input.symbolCurrency[symbol] ?? 'USD'
    const fx = input.fxJpyPerCcy(currency)
    if (fx === undefined || !Number.isFinite(fx) || fx <= 0) {
      skipped.push({ symbol, reason: `fx unavailable for ${currency} (fail-closed)` })
      continue
    }
    const lot = input.symbolLotSize[symbol]
    if (lot === undefined || !Number.isInteger(lot) || lot < 1) {
      skipped.push({ symbol, reason: 'lot_size not configured (fail-closed)' })
      continue
    }
    const desiredJpy = alloc.activeWeight * input.budgetBasisJpy
    const currentJpy = snapshot.heldQty * snapshot.price * fx
    const deltaJpy = desiredJpy - currentJpy
    if (deltaJpy <= 0) {
      skipped.push({ symbol, reason: 'already at/above active weight (BUY-only, no auto-sell)' })
      continue
    }
    const capCcy = Math.min(
      input.symbolMaxNotional[symbol] ?? Number.POSITIVE_INFINITY,
      input.maxOrderNotional[currency],
    )
    const deltaCcy = Math.min(deltaJpy / fx, capCcy)
    const quantity = Math.floor(deltaCcy / snapshot.price / lot) * lot
    if (quantity < lot) {
      skipped.push({ symbol, reason: `delta below 1 lot (delta ${Math.round(deltaCcy)} ${currency})` })
      continue
    }
    orders.push({ symbol, quantity, estimatedNotional: quantity * snapshot.price })
  }
  return { orders, skipped }
}
