import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import type { EntryStatus } from './entryStatus'

// Treats `budget_alloc_pct` as a target weight and links the active weight
// to entry gating: `always_active` symbols stay at target regardless of
// entry status; `entry_required` symbols drop to active=0 while WATCH/NG/
// unevaluated, and reroute the freed weight into their cash-fallback
// symbol(s); everything else stays at target (unchanged legacy behavior).
//
// Reroute only crosses symbols of the same currency — a currency mismatch
// is skipped rather than converted, so this never auto-reroutes across an
// FX boundary.
//
// This module only computes the target view; it is pure. Whether that view
// actually places cash-fallback orders is gated separately in
// runStrategyCron by `global_config.cash_fallback_orders_enabled` (off by
// default) — with it off, this is display/decision-log only.

interface ConditionalAllocationPolicy {
  entryRequired: ReadonlySet<string>
  alwaysActive: ReadonlySet<string>
  /** symbol -> cash-fallback targets; more than one splits the reroute evenly. */
  cashFallback: Record<string, string[]>
}

export interface AllocationComputeInput {
  /** symbol -> target weight, fraction 0<w<=1 (`budget_alloc_pct`). */
  targetWeights: Record<string, number>
  policy: ConditionalAllocationPolicy
  /** A symbol absent here is treated as not entry-eligible (fail-closed). */
  entryStatuses: Record<string, EntryStatus>
  heldSymbols: ReadonlySet<string>
  /** symbol -> currency, for the reroute's same-currency check; absent defaults to USD. */
  symbolCurrency: Record<string, SymbolCurrency>
  /**
   * Bidirectional inverse-pair map. A pair shares one reroute slot: if both
   * legs are simultaneously not entry-eligible, only one reroutes; if the
   * partner is holding a position or is itself entry-eligible, this leg
   * doesn't reroute at all. Omitting it preserves pre-pairing behavior.
   */
  inversePairs?: Record<string, string>
}

export interface SymbolAllocation {
  symbol: string
  targetWeight: number
  /** Post-gating active weight, including any reroute received. */
  activeWeight: number
  /** Symbol(s) this allocation's weight was rerouted to; undefined if not rerouted. */
  rerouteTo?: string[]
  reason: string
  /** Weight received via reroute from other symbols; > 0 only for a reroute target. */
  reroutedInWeight: number
}

