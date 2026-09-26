import type { SymbolRole, SymbolRoleValue } from '../../infrastructure/db/symbolConfigRepo'
import {
  type MomentumRule,
  TEST_DEFAULT_MOMENTUM_RULE,
} from './strategies/BreakoutMomentumStrategy'
import type { SymbolRule } from './strategies/PullbackUptrendStrategy'

// Layering order: global default -> role preset -> per-symbol override. Each
// preset holds only its delta from the global default; `leveraged_trend` has
// none because the global default is already tuned for the core leveraged
// ETFs. Where a naive linear rescale of the leveraged default would stop a
// threshold from working as a gate (e.g. a deviation guard that would never
// fire), the value is picked to still function as that gate rather than
// preserve the ratio. Values are unvalidated initial estimates, not
// backtested; where uncertain they're biased toward fewer trades
// (fail-closed) and individual mismatches go through per-symbol override
// rather than a new preset.
export const ROLE_RULE_PRESETS: Partial<Record<SymbolRole, Partial<SymbolRule>>> = {
  leveraged_trend: {},
  core_trend: {
    minReturn50d: 0.03,
    pullbackMax: -0.015,
    pullbackMin: -0.05,
    maxSma50DeviationPct: 0.2,
  },
  // Unlike the other presets, this one also rescales the exit side: the
  // leveraged-tuned global stop/TP are wide enough that a real low-vol name
  // would rarely hit either. `timeStopDays` is the only field in any preset
  // that widens rather than tightens — low-vol mean-reversion resolves slower.
  low_volatility: {
    minReturn50d: 0.015,
    pullbackMax: -0.01,
    pullbackMin: -0.03,
    maxSma50DeviationPct: 0.1,
    maxAtrRatio: 1.3,
    stopPct: -0.015,
    takeProfitPct: 0.025,
    timeStopDays: 15,
  },
  // Entry side only; exit stays global (the leveraged stop still floors
  // sensibly here, and narrowing the diff limits overfit risk). Caution:
  // rule presets don't protect against sector concentration — SMH/SOXX
  // share an underlying with SOXL, so enabling both leveraged_trend and
  // sector_trend on correlated names is an allocation-layer concern, not
  // something this preset guards against.
  sector_trend: {
    minReturn50d: 0.04,
    pullbackMax: -0.02,
    pullbackMin: -0.05,
    maxSma50DeviationPct: 0.3,
  },
  // For inverse pullback-buying in a down regime. Daily-rebalance decay
  // compounds with holding time, so exit is deliberately fast. This preset
  // doesn't fit a 1x inverse (e.g. PSQ) — `minReturn50d` here would rarely
  // clear for an unleveraged name — so 1x symbols need a per-symbol override
  // rather than reusing this preset as-is.
  inverse_hedge: {
    minReturn50d: 0.15,
    maxSma50DeviationPct: 0.4,
    timeStopDays: 5,
    kAtr: 1.5,
  },
}

// `cash_parking` is excluded because pullback gating is meaningless for it
// (no SMA50/pullback concept applies); its allocation runs through the
// condition-linked `always_active` path instead. `unknown` (a DB value the
// repo couldn't normalize into the enum) is excluded too, so it suppresses
// entry rather than silently defaulting to enabled. `undefined` (role NULL)
// is always entry-enabled regardless of this set — legacy behavior.
const ENTRY_ENABLED_ROLES: ReadonlySet<SymbolRole> = new Set([
  'core_trend',
  'leveraged_trend',
  'low_volatility',
  'sector_trend',
  'inverse_hedge',
  'momentum',
])

export function buildHalfEntrySymbols(
  symbolRole: Record<string, SymbolRoleValue>,
): Set<string> {
  const enabled = new Set<string>()
  for (const [symbol, role] of Object.entries(symbolRole)) {
    // momentum is excluded: HALF's near-threshold tolerance works against a
    // breakout gate (falling short of the breakout is the wrong direction
    // for a partial entry).
    if (role === 'momentum') continue
    if (role !== 'unknown' && ENTRY_ENABLED_ROLES.has(role)) enabled.add(symbol)
  }
  return enabled
}

export function buildMomentumSymbols(symbolRole: Record<string, SymbolRoleValue>): Set<string> {
  const set = new Set<string>()
  for (const [symbol, role] of Object.entries(symbolRole)) {
    if (role === 'momentum') set.add(symbol)
  }
  return set
}

// Covers BUY generation only — SELL/HOLD (the exit path) is untouched, so a
// held position keeps its stop/time-stop/TP behavior even after its role
// changes to something entry-suppressed.
export function buildEntrySuppressedSymbols(
  symbolRole: Record<string, SymbolRoleValue>,
): Record<string, string> {
  const suppressed: Record<string, string> = {}
  for (const [symbol, role] of Object.entries(symbolRole)) {
    if (role !== 'unknown' && ENTRY_ENABLED_ROLES.has(role)) continue
    suppressed[symbol] =
      role === 'unknown'
        ? 'role: unknown role value in symbol_config (entry suppressed, fail-closed) (#452)'
        : `role: ${role} entry is not enabled (#452)`
  }
  return suppressed
}

