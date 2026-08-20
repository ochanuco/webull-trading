import { computeEntryDistance } from '../strategy/entryDistance'
import {
  computePullbackIndicators,
  type AtrBaselineMode,
  type DailyBar,
} from '../strategy/indicators'
import type { SymbolRule } from '../strategy/strategies/PullbackUptrendStrategy'
import { resolveStopDistance } from '../strategy/stopDistance'
import { estimateOrderCost, type TradeCostConfig } from '../domain/tradingCost'
import {
  businessDaysBetween,
  calendarDaysBetween,
  computeMaxDrawdown,
  computeSharpe,
  type ExitReason,
} from './runBacktest'

/**
 * Offline backtest harness for staged (probe → confirm → full) entry vs. the
 * current one-shot entry (issue #709 Phase 3), a partial-exit + ATR trailing
 * `ExitPolicy` axis on top of the same structure (issue #709 Phase 4), and a
 * `ReentryPolicy` axis gating the flat→open transition by exit reason (issue
 * #709 Phase 5). Bar-walk structure (warmup 60, `computePullbackIndicators`,
 * T+0 close fills) mirrors `runBacktest.ts`, but entry/exit are pluggable
 * `EntryPolicy`/`ExitPolicy` + a tranche-aware position model instead of a
 * single `PullbackUptrendStrategy.decide()` call.
 *
 * Entry gating reuses `computeEntryDistance` (not `PullbackUptrendStrategy`)
 * because the strategy's re-entry price guard needs `lastExitPrice` /
 * `businessDaysSinceExit`, which this offline harness — unlike `runBacktest`,
 * which also omits them — now tracks itself (`lastExit`, below) so the
 * `price-guard`/`reason-aware` `ReentryPolicy` kinds can replicate it.
 * `computeEntryDistance`'s 7-gate chain remains the setup-quality check with
 * no such guard, so it is still the correct equivalent of "current BUY
 * condition" when `reentryPolicy` is `'none'` (the default).
 */

export type EntryPolicy =
  | { kind: 'full' }
  | {
      kind: 'staged'
      /** Fraction (0..1) of `initialCash` targeted for each leg. Should sum to 1. */
      fractions: { probe: number; confirm: number; full: number }
      /** Consecutive eligible bars (incl. the probe bar itself) before the confirm leg fires. */
      confirmDays: number
    }

export type ExitPolicy =
  | { kind: 'preset' }
  | {
      kind: 'partial-trailing'
      /** Fraction (0..1) of the open qty sold when TP is first reached; the rest rides the trail. */
      tpFraction: number
      /** Trailing stop width in ATR units: highest close since entry minus `trailKAtr * atr20`. */
      trailKAtr: number
      /** Business-day time-stop extension while the trend gate chain still holds (0 = no extension). */
      timeStopExtensionDays: number
    }

/** `runBacktest`'s `ExitReason` plus the partial-trailing engine's trailing-stop exit. Kept as a
 * union widening (not a rename of `ExitReason`) so `runBacktest`'s own callers are untouched. Not
 * exported — callers of `evaluateReentry` only ever need to assign literal reason strings (e.g.
 * `'STOP'`), which are structurally compatible with `LastExitInfo.reason` without naming the type. */
type LifecycleExitReason = ExitReason | 'TRAIL'

/**
 * Re-entry gate for the flat→open transition (issue #709 Phase 5). `'none'` is the Phase 3/4
 * default (no gate — proven by the untouched regression suite). `'price-guard'` replicates the
 * live `PullbackUptrendStrategy` re-entry ceiling verbatim (see `evaluateReentry`).
 * `'reason-aware'` branches the gate by the *previous* exit's reason instead of applying the same
 * price ceiling to every exit kind (a STOP and a TP are different signals about whether the setup
 * is still good).
 */
export type ReentryPolicy =
  | { kind: 'none' }
  | { kind: 'price-guard' }
  | {
      kind: 'reason-aware'
      /** STOP exits only: business days below which re-entry is blocked outright, regardless of
       * trend state — a fresh stop-out needs a cooling-off period before "trend recaptured" is
       * even evaluated. */
      slWaitDays: number
    }

export interface LifecycleBacktestParams {
  symbol: string
  from: string
  to: string
  initialCash: number
  rule: SymbolRule
  atrBaselineMode?: AtrBaselineMode
  entryPolicy: EntryPolicy
  /** Defaults to `{kind:'preset'}` (all-quantity TP/stop/time-stop, issue #709 Phase 3 behavior)
   * so existing callers/tests built before Phase 4 keep compiling and behaving unchanged. */
  exitPolicy?: ExitPolicy
  /** Defaults to `{kind:'none'}` (no re-entry gate, issue #709 Phase 3/4 behavior) so existing
   * callers/tests built before Phase 5 keep compiling and behaving unchanged. */
  reentryPolicy?: ReentryPolicy
  feePctOfNotional: number
  feeFixedPerOrder: number
}

