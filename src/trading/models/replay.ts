import type { DailyBar } from '../strategy/indicators'
import {
  computeMaxDrawdown,
  computeSharpe,
  runBacktest,
  type BacktestResult,
  type ExitReason,
} from '../backtest/runBacktest'
import { buildReplayStrategy, type StrategyModelSpec } from './strategyModel'

/** Bars runBacktest consumes before its first decision (its own `warmup`). */
const REPLAY_WARMUP_BARS = 60

/** Largest daily-bar window the bar clients serve (~5y). */
export const MAX_REPLAY_LOOKBACK_BARS = 1300

type ReplayCurrency = 'USD' | 'JPY'

function currencyOfReplaySymbol(symbol: string): ReplayCurrency {
  return /^\d/.test(symbol.trim()) ? 'JPY' : 'USD'
}

export interface ReplayMetrics {
  /**
   * Equal-weight return across symbols (each symbol starts at 1.0 of its own
   * cash). Summing raw P&L would add USD to JPY, so aggregation is done in
   * return space.
   */
  totalReturn: number
  sharpeRatio: number
  maxDrawdownPct: number
  totalTrades: number
  winRate: number
  /** sum(winning trade returns) / |sum(losing trade returns)|; null when there are no losing trades. */
  profitFactor: number | null
  /** Mean per-trade return (expectancy). 0 with no trades. */
  avgTradeReturn: number
  avgHoldingDays: number
  exitReasons: Record<ExitReason, number>
  pnlByCurrency: Record<ReplayCurrency, number>
}

interface ReplayEquityPoint {
  date: string
  /** Normalized equity (1.0 = starting cash). */
  equity: number
}

export interface ReplaySymbolResult {
  symbol: string
  barCount: number
  metrics: ReplayMetrics
}

export interface ReplayResult {
  metrics: ReplayMetrics
  perSymbol: ReplaySymbolResult[]
  equityCurve: ReplayEquityPoint[]
  /** Symbols dropped because no bars fell inside [from, to]. */
  skippedSymbols: string[]
}

export interface ReplayWindow {
  from: string
  to: string
  initialCashUsd: number
  initialCashJpy: number
}

/**
 * Bar count to request so the window reaches back to `from` plus warmup.
 * Bar clients count back from today, not from `to`, so the estimate must
 * span from `from` to today — sizing it on (from, to) alone silently
 * truncates a window that ended in the past.
 */
export function replayLookbackBars(fromYmd: string, today: Date): number {
  const from = Date.parse(`${fromYmd}T00:00:00.000Z`)
  const calendarDays = Math.max(1, Math.ceil((today.getTime() - from) / 86_400_000) + 1)
  return Math.ceil(calendarDays * (5 / 7)) + REPLAY_WARMUP_BARS + 20
}

/** `[from - warmup, to]` slice; null when no bar falls inside [from, to]. */
export function sliceReplayWindow(bars: DailyBar[], from: string, to: string): DailyBar[] | null {
  const upToTo = bars.filter((b) => b.date <= to)
  const liveStartIdx = upToTo.findIndex((b) => b.date >= from)
  if (liveStartIdx === -1) return null
  return upToTo.slice(Math.max(0, liveStartIdx - REPLAY_WARMUP_BARS))
}

export async function replayModel(
  spec: StrategyModelSpec,
  barsBySymbol: ReadonlyMap<string, DailyBar[]>,
  window: ReplayWindow,
): Promise<ReplayResult> {
  const { rule, strategy, atrBaselineMode } = buildReplayStrategy(spec)
  const perSymbol: Array<ReplaySymbolResult & { result: BacktestResult; initialCash: number }> = []
  const skippedSymbols: string[] = []

  for (const [symbol, bars] of barsBySymbol) {
    const sliced = sliceReplayWindow(bars, window.from, window.to)
    if (sliced === null) {
      skippedSymbols.push(symbol)
      continue
    }
    const currency = currencyOfReplaySymbol(symbol)
    const initialCash = currency === 'JPY' ? window.initialCashJpy : window.initialCashUsd
    const result = await runBacktest(sliced, {
      symbol,
      from: window.from,
      to: window.to,
      initialCash,
      rule,
      strategy,
      atrBaselineMode,
    })
    perSymbol.push({
      symbol,
      barCount: sliced.length,
      metrics: summarize([{ symbol, result, initialCash }]),
      result,
      initialCash,
    })
  }

  return {
    metrics: summarize(perSymbol),
    perSymbol: perSymbol.map(({ symbol, barCount, metrics }) => ({ symbol, barCount, metrics })),
    equityCurve: combineEquityCurves(perSymbol),
    skippedSymbols,
  }
}