export interface AllocationView {
  bySymbol: Record<string, SymbolAllocation>
}

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
      alloc.reason = '保有中: 配分は使用中 (exit は stop / time-stop / TP が管理)'
      continue
    }
    const status = input.entryStatuses[symbol]
    if (isEntryEligible(status)) {
      alloc.reason = `entry 判定 ${status}: 配分有効`
      continue
    }
    alloc.activeWeight = 0
    const statusLabel = status ?? '評価データ無し'
    const fallbacks = input.policy.cashFallback[symbol]
    if (fallbacks === undefined || fallbacks.length === 0) {
      alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 (退避先未設定 → 現金のまま)`
      continue
    }
    const ownCurrency = input.symbolCurrency[symbol] ?? 'USD'
    const validFallbacks = fallbacks.filter(
      (fb) => (input.symbolCurrency[fb] ?? 'USD') === ownCurrency,
    )
    if (validFallbacks.length === 0) {
      alloc.reason = `entry 判定 ${statusLabel}: 実配分 0 (退避先 ${fallbacks.join('/')} と通貨不一致 → 現金のまま)`
      continue
    }
    // Which leg gets the shared slot when both are ineligible depends on
    // object key iteration order (the one processed first reroutes; this
    // one sees the partner's rerouteTo already set and stops).
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
    alloc.rerouteTo = validFallbacks
    const slice = target / fallbacks.length
    alloc.reason =
      fallbacks.length === 1
        ? `entry 判定 ${statusLabel}: 実配分 0 → ${validFallbacks[0]} へ退避`
        : `entry 判定 ${statusLabel}: 実配分 0 → ${validFallbacks.join('/')} へ等分割で退避 (各 1/${fallbacks.length})`
    for (const fb of validFallbacks) {
      const fallbackAlloc = ensure(fb, input.targetWeights[fb] ?? 0)
      fallbackAlloc.activeWeight += slice
      fallbackAlloc.reroutedInWeight += slice
      if (fallbackAlloc.reason === '') {
        fallbackAlloc.reason = '退避受入のみ (自身の target なし)'
      }
    }
  }
  return { bySymbol }
}

/** Per-symbol observation collected from pass 1's scheduler summary in runStrategyCron. */
export interface EntrySnapshot {
  status: EntryStatus
  price: number
  heldQty: number
}

export interface CashRebalancePlanInput {
  allocation: AllocationView
  snapshots: Record<string, EntrySnapshot>
  /** Total account value in JPY (`total_capital_jpy`). */
  budgetBasisJpy: number
  /** Resolves a symbol's currency to a JPY rate (JPY=1, USD=USD/JPY); undefined on failure. */
  fxJpyPerCcy: (currency: SymbolCurrency) => number | undefined
  symbolCurrency: Record<string, SymbolCurrency>
  /** symbol -> lot size; a missing entry fails closed (excluded from the plan). */
  symbolLotSize: Record<string, number>
  /** symbol -> per-order notional cap (`symbol_config.max_notional`). */
  symbolMaxNotional: Record<string, number>
  /** Per-currency global per-order cap. */
  maxOrderNotional: Record<SymbolCurrency, number>
}

export interface CashRebalanceOrder {
  symbol: string
  quantity: number
  /** Estimated notional in the symbol's currency; recomputed at execution time. */
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

// Converts a shortfall against target weight into a BUY quantity for
// cash-fallback / always_active symbols only. The SELL side (trimming a
// reroute target back down when its source re-enters) is a separate
// function, buildCashFallbackSellPlan.
export function buildCashRebalancePlan(input: CashRebalancePlanInput): CashRebalancePlan {
  const orders: CashRebalanceOrder[] = []
  const skipped: CashRebalanceSkip[] = []
  for (const alloc of Object.values(input.allocation.bySymbol)) {
    // Only the cash side (reroute recipient, or always_active with a
    // target) buys here — an ordinary entry_required/legacy symbol's slot
    // is filled by the pullback strategy path instead.
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
      skipped.push({ symbol, reason: 'already at/above active weight' })
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

export interface CashFallbackSellPlanInput extends CashRebalancePlanInput {
  /** symbol (reroute source) -> its fallback targets; same shape as `policy.cashFallback`. */
  cashFallback: Record<string, string[]>
  /**
   * Reroute sources with fund demand this tick (holding a position, or pass
   * 1 attempted a BUY), as assembled by runStrategyCron from the pass-1
   * summary.
   */
  demandSources: ReadonlySet<string>
  /** Tolerance band before a fallback symbol is considered overweight, as a fraction of target. Default 0.10. */
  overweightBand?: number
}

export interface CashFallbackSellPlan {
  orders: CashRebalanceOrder[]
  skipped: CashRebalanceSkip[]
}

const DEFAULT_OVERWEIGHT_BAND = 0.10

// Selling whenever a fallback symbol is simply over its active weight would
// drain its cash the moment a source's BUY is gate-rejected (spread/lot/
// buying-power) even though the source still needs it next tick — a
// whipsaw. Gating on `demandSources` limits the sell to ticks where a
// source actually has somewhere to put the proceeds. The overweight band
// then excludes excess caused purely by the fallback symbol's own price
// gain — harvesting unrealized gains under a rebalance pretext isn't the
// intent; its own exit rules handle that. And only the excess over active
// weight is sold, not a full close, so this doesn't fight the fallback
// symbol's own stop/TP/time-stop exit.
export function buildCashFallbackSellPlan(input: CashFallbackSellPlanInput): CashFallbackSellPlan {
  const orders: CashRebalanceOrder[] = []
  const skipped: CashRebalanceSkip[] = []
  const band = input.overweightBand ?? DEFAULT_OVERWEIGHT_BAND

  // Only symbols that appear as someone's fallback target are candidates —
  // an always_active-only symbol has no reroute to trim on price drift alone.
  const candidates = new Set<string>()
  for (const targets of Object.values(input.cashFallback)) {
    for (const target of targets) candidates.add(target)
  }

  for (const symbol of candidates) {
    const snapshot = input.snapshots[symbol]
    if (!snapshot) {
      skipped.push({ symbol, reason: 'no fresh price snapshot (fail-closed)' })
      continue
    }
    if (snapshot.heldQty <= 0) continue
    if (!Number.isFinite(snapshot.price) || snapshot.price <= 0) {
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
    const desiredJpy = (input.allocation.bySymbol[symbol]?.activeWeight ?? 0) * input.budgetBasisJpy
    const currentJpy = snapshot.heldQty * snapshot.price * fx
    if (currentJpy <= desiredJpy * (1 + band)) {
      skipped.push({ symbol, reason: 'within active weight band' })
      continue
    }
    const sources = Object.entries(input.cashFallback)
      .filter(([, targets]) => targets.includes(symbol))
      .map(([source]) => source)
    if (!sources.some((source) => input.demandSources.has(source))) {
      skipped.push({ symbol, reason: 'no demand from reroute sources' })
      continue
    }
    const capCcy = Math.min(
      input.symbolMaxNotional[symbol] ?? Number.POSITIVE_INFINITY,
      input.maxOrderNotional[currency],
    )
    const excessCcy = Math.min((currentJpy - desiredJpy) / fx, capCcy)
    const quantity = Math.min(
      Math.floor(excessCcy / snapshot.price / lot) * lot,
      snapshot.heldQty,
    )
    if (quantity < lot) {
      skipped.push({ symbol, reason: `excess below 1 lot (excess ${Math.round(excessCcy)} ${currency})` })
      continue
    }
    orders.push({ symbol, quantity, estimatedNotional: quantity * snapshot.price })
  }
  return { orders, skipped }
}