interface LifecycleEntryLeg {
  label: 'probe' | 'confirm' | 'full'
  date: string
  price: number
  qty: number
  /** Fraction of `initialCash` this leg targeted (may exceed the actual fill if cash-clamped). */
  fraction: number
  /** Fee estimate charged on this leg's fill. */
  cost: number
}

interface LifecycleExitLeg {
  /** 'partial_tp' = the TP-triggered partial sale in a `partial-trailing` round trip; 'final' =
   * the leg that actually emptied the position (== the whole exit for a `preset` round trip). */
  label: 'partial_tp' | 'final'
  date: string
  price: number
  qty: number
  /** Fee estimate charged on this leg's fill. */
  cost: number
}

interface LifecycleTrade {
  entryLegs: LifecycleEntryLeg[]
  entryTimestamp: string
  exitTimestamp: string
  /** Quantity-weighted average entry price across all legs. */
  entryPrice: number
  /** Quantity-weighted average price across all `exitLegs` (== the single leg's price for `preset`). */
  exitPrice: number
  qty: number
  /** Net of estimated round-trip cost (all entry legs + all exit legs). */
  realizedPnl: number
  /** Round-trip cost estimate (all entry legs + all exit legs) subtracted from `realizedPnl`. */
  cost: number
  exitReason: LifecycleExitReason
  exitDetail: string
  holdingDays: number
  /** Always non-empty. `preset` round trips have exactly one `'final'` leg; `partial-trailing`
   * round trips may additionally have a leading `'partial_tp'` leg. */
  exitLegs: LifecycleExitLeg[]
}

interface EquityPoint {
  date: string
  equity: number
  drawdown: number
}

export interface LifecycleBacktestResult {
  params: LifecycleBacktestParams
  trades: LifecycleTrade[]
  totalPnl: number
  totalReturn: number
  /** Annualized from totalReturn over the walked (post-warmup) bar count. */
  cagr: number
  winRate: number
  avgWin: number
  avgLoss: number
  /** Average net realizedPnl per trade (== totalPnl / totalTrades). */
  expectancy: number
  profitFactor: number
  sharpeRatio: number
  maxDrawdown: number
  maxDrawdownPct: number
  totalTrades: number
  avgHoldingDays: number
  /** (sum of all BUY-leg + SELL notional) / initialCash. */
  turnover: number
  totalCost: number
  equityCurve: EquityPoint[]
}

/** Internal open-position state. `qty === 0` cannot occur once non-null — a
 * fill that floors to 0 shares never creates or extends the position (see
 * `fillFraction`), and a partial-TP sale that would leave qty at 0 takes the
 * full-close branch instead (see the `partial-trailing` bar loop), so
 * `state !== null` always means real shares are held. */
interface OpenPosition {
  qty: number
  avgPrice: number
  entryDate: string
  entryTimestampIso: string
  legs: LifecycleEntryLeg[]
  probeStreak: number
  /** Highest close seen since the position first opened — tracked from the very first entry fill
   * (including any pre-partial-exit closes), not reset when a partial TP sale happens, since the
   * trail should reflect the whole run-up the position rode, not just the post-partial slice.
   * Unused by `preset`. */
  highestClose: number
  /** `partial-trailing` only: has the TP-triggered partial sale already happened this round trip?
   * Gates both "no repeat TP" and "trailing only engages after a partial exit". */
  partialTpDone: boolean
  /** Exit legs booked before the position fully closes (currently only the `partial_tp` leg).
   * `closePosition` appends the final leg and moves this into the trade record. */
  exitLegs: LifecycleExitLeg[]
  /** `partial-trailing` only: business-day time-stop threshold in effect right now (starts at
   * `rule.timeStopDays`, bumped once to `+ timeStopExtensionDays` if the trend gate chain holds). */
  timeStopDeadlineDays: number
  /** `partial-trailing` only: has the one-shot time-stop extension already been used? */
  timeStopExtended: boolean
}

const WARMUP = 60
/** 押し目系 gate。probe 判定ではこの 2 つだけ未成立を許容する。 */
const PULLBACK_GATE_KEYS: ReadonlySet<string> = new Set(['pullback_shallow', 'pullback_deep'])