export interface SymbolRuleOverrides {
  symbolTimeStopDaysOverride: Record<string, number>
  symbolKAtrOverride: Record<string, number>
  symbolStopPctOverride: Record<string, number>
  symbolTakeProfitPctOverride: Record<string, number>
  symbolRole: Record<string, SymbolRoleValue>
  symbolPullbackMaxOverride: Record<string, number>
  symbolPullbackMinOverride: Record<string, number>
  symbolMinReturn50dOverride: Record<string, number>
  symbolMaxAtrRatioOverride: Record<string, number>
  symbolMaxSma50DeviationPctOverride: Record<string, number>
  symbolRequireAboveSma50Override: Record<string, boolean>
}

// A symbol with no override in any layer and no role is left out of the
// returned map entirely, rather than added with `defaultRule`'s values, so
// callers that fall back to `defaultRule` for missing keys see zero change.
export function buildSymbolRules(
  defaultRule: SymbolRule,
  overrides: SymbolRuleOverrides,
): Record<string, SymbolRule> {
  const rulesMap: Record<string, SymbolRule> = {}
  const symbols = new Set<string>([
    ...Object.keys(overrides.symbolTimeStopDaysOverride),
    ...Object.keys(overrides.symbolKAtrOverride),
    ...Object.keys(overrides.symbolStopPctOverride),
    ...Object.keys(overrides.symbolTakeProfitPctOverride),
    ...Object.keys(overrides.symbolRole),
    ...Object.keys(overrides.symbolPullbackMaxOverride),
    ...Object.keys(overrides.symbolPullbackMinOverride),
    ...Object.keys(overrides.symbolMinReturn50dOverride),
    ...Object.keys(overrides.symbolMaxAtrRatioOverride),
    ...Object.keys(overrides.symbolMaxSma50DeviationPctOverride),
    ...Object.keys(overrides.symbolRequireAboveSma50Override),
  ])
  for (const sym of symbols) {
    const role = overrides.symbolRole[sym]
    const preset = role !== undefined && role !== 'unknown' ? ROLE_RULE_PRESETS[role] : undefined
    rulesMap[sym] = {
      ...defaultRule,
      ...(preset ?? {}),
      timeStopDays: overrides.symbolTimeStopDaysOverride[sym] ?? preset?.timeStopDays ?? defaultRule.timeStopDays,
      kAtr: overrides.symbolKAtrOverride[sym] ?? preset?.kAtr ?? defaultRule.kAtr,
      stopPct: overrides.symbolStopPctOverride[sym] ?? preset?.stopPct ?? defaultRule.stopPct,
      takeProfitPct:
        overrides.symbolTakeProfitPctOverride[sym] ?? preset?.takeProfitPct ?? defaultRule.takeProfitPct,
      pullbackMax:
        overrides.symbolPullbackMaxOverride[sym] ?? preset?.pullbackMax ?? defaultRule.pullbackMax,
      pullbackMin:
        overrides.symbolPullbackMinOverride[sym] ?? preset?.pullbackMin ?? defaultRule.pullbackMin,
      minReturn50d:
        overrides.symbolMinReturn50dOverride[sym] ?? preset?.minReturn50d ?? defaultRule.minReturn50d,
      maxAtrRatio:
        overrides.symbolMaxAtrRatioOverride[sym] ?? preset?.maxAtrRatio ?? defaultRule.maxAtrRatio,
      maxSma50DeviationPct:
        overrides.symbolMaxSma50DeviationPctOverride[sym] ??
        preset?.maxSma50DeviationPct ??
        defaultRule.maxSma50DeviationPct,
      requireAboveSma50:
        overrides.symbolRequireAboveSma50Override[sym] ??
        preset?.requireAboveSma50 ??
        defaultRule.requireAboveSma50,
    }
  }
  return rulesMap
}

// `breakoutBuffer` has no per-symbol override column, so it always stays at
// `base`'s value regardless of the other overrides applied here.
export function buildMomentumRules(
  overrides: SymbolRuleOverrides,
  base: MomentumRule = TEST_DEFAULT_MOMENTUM_RULE,
): Record<string, MomentumRule> {
  const rules: Record<string, MomentumRule> = {}
  for (const [sym, role] of Object.entries(overrides.symbolRole)) {
    if (role !== 'momentum') continue
    rules[sym] = {
      ...base,
      stopPct: overrides.symbolStopPctOverride[sym] ?? base.stopPct,
      takeProfitPct: overrides.symbolTakeProfitPctOverride[sym] ?? base.takeProfitPct,
      timeStopDays: overrides.symbolTimeStopDaysOverride[sym] ?? base.timeStopDays,
      kAtr: overrides.symbolKAtrOverride[sym] ?? base.kAtr,
      minReturn: overrides.symbolMinReturn50dOverride[sym] ?? base.minReturn,
      maxSma50DeviationPct:
        overrides.symbolMaxSma50DeviationPctOverride[sym] ?? base.maxSma50DeviationPct,
      requireAboveSma50: overrides.symbolRequireAboveSma50Override[sym] ?? base.requireAboveSma50,
    }
  }
  return rules
}