function summarize(
  runs: ReadonlyArray<{ symbol: string; result: BacktestResult; initialCash: number }>,
): ReplayMetrics {
  const exitReasons: Record<ExitReason, number> = { TP: 0, STOP: 0, TIME_STOP: 0, END_OF_DATA: 0 }
  const pnlByCurrency: Record<ReplayCurrency, number> = { USD: 0, JPY: 0 }
  const tradeReturns: number[] = []
  let holdingDaysSum = 0

  for (const { symbol, result } of runs) {
    pnlByCurrency[currencyOfReplaySymbol(symbol)] += result.totalPnl
    for (const t of result.trades) {
      exitReasons[t.exitReason] += 1
      const cost = t.entryPrice * t.qty
      tradeReturns.push(cost > 0 ? t.realizedPnl / cost : 0)
      holdingDaysSum += t.holdingDays
    }
  }

  const wins = tradeReturns.filter((r) => r > 0)
  const losses = tradeReturns.filter((r) => r < 0)
  const winSum = wins.reduce((a, b) => a + b, 0)
  const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0))
  const curve = combineEquityCurves(runs)
  const equities = curve.map((p) => p.equity)
  const dailyReturns: number[] = []
  for (let i = 1; i < equities.length; i += 1) {
    const prev = equities[i - 1]!
    if (prev > 0) dailyReturns.push(equities[i]! / prev - 1)
  }

  return {
    totalReturn: equities.length > 0 ? equities[equities.length - 1]! - 1 : 0,
    sharpeRatio: computeSharpe(dailyReturns),
    maxDrawdownPct: computeMaxDrawdown(equities).maxDdPct,
    totalTrades: tradeReturns.length,
    winRate: tradeReturns.length > 0 ? wins.length / tradeReturns.length : 0,
    // null rather than Infinity: JSON.stringify turns Infinity into null
    // anyway, and the gate must treat "no losses yet" as unknown, not perfect.
    profitFactor: lossSum > 0 ? winSum / lossSum : null,
    avgTradeReturn:
      tradeReturns.length > 0 ? tradeReturns.reduce((a, b) => a + b, 0) / tradeReturns.length : 0,
    avgHoldingDays: tradeReturns.length > 0 ? holdingDaysSum / tradeReturns.length : 0,
    exitReasons,
    pnlByCurrency,
  }
}

/**
 * Equal-weight average of per-symbol normalized equity over the union of
 * trading dates. US and JP calendars differ, so a symbol without a bar on a
 * date carries its last value forward (1.0 before its first bar).
 */
function combineEquityCurves(
  runs: ReadonlyArray<{ result: BacktestResult; initialCash: number }>,
): ReplayEquityPoint[] {
  if (runs.length === 0) return []
  const dates = [...new Set(runs.flatMap((r) => r.result.equityCurve.map((p) => p.date)))].sort()
  const cursors = runs.map(() => 0)
  const last = runs.map(() => 1)
  return dates.map((date) => {
    let sum = 0
    runs.forEach((run, i) => {
      const curve = run.result.equityCurve
      while (cursors[i]! < curve.length && curve[cursors[i]!]!.date <= date) {
        last[i] = run.initialCash > 0 ? curve[cursors[i]!]!.equity / run.initialCash : 1
        cursors[i]! += 1
      }
      sum += last[i]!
    })
    return { date, equity: sum / runs.length }
  })
}