export interface StagedEntryStepState {
  hasConfirmLeg: boolean
  probeStreak: number
  remainingFraction: number
}

export interface StagedEntryStep {
  action: 'fill_full' | 'fill_probe' | 'fill_confirm' | 'none'
  /** この bar 処理後の streak 値 (保有中のみ意味を持つ)。 */
  probeStreak: number
}

/**
 * 段階 entry の 1 bar 分の状態遷移 (pure)。ハーネス本体から切り出しているのは
 * eligibility の一過性 break (streak リセット) が実 bar からは再現しづらく
 * (ATR gate は 20-bar 窓で 20 本 sticky)、遷移表をここで直接テストするしか
 * ないため。cash / fill の副作用は呼び出し側 (`fillFraction`) に残す。
 */
export function nextStagedEntryStep(
  state: StagedEntryStepState | null,
  eligibility: { fullEligible: boolean; probeEligible: boolean },
  policy: Extract<EntryPolicy, { kind: 'staged' }>,
): StagedEntryStep {
  const { fullEligible, probeEligible } = eligibility
  if (state === null) {
    if (fullEligible) return { action: 'fill_full', probeStreak: 0 }
    if (probeEligible) return { action: 'fill_probe', probeStreak: 1 }
    return { action: 'none', probeStreak: 0 }
  }
  if (state.remainingFraction <= REMAINING_EPS) {
    return { action: 'none', probeStreak: state.probeStreak }
  }
  if (fullEligible) return { action: 'fill_full', probeStreak: state.probeStreak }
  if (state.hasConfirmLeg) return { action: 'none', probeStreak: state.probeStreak }
  if (probeEligible) {
    const streak = state.probeStreak + 1
    return streak >= policy.confirmDays && policy.fractions.confirm > 0
      ? { action: 'fill_confirm', probeStreak: streak }
      : { action: 'none', probeStreak: streak }
  }
  // eligible が途切れた bar で streak を捨てる — 「confirmDays 営業 bar 連続」
  // の定義どおり。捨てないと断続的な eligible の累計で confirm leg が発火する。
  return { action: 'none', probeStreak: 0 }
}
/** Below this, a leg's target fraction is treated as fully consumed — guards
 * against float noise (e.g. 0.1+0.2+0.7) reporting a nonzero remainder. */
const REMAINING_EPS = 1e-9

/** The exit the flat position is being re-entered *from* — `null` before the first ever exit. Not
 * exported — only referenced through the exported `ReentryEvalInput`/`runLifecycleBacktest`. */
interface LastExitInfo {
  price: number
  dateYmd: string
  reason: LifecycleExitReason
}

export interface ReentryEvalInput {
  policy: ReentryPolicy
  lastExit: LastExitInfo | null
  todayYmd: string
  /** Today's `indicators.price` (same field the price-dependent gates and pnl% math use). */
  price: number
  atr20: number
  rule: SymbolRule
  /** = 押し目系 gate 以外の全 gate 通過 (harness の `trendContinues`、hoisted once per bar). */
  trendContinues: boolean
  entryPolicyKind: EntryPolicy['kind']
}

export interface ReentryEvalResult {
  allowed: boolean
  /** Only ever `true` for `reason-aware` + `TIME_STOP` + `entryPolicyKind === 'staged'`: the
   * flat→open transition may only proceed as `fill_probe`, never `fill_full`, this bar. */
  probeOnly: boolean
}

/**
 * Re-entry gate for the flat→open transition (issue #709 Phase 5), evaluated once per bar right
 * before the harness would otherwise fire `fill_full`/`fill_probe` from `state === null`. Pure
 * (no bar-walk) so the STOP-wait / trend-recapture branches are table-testable directly.
 *
 * `price-guard` reproduces `PullbackUptrendStrategy.entryDecision`'s re-entry ceiling
 * (`lastExitPrice - reentryMinAtrBelowLastExit * atr20`, active while `businessDaysSinceExit <
 * reentryGuardBusinessDays`) verbatim, *except* the live strategy's `#660` legacy fail-closed
 * branch (guard window active but `lastExitPrice` unknown from a pre-migration DO state) — this
 * harness always knows `lastExit.price` once `lastExit` is non-null, so that branch has no
 * offline equivalent to replicate.
 */
