import { computeEntryDistance, type EntryDistance, type EntryGateStatus } from './entryDistance'
import type { PullbackIndicators, SymbolRule } from './strategies/PullbackUptrendStrategy'

/** ENTRY/HALF are order-eligible (multiplier > 0); WATCH/NG are display-only. */
export type EntryStatus = 'ENTRY' | 'HALF' | 'WATCH' | 'NG'

export interface EntryStatusResult {
  status: EntryStatus
  /** ENTRY=1 / HALF=0.5 / WATCH・NG=0; multiplies sizing. */
  positionMultiplier: number
  failedGates: EntryGateStatus[]
  /** The gate `HALF` was granted on; null unless `status` is `HALF`. */
  halfGate: EntryGateStatus | null
}

// volatility is deliberately excluded even though it's a continuous gate like
// the other two: it guards against ATR expansion on 3x leveraged ETFs, where
// gap/decay risk concentrates exactly when vol is elevated, so a near-miss
// there must stay WATCH rather than get a HALF pass.
const DEGREE_GATE_KEYS: ReadonlySet<string> = new Set([
  'pullback_shallow',
  'pullback_deep',
])

/** Excess allowed beyond a degree gate's threshold, as a fraction of |threshold|. */
const HALF_TOLERANCE_RATIO = 0.2

// threshold=0 degenerates the band to zero width, which withinHalfBand's
// `margin > 0` check rejects outright — a zero-depth pullback never gets HALF.
function withinHalfBand(gate: EntryGateStatus): boolean {
  const margin = Math.abs(gate.threshold) * HALF_TOLERANCE_RATIO
  if (!(margin > 0)) return false
  if (gate.operator === '<=') return gate.actual <= gate.threshold + margin
  if (gate.operator === '>=') return gate.actual >= gate.threshold - margin
  return false
}

export function deriveEntryStatus(distance: EntryDistance): EntryStatusResult {
  const failedGates = distance.gates.filter((g) => !g.passed)
  if (failedGates.length === 0) {
    return { status: 'ENTRY', positionMultiplier: 1, failedGates, halfGate: null }
  }
  if (failedGates.length === 1) {
    const gate = failedGates[0]!
    if (DEGREE_GATE_KEYS.has(gate.key) && withinHalfBand(gate)) {
      return { status: 'HALF', positionMultiplier: 0.5, failedGates, halfGate: gate }
    }
    return { status: 'WATCH', positionMultiplier: 0, failedGates, halfGate: null }
  }
  if (failedGates.length === 2) {
    return { status: 'WATCH', positionMultiplier: 0, failedGates, halfGate: null }
  }
  return { status: 'NG', positionMultiplier: 0, failedGates, halfGate: null }
}

export function deriveEntryStatusFromIndicators(
  indicators: PullbackIndicators,
  rule: SymbolRule,
): EntryStatusResult {
  return deriveEntryStatus(computeEntryDistance(indicators, rule))
}
