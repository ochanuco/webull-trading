type SignalAction = 'BUY' | 'SELL' | 'HOLD'

type GeneratedAtIso = string

export interface DecisionTraceStep {
  label: string
  label_ja?: string
  passed: boolean
  actual?: number | string | boolean | null
  operator?: '<' | '<=' | '>' | '>=' | '==' | '!=' | 'between' | 'exists' | 'not_exists'
  threshold?: number | string | boolean | null | [number, number]
  message?: string
}

/**
 * Cause of a HOLD action. `guard` blocks HALF promotion outright (position /
 * pendingOrder / cooldown / re-entry price guard). `entry_gate` is a
 * candidate for HALF promotion. Undefined is treated as `guard` (fail-closed).
 */
export type HoldCause = 'guard' | 'entry_gate'

// Mirrors strategy/entryDistance.ts's EntryGateKey — domain can't import
// from strategy (layer violation), so this must be kept in sync by hand.
type EntryGateKey =
  | 'trend'
  | 'above_sma50'
  | 'overextension'
  | 'volatility'
  | 'high20d_valid'
  | 'pullback_shallow'
  | 'pullback_deep'

/** Mirrors strategy/entryDistance.ts's EntryGateStatus. */
interface EntryGateStatusSnapshot {
  key: EntryGateKey
  labelJa: string
  passed: boolean
  actual: number
  threshold: number
  operator: string
  priceDependent: boolean
}

/** Mirrors strategy/entryStatus.ts's EntryStatus. */
type EntryStatusLevel = 'ENTRY' | 'HALF' | 'WATCH' | 'NG'

/**
 * Snapshot of the 4-level entry gate evaluation, derived once in strategy
 * and carried on Signal so the scheduler doesn't re-derive it. Must stay
 * structurally assignable from strategy/entryStatus.ts's EntryStatusResult.
 */
export interface EntryStatusSnapshot {
  status: EntryStatusLevel
  /** ENTRY=1 / HALF=0.5 / WATCH,NG=0 — multiplies the sizing quantity. */
  positionMultiplier: number
  /** Failed gates, in evaluation order. */
  failedGates: EntryGateStatusSnapshot[]
  /** Gate that produced a HALF verdict; null for any other status. */
  halfGate: EntryGateStatusSnapshot | null
}

export interface Signal {
  action: SignalAction
  symbol: string
  quantity: number
  price: number
  reason: string
  generatedAtIso: GeneratedAtIso
  trace?: DecisionTraceStep[]
  /** Set only when action is HOLD. */
  holdCause?: HoldCause
  /**
   * Present when holdCause is 'entry_gate'. The scheduler uses this as-is
   * for HALF promotion rather than recomputing it.
   */
  entryStatus?: EntryStatusSnapshot
}