export function evaluateReentry(input: ReentryEvalInput): ReentryEvalResult {
  const { policy, lastExit, todayYmd, price, atr20, rule, trendContinues, entryPolicyKind } = input
  const allow: ReentryEvalResult = { allowed: true, probeOnly: false }
  const block: ReentryEvalResult = { allowed: false, probeOnly: false }

  if (policy.kind === 'none' || lastExit === null) return allow

  const priceGuardAllows = (): boolean => {
    const windowConfigured = rule.reentryMinAtrBelowLastExit > 0 && rule.reentryGuardBusinessDays > 0
    if (!windowConfigured) return true
    const bd = businessDaysBetween(lastExit.dateYmd, todayYmd)
    if (bd >= rule.reentryGuardBusinessDays) return true
    // atr20 <= 0 disarms the live guard too (`reentryGuardActive` requires it finite and > 0) —
    // without it the ceiling itself is undefined, so fail-open rather than block on a NaN/negative
    // comparison.
    if (!(atr20 > 0)) return true
    const ceiling = lastExit.price - rule.reentryMinAtrBelowLastExit * atr20
    return price <= ceiling
  }

  if (policy.kind === 'price-guard') {
    return priceGuardAllows() ? allow : block
  }

  // reason-aware (policy.kind === 'reason-aware')
  switch (lastExit.reason) {
    case 'TP':
    case 'TRAIL':
      // Same "don't buy back the whipsaw" concern a good exit raises regardless of which engine
      // (preset TP or partial-trailing) produced it — reuse the live guard formula as-is.
      return priceGuardAllows() ? allow : block
    case 'STOP': {
      const bd = businessDaysBetween(lastExit.dateYmd, todayYmd)
      if (bd < policy.slWaitDays) return block
      return trendContinues ? allow : block
    }
    case 'TIME_STOP':
      if (!trendContinues) return block
      // Staged entry: force the first post-TIME_STOP fill down to a probe leg — a stall exit
      // isn't evidence the setup is bad (unlike STOP), but jumping straight back to a full
      // position on the very bar trend-continuation is recognized reintroduces the same
      // all-at-once risk the staged axis exists to avoid. Full-entry has no probe concept, so it
      // gets the trend-continuation condition alone.
      return entryPolicyKind === 'staged' ? { allowed: true, probeOnly: true } : allow
    case 'END_OF_DATA':
    default:
      // Unreachable in practice — END_OF_DATA only fires on the final bar, which has no
      // subsequent bar to re-evaluate entry on — but fail-open rather than block on an exit
      // reason this policy doesn't otherwise recognize.
      return allow
  }
}

