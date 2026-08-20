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
 * current one-shot entry (issue #709 Phase 3). Bar-walk structure (warmup 60,
 * `computePullbackIndicators`, T+0 close fills) mirrors `runBacktest.ts`, but
 * the entry side is a pluggable `EntryPolicy` + tranche-aware position model
 * instead of a single `PullbackUptrendStrategy.decide()` call — Phase 4 will
 * add an `ExitPolicy` axis on top of this same structure (today: 'preset' only).
 *
 * Entry gating reuses `computeEntryDistance` (not `PullbackUptrendStrategy`)
 * because the strategy's re-entry price guard needs `lastExitPrice` /
 * `businessDaysSinceExit`, which this offline harness — like `runBacktest`,
 * which also omits them — does not track per symbol. `computeEntryDistance`'s
 * 7-gate chain is the setup-quality check with no such guard, so it is the
 * correct equivalent of "current BUY condition" here.
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

export interface LifecycleBacktestParams {
  symbol: string
  from: string
  to: string
  initialCash: number
  rule: SymbolRule
  atrBaselineMode?: AtrBaselineMode
  entryPolicy: EntryPolicy
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

interface LifecycleTrade {
  entryLegs: LifecycleEntryLeg[]
  entryTimestamp: string
  exitTimestamp: string
  /** Quantity-weighted average entry price across all legs. */
  entryPrice: number
  exitPrice: number
  qty: number
  /** Net of estimated round-trip cost (all entry legs + exit). */
  realizedPnl: number
  /** Round-trip cost estimate (all entry legs + exit) subtracted from `realizedPnl`. */
  cost: number
  exitReason: ExitReason
  exitDetail: string
  holdingDays: number
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
 * `fillFraction`), so `state !== null` always means real shares are held. */
interface OpenPosition {
  qty: number
  avgPrice: number
  entryDate: string
  entryTimestampIso: string
  legs: LifecycleEntryLeg[]
  probeStreak: number
}

const WARMUP = 60
/** Below this, a leg's target fraction is treated as fully consumed — guards
 * against float noise (e.g. 0.1+0.2+0.7) reporting a nonzero remainder. */
const REMAINING_EPS = 1e-9

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
  const feeConfig: TradeCostConfig = {
    feePctOfNotional: params.feePctOfNotional,
    feeFixedPerOrder: params.feeFixedPerOrder,
  }

  let cash = params.initialCash
  let state: OpenPosition | null = null
  let peakEquity = params.initialCash
  let totalCost = 0
  let turnoverNotional = 0

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
    const qty = Math.floor(amount / price)
    if (qty <= 0) return existing
    const notional = qty * price
    const cost = estimateOrderCost(notional, feeConfig)
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
    reason: ExitReason,
    detail: string,
  ): void => {
    const exitNotional = s.qty * price
    const exitCost = estimateOrderCost(exitNotional, feeConfig)
    cash += exitNotional - exitCost
    totalCost += exitCost
    turnoverNotional += exitNotional
    const legsCost = s.legs.reduce((sum, leg) => sum + leg.cost, 0)
    const grossPnl = (price - s.avgPrice) * s.qty
    trades.push({
      entryLegs: s.legs,
      entryTimestamp: s.entryTimestampIso,
      exitTimestamp: nowIso,
      entryPrice: s.avgPrice,
      exitPrice: price,
      qty: s.qty,
      realizedPnl: grossPnl - legsCost - exitCost,
      cost: legsCost + exitCost,
      exitReason: reason,
      exitDetail: detail,
      holdingDays: calendarDaysBetween(s.entryDate, today.date),
    })
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

    if (state !== null) {
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
    }

    if (!exitedThisBar) {
      const distance = computeEntryDistance(indicators, rule)
      const fullEligible = distance.buyable
      const probeEligible =
        !fullEligible && distance.gates.slice(0, 5).every((g) => g.passed)

      if (params.entryPolicy.kind === 'full') {
        if (state === null && fullEligible) {
          state = fillFraction(null, 'full', 1, today, nowIso)
        }
      } else {
        const { fractions, confirmDays } = params.entryPolicy
        if (state === null) {
          if (fullEligible) {
            state = fillFraction(null, 'full', 1, today, nowIso)
          } else if (probeEligible) {
            state = fillFraction(null, 'probe', fractions.probe, today, nowIso)
          }
        } else {
          const remaining = 1 - investedFraction(state)
          if (remaining > REMAINING_EPS) {
            if (fullEligible) {
              state = fillFraction(state, 'full', remaining, today, nowIso)
            } else if (!hasLeg(state, 'confirm') && probeEligible) {
              const bumped: OpenPosition = { ...state, probeStreak: state.probeStreak + 1 }
              state =
                bumped.probeStreak >= confirmDays && fractions.confirm > 0
                  ? fillFraction(bumped, 'confirm', fractions.confirm, today, nowIso)
                  : bumped
            }
          }
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