export async function runLifecycleBacktest(
  bars: DailyBar[],
  params: LifecycleBacktestParams,
): Promise<LifecycleBacktestResult> {
  const trades: LifecycleTrade[] = []
  const equityCurve: EquityPoint[] = []

  if (bars.length === 0) {
    return finalize(params, trades, equityCurve, 0)
  }

  const rule = params.rule
  const exitPolicy: ExitPolicy = params.exitPolicy ?? { kind: 'preset' }
  const reentryPolicy: ReentryPolicy = params.reentryPolicy ?? { kind: 'none' }
  const feeConfig: TradeCostConfig = {
    feePctOfNotional: params.feePctOfNotional,
    feeFixedPerOrder: params.feeFixedPerOrder,
  }

  let cash = params.initialCash
  let state: OpenPosition | null = null
  let peakEquity = params.initialCash
  let totalCost = 0
  let turnoverNotional = 0
  // Survives across round trips (never cleared on a new entry — only ever overwritten by the
  // *next* closePosition call) because reentryPolicy needs the previous exit for the whole flat
  // window that follows it, not just the bar it happened on.
  let lastExit: LastExitInfo | null = null

  const investedFraction = (s: OpenPosition): number =>
    s.legs.reduce((sum, leg) => sum + leg.fraction, 0)
  const hasLeg = (s: OpenPosition, label: LifecycleEntryLeg['label']): boolean =>
    s.legs.some((leg) => leg.label === label)

  /**
   * Fill `fraction` of `initialCash` (clamped to available `cash` — a prior
   * round trip can leave `cash` below `initialCash`, and sizing legs off a
   * fixed `initialCash` target without this clamp could drive cash negative)
   * at `price`. Returns the position unchanged if the clamped amount floors
   * to 0 shares (leg omitted, no cash/state effect, per spec).
   */
  const fillFraction = (
    existing: OpenPosition | null,
    label: LifecycleEntryLeg['label'],
    fraction: number,
    today: DailyBar,
    nowIso: string,
  ): OpenPosition | null => {
    const price = today.close
    if (!(price > 0) || !(cash > 0)) return existing
    const amount = Math.max(0, Math.min(params.initialCash * fraction, cash))
    let qty = Math.floor(amount / price)
    let notional = qty * price
    let cost = estimateOrderCost(notional, feeConfig)
    // amount は cash でクランプ済みでも手数料は含まれていない — fee > 0 で
    // notional + cost が cash を超えると cash が負 (= 暗黙の借入) になり
    // equity / turnover / CAGR が全部過大評価される。手数料込みで収まるまで
    // 1 株ずつ落とす。
    while (qty > 0 && notional + cost > cash) {
      qty -= 1
      notional = qty * price
      cost = estimateOrderCost(notional, feeConfig)
    }
    if (qty <= 0) return existing
    cash -= notional + cost
    totalCost += cost
    turnoverNotional += notional
    const leg: LifecycleEntryLeg = { label, date: today.date, price, qty, fraction, cost }
    if (existing === null) {
      return {
        qty,
        avgPrice: price,
        entryDate: today.date,
        entryTimestampIso: nowIso,
        legs: [leg],
        probeStreak: label === 'probe' ? 1 : 0,
        highestClose: price,
        partialTpDone: false,
        exitLegs: [],
        timeStopDeadlineDays: rule.timeStopDays,
        timeStopExtended: false,
      }
    }
    const newQty = existing.qty + qty
    const newAvgPrice = (existing.avgPrice * existing.qty + price * qty) / newQty
    return { ...existing, qty: newQty, avgPrice: newAvgPrice, legs: [...existing.legs, leg] }
  }

  const closePosition = (
    s: OpenPosition,
    price: number,
    today: DailyBar,
    nowIso: string,
    reason: LifecycleExitReason,
    detail: string,
  ): void => {
    const exitNotional = s.qty * price
    const exitCost = estimateOrderCost(exitNotional, feeConfig)
    cash += exitNotional - exitCost
    totalCost += exitCost
    turnoverNotional += exitNotional
    const finalLeg: LifecycleExitLeg = {
      label: 'final',
      date: today.date,
      price,
      qty: s.qty,
      cost: exitCost,
    }
    // `s.exitLegs` is [] for every `preset` round trip (and for `partial-trailing`
    // round trips that never partially filled), so this degenerates to the single
    // `finalLeg` — same qty/price/cost the pre-Phase-4 code booked directly.
    const exitLegs = [...s.exitLegs, finalLeg]
    const legsCost = s.legs.reduce((sum, leg) => sum + leg.cost, 0)
    const exitLegsCost = exitLegs.reduce((sum, leg) => sum + leg.cost, 0)
    const exitQty = exitLegs.reduce((sum, leg) => sum + leg.qty, 0)
    const exitPrice = exitLegs.reduce((sum, leg) => sum + leg.qty * leg.price, 0) / exitQty
    const grossPnl = exitLegs.reduce((sum, leg) => sum + (leg.price - s.avgPrice) * leg.qty, 0)
    trades.push({
      entryLegs: s.legs,
      entryTimestamp: s.entryTimestampIso,
      exitTimestamp: nowIso,
      entryPrice: s.avgPrice,
      exitPrice,
      qty: exitQty,
      realizedPnl: grossPnl - legsCost - exitLegsCost,
      cost: legsCost + exitLegsCost,
      exitReason: reason,
      exitDetail: detail,
      holdingDays: calendarDaysBetween(s.entryDate, today.date),
      exitLegs,
    })
    // `price` here (the final leg's own fill, not the trade's qty-weighted `exitPrice`) matches
    // what the live guard keys off of — `lastExecutedPrice` is the SELL fill itself, and for a
    // partial-trailing round trip that's the final leg alone, not a blend with the earlier
    // partial-TP sale.
    lastExit = { price, dateYmd: today.date, reason }
  }

  /**
   * `partial-trailing` only: sell `qty` shares (< `s.qty`, caller-checked) at `price` without
   * closing the round trip. `s.avgPrice` is deliberately left untouched — the remaining shares
   * keep the original blended cost basis, so the hard-stop/TP checks on the residual position
   * stay correct without re-deriving a new average.
   */
  const applyPartialExit = (
    s: OpenPosition,
    qty: number,
    price: number,
    today: DailyBar,
  ): OpenPosition => {
    const notional = qty * price
    const cost = estimateOrderCost(notional, feeConfig)
    cash += notional - cost
    totalCost += cost
    turnoverNotional += notional
    const leg: LifecycleExitLeg = { label: 'partial_tp', date: today.date, price, qty, cost }
    return {
      ...s,
      qty: s.qty - qty,
      exitLegs: [...s.exitLegs, leg],
      partialTpDone: true,
    }
  }

  for (let i = WARMUP; i < bars.length; i += 1) {
    const window = bars.slice(Math.max(0, i + 1 - 60), i + 1)
    const indicators = computePullbackIndicators(window, null, {
      baselineMode: params.atrBaselineMode ?? 'percentile',
    })
    const today = bars[i]!
    if (!indicators) {
      pushEquity(equityCurve, today.date, valueAt(cash, state, today.close), peakEquity)
      peakEquity = Math.max(peakEquity, valueAt(cash, state, today.close))
      continue
    }

    const now = new Date(`${today.date}T00:00:00.000Z`)
    const nowIso = now.toISOString()

    let exitedThisBar = false

    // Hoisted above the exit check (Phase 3 only ran this inside `!exitedThisBar` below) because
    // Phase 4's `partial-trailing` time-stop extension needs the same trend-gate read the entry
    // side uses — computing it twice per bar would risk the two readings drifting apart.
    const distance = computeEntryDistance(indicators, rule)
    const fullEligible = distance.buyable
    // トレンド継続 = 押し目系以外の全 gate 通過 (gate 配列の並び順に依存させない
    // — entryDistance 側で gate が追加/並べ替えされたとき、probe 条件と
    // time-stop 延長条件が静かにズレる事故を防ぐ)。
    const trendContinues = distance.gates.every((g) => PULLBACK_GATE_KEYS.has(g.key) || g.passed)
    const probeEligible = !fullEligible && trendContinues

    if (state !== null) {
      if (exitPolicy.kind === 'preset') {
        const pnlPct = (indicators.price - state.avgPrice) / state.avgPrice
        if (pnlPct >= rule.takeProfitPct) {
          closePosition(
            state,
            indicators.price,
            today,
            nowIso,
            'TP',
            `take-profit hit: pnl ${pnlPct.toFixed(4)} >= ${rule.takeProfitPct}`,
          )
          state = null
          exitedThisBar = true
        } else {
          const stop = resolveStopDistance({
            price: state.avgPrice,
            stopPct: rule.stopPct,
            takeProfitPct: rule.takeProfitPct,
            atr20: indicators.atr20,
            kAtr: rule.kAtr,
            maxStopToTpRatio: rule.maxStopToTpRatio,
          })
          if (pnlPct <= stop.effectiveStopPct) {
            closePosition(
              state,
              indicators.price,
              today,
              nowIso,
              'STOP',
              `stop-loss hit: pnl ${pnlPct.toFixed(4)} <= ${stop.effectiveStopPct.toFixed(4)} (${stop.dominant}, dist ${stop.distance.toFixed(2)})`,
            )
            state = null
            exitedThisBar = true
          } else {
            const holdBusinessDays = businessDaysBetween(state.entryDate, today.date)
            if (holdBusinessDays >= rule.timeStopDays) {
              closePosition(
                state,
                indicators.price,
                today,
                nowIso,
                'TIME_STOP',
                `time-stop hit: held ${holdBusinessDays}d >= ${rule.timeStopDays}d`,
              )
              state = null
              exitedThisBar = true
            }
          }
        }
      } else {
        // partial-trailing (#709 Phase 4). Checked as a priority cascade (hard stop → TP-partial
        // → trailing → time-stop) against a local `pos` (rather than reassigning the outer `let
        // state` mid-cascade) — a partial TP sale doesn't end the round trip, so a later step in
        // the same cascade (trailing, time-stop) can still fire on the very bar the partial sale
        // happened, and threading a plain non-null local through each step keeps that easy to
        // follow without re-deriving `state !== null` at every step.
        let pos: OpenPosition = {
          ...state,
          highestClose: Math.max(state.highestClose, indicators.price),
        }
        const pnlPct = (indicators.price - pos.avgPrice) / pos.avgPrice
        let closed = false

        // 1. Hard stop — always sized off `avgPrice`, same basis pre- and post-partial-exit
        // (the residual shares keep the original blended cost, so this check doesn't need to
        // change when qty shrinks).
        const stop = resolveStopDistance({
          price: pos.avgPrice,
          stopPct: rule.stopPct,
          takeProfitPct: rule.takeProfitPct,
          atr20: indicators.atr20,
          kAtr: rule.kAtr,
          maxStopToTpRatio: rule.maxStopToTpRatio,
        })
        if (pnlPct <= stop.effectiveStopPct) {
          closePosition(
            pos,
            indicators.price,
            today,
            nowIso,
            'STOP',
            `stop-loss hit: pnl ${pnlPct.toFixed(4)} <= ${stop.effectiveStopPct.toFixed(4)} (${stop.dominant}, dist ${stop.distance.toFixed(2)})`,
          )
          closed = true
        }

        // 2. TP partial sale (once per round trip).
        if (!closed && !pos.partialTpDone && pnlPct >= rule.takeProfitPct) {
          const tpQty = Math.floor(pos.qty * exitPolicy.tpFraction)
          if (tpQty <= 0 || tpQty >= pos.qty) {
            // Floor collapsed the partial to nothing, or to the whole position — same fallback
            // as Phase 3 `preset`: take the full quantity off at TP instead of a 0-share leg.
            closePosition(
              pos,
              indicators.price,
              today,
              nowIso,
              'TP',
              `take-profit hit (full, tpFraction floor left no residual): pnl ${pnlPct.toFixed(4)} >= ${rule.takeProfitPct}`,
            )
            closed = true
          } else {
            pos = applyPartialExit(pos, tpQty, indicators.price, today)
          }
        }

        // 3. ATR trailing stop on the residual — only armed once a partial TP has actually fired.
        if (!closed && pos.partialTpDone) {
          const trailLevel = pos.highestClose - exitPolicy.trailKAtr * indicators.atr20
          if (indicators.price < trailLevel) {
            closePosition(
              pos,
              indicators.price,
              today,
              nowIso,
              'TRAIL',
              `trailing-stop hit: close ${indicators.price.toFixed(2)} < ${trailLevel.toFixed(2)} (high ${pos.highestClose.toFixed(2)} - ${exitPolicy.trailKAtr} * atr20 ${indicators.atr20.toFixed(2)})`,
            )
            closed = true
          }
        }

        // 4. Time-stop, with a one-shot extension while the trend gate chain still holds.
        if (!closed) {
          const holdBusinessDays = businessDaysBetween(pos.entryDate, today.date)
          if (holdBusinessDays >= pos.timeStopDeadlineDays) {
            if (!pos.timeStopExtended && exitPolicy.timeStopExtensionDays > 0 && trendContinues) {
              pos = {
                ...pos,
                timeStopDeadlineDays: rule.timeStopDays + exitPolicy.timeStopExtensionDays,
                timeStopExtended: true,
              }
            } else {
              closePosition(
                pos,
                indicators.price,
                today,
                nowIso,
                'TIME_STOP',
                `time-stop hit: held ${holdBusinessDays}d >= ${pos.timeStopDeadlineDays}d`,
              )
              closed = true
            }
          }
        }

        state = closed ? null : pos
      }
      exitedThisBar = state === null
    }

    // 部分利確が済んだ建玉には entry leg を追加しない — 利確で縮めた玉に段階
    // entry が積み増しで逆行すると、1 round trip の中で「出口方針」と「入口方針」
    // が矛盾し、比較指標 (保有期間・turnover) の解釈が壊れる。
    const entryFrozenAfterPartialExit = state !== null && state.partialTpDone
    if (!exitedThisBar && !entryFrozenAfterPartialExit) {
      // #reentry (issue #709 Phase 5): only gates the flat→open transition (`state === null`
      // right before the fill) — a staged position already open (fill_confirm, or a later
      // fill_full topping off an existing probe/confirm) isn't a "re-entry", so it runs
      // ungated exactly as Phase 3/4 did.
      const reentryAllows = (entryPolicyKind: EntryPolicy['kind']): ReentryEvalResult =>
        evaluateReentry({
          policy: reentryPolicy,
          lastExit,
          todayYmd: today.date,
          price: indicators.price,
          atr20: indicators.atr20,
          rule,
          trendContinues,
          entryPolicyKind,
        })

      if (params.entryPolicy.kind === 'full') {
        if (state === null && fullEligible && reentryAllows('full').allowed) {
          state = fillFraction(null, 'full', 1, today, nowIso)
        }
      } else {
        const { fractions } = params.entryPolicy
        const step = nextStagedEntryStep(
          state === null
            ? null
            : {
                hasConfirmLeg: hasLeg(state, 'confirm'),
                probeStreak: state.probeStreak,
                remainingFraction: 1 - investedFraction(state),
              },
          { fullEligible, probeEligible },
          params.entryPolicy,
        )
        if (state !== null) {
          const held: OpenPosition = state
          state = { ...held, probeStreak: step.probeStreak }
        }
        if (step.action === 'fill_full') {
          if (state === null) {
            const reentry = reentryAllows('staged')
            // `probeOnly` blocks fill_full specifically (TIME_STOP + staged demotion) — since
            // fullEligible/probeEligible are mutually exclusive per bar, this bar simply stays
            // flat rather than falling back to a probe fill; the harness waits for a later
            // probeEligible bar to actually re-enter.
            if (reentry.allowed && !reentry.probeOnly) {
              state = fillFraction(null, 'full', 1, today, nowIso)
            }
          } else {
            state = fillFraction(state, 'full', 1 - investedFraction(state), today, nowIso)
          }
        } else if (step.action === 'fill_probe') {
          if (reentryAllows('staged').allowed) {
            state = fillFraction(null, 'probe', fractions.probe, today, nowIso)
          }
        } else if (step.action === 'fill_confirm' && state !== null) {
          state = fillFraction(state, 'confirm', fractions.confirm, today, nowIso)
        }
      }
    }

    const eq = valueAt(cash, state, today.close)
    peakEquity = Math.max(peakEquity, eq)
    equityCurve.push({ date: today.date, equity: eq, drawdown: peakEquity > 0 ? eq - peakEquity : 0 })
  }

  if (state !== null && bars.length > 0) {
    const last = bars[bars.length - 1]!
    const nowIso = new Date(`${last.date}T00:00:00.000Z`).toISOString()
    closePosition(state, last.close, last, nowIso, 'END_OF_DATA', 'forced close at end of data')
    state = null
    if (equityCurve.length > 0) {
      const newEq = cash
      peakEquity = Math.max(peakEquity, newEq)
      const lastPoint = equityCurve[equityCurve.length - 1]!
      equityCurve[equityCurve.length - 1] = {
        date: lastPoint.date,
        equity: newEq,
        drawdown: peakEquity > 0 ? newEq - peakEquity : 0,
      }
    }
  }

  const liveBarCount = Math.max(0, bars.length - WARMUP)
  const result = finalize(params, trades, equityCurve, liveBarCount)
  return { ...result, turnover: params.initialCash > 0 ? turnoverNotional / params.initialCash : 0, totalCost }
}

function valueAt(cash: number, state: OpenPosition | null, price: number): number {
  if (state === null) return cash
  if (!Number.isFinite(price) || price <= 0) return cash + state.qty * state.avgPrice
  return cash + state.qty * price
}

function pushEquity(curve: EquityPoint[], date: string, equity: number, peak: number): void {
  curve.push({ date, equity, drawdown: peak > 0 ? equity - peak : 0 })
}

function finalize(
  params: LifecycleBacktestParams,
  trades: LifecycleTrade[],
  equityCurve: EquityPoint[],
  liveBarCount: number,
): LifecycleBacktestResult {
  const totalTrades = trades.length
  let wins = 0
  let losses = 0
  let sumWin = 0
  let sumLoss = 0
  let totalPnl = 0
  let totalHoldingDays = 0
  for (const t of trades) {
    totalPnl += t.realizedPnl
    totalHoldingDays += t.holdingDays
    if (t.realizedPnl > 0) {
      wins += 1
      sumWin += t.realizedPnl
    } else if (t.realizedPnl < 0) {
      losses += 1
      sumLoss += t.realizedPnl
    }
  }
  const totalReturn = params.initialCash > 0 ? totalPnl / params.initialCash : 0
  const winRate = totalTrades > 0 ? wins / totalTrades : 0
  const avgWin = wins > 0 ? sumWin / wins : 0
  const avgLoss = losses > 0 ? sumLoss / losses : 0
  const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0
  const profitFactor =
    sumLoss === 0 ? (sumWin > 0 ? Number.POSITIVE_INFINITY : 0) : sumWin / Math.abs(sumLoss)

  const equityValues = equityCurve.map((p) => p.equity)
  const dailyReturns: number[] = []
  for (let i = 1; i < equityValues.length; i += 1) {
    const prev = equityValues[i - 1]!
    const curr = equityValues[i]!
    if (prev > 0) dailyReturns.push((curr - prev) / prev)
  }
  const sharpeRatio = computeSharpe(dailyReturns)
  const { maxDd, maxDdPct } = computeMaxDrawdown(equityValues)

  // Guard: a base <= 0 (total wipeout or worse) makes `Math.pow` with a
  // fractional exponent return NaN — report -1 (100% loss) instead.
  const cagr =
    liveBarCount <= 0 ? 0 : 1 + totalReturn <= 0 ? -1 : (1 + totalReturn) ** (252 / liveBarCount) - 1

  return {
    params,
    trades,
    totalPnl,
    totalReturn,
    cagr,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    sharpeRatio,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    totalTrades,
    avgHoldingDays: totalTrades > 0 ? totalHoldingDays / totalTrades : 0,
    turnover: 0,
    totalCost: 0,
    equityCurve,
  }
}
