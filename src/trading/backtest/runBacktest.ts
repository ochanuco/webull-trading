import { computePullbackIndicators, type DailyBar } from '../strategy/indicators'
import {
  PullbackUptrendStrategy,
  type SymbolRule,
} from '../strategy/strategies/PullbackUptrendStrategy'
import type { PositionState } from '../state/types'

/**
 * Offline backtest harness for PullbackUptrendStrategy。issue #198。
 *
 * 既存の `PullbackUptrendStrategy.decide()` を **そのまま** 呼ぶことで
 * live cron と同じ判定を再現する (= backtest と本番で divergence しない)。
 * Sizing / risk gate / pending-lock はバイパスし、純粋な entry / exit
 * 判定の収益性のみを評価する (POC で `pullback_default_*` を data-driven
 * に tuning するための tool)。
 *
 * 使い方:
 *   const bars = await yahoo.getDailyBars('AAPL', 300)  // warmup + live
 *   const result = await runBacktest(bars, params)
 *
 * `bars` は **oldest-first** で、最初の 50 本以上は warmup (SMA50 / ATR
 * 算出用) として消費される。それ以降の bar 各日でストラテジーを 1 tick
 * 進める。
 */

export interface BacktestParams {
  symbol: string
  /** ISO date "YYYY-MM-DD". 含まれる bar の最も古い日 (warmup 込み) を表現するメタ情報。 */
  from: string
  to: string
  /** 初期 cash (positions=0 起点)。BUY シグナル時に floor(cash/price) qty を発注。 */
  initialCash: number
  /** PullbackUptrendStrategy の rule。entry/exit 判定に使う。 */
  rule: SymbolRule
}

export type ExitReason = 'TP' | 'STOP' | 'TIME_STOP' | 'END_OF_DATA'

export interface BacktestTrade {
  entryTimestamp: string
  exitTimestamp: string
  entryPrice: number
  exitPrice: number
  qty: number
  realizedPnl: number
  exitReason: ExitReason
  /** Strategy が SELL 決定を出した理由 (TP/STOP/TIME_STOP) または END_OF_DATA。 */
  exitDetail: string
  holdingDays: number
}

export interface EquityPoint {
  date: string
  equity: number
  /** Peak-to-current drawdown (<=0). 0 ならピーク更新中。 */
  drawdown: number
}

export interface BacktestResult {
  params: BacktestParams
  trades: BacktestTrade[]
  totalPnl: number
  /** totalPnl / initialCash. initialCash<=0 なら 0。 */
  totalReturn: number
  /** 勝ち trade 数 / total trade 数. trades=0 なら 0。 */
  winRate: number
  avgWin: number
  avgLoss: number
  /** sum(wins) / |sum(losses)|. losses が 0 なら +Infinity (wins>0) または 0。 */
  profitFactor: number
  /** Daily equity returns ベース、252 営業日 annualized。equity 列が 1 以下なら 0。 */
  sharpeRatio: number
  /** Peak-to-trough の最大幅 (絶対金額、<=0)。 */
  maxDrawdown: number
  /** maxDrawdown / peak. peak<=0 なら 0。 */
  maxDrawdownPct: number
  totalTrades: number
  avgHoldingDays: number
  equityCurve: EquityPoint[]
}

const SECONDS_PER_DAY = 86_400_000

/**
 * Run the backtest synchronously over `bars`. Async signature is kept for
 * future extension (loading bars internally) but the implementation is pure.
 *
 * 仕様:
 * - 最初の 50 本は warmup (`computePullbackIndicators` が >=50 bars 必須)。
 * - それ以降の各 bar に対し:
 *   1. その bar までの直近 60 本で indicators を再計算
 *   2. PullbackUptrendStrategy.decide() を呼ぶ
 *   3. BUY → qty = floor(cash / close)、cash -= qty*close、position 開始
 *   4. SELL → cash += qty * close、trade を記録、position をクローズ
 *   5. 保有中なら equity = cash + qty * close、未保有なら equity = cash
 *   6. equity curve / drawdown を更新
 * - 期間末に position が残っていれば END_OF_DATA で強制クローズ。
 */
export async function runBacktest(
  bars: DailyBar[],
  params: BacktestParams,
): Promise<BacktestResult> {
  const trades: BacktestTrade[] = []
  const equityCurve: EquityPoint[] = []

  if (bars.length === 0) {
    return finalize(params, trades, equityCurve)
  }

  const strategy = new PullbackUptrendStrategy(params.rule)

  let cash = params.initialCash
  let position: PositionState | null = null
  let entryDate: string | null = null
  let peakEquity = params.initialCash

  // computePullbackIndicators requires >=50 bars. Walk forward starting at
  // index 50 so the first decision has a full warmup window.
  const warmup = 50

  for (let i = warmup; i < bars.length; i += 1) {
    // Use bars up to and including the current day for the indicator window.
    // Strategy "decides at close" — we use today's close as both signal price
    // and execution fill (T+0). Realistic enough for daily-bar offline eval;
    // intra-day slippage is out of scope.
    const window = bars.slice(Math.max(0, i + 1 - 60), i + 1)
    const indicators = computePullbackIndicators(window, null)
    const today = bars[i]!
    if (!indicators) {
      // Should not happen given warmup>=50, but bail safely.
      pushEquity(equityCurve, today.date, valueAt(cash, position, today.close), { peak: peakEquity })
      peakEquity = Math.max(peakEquity, valueAt(cash, position, today.close))
      continue
    }

    const now = new Date(`${today.date}T00:00:00.000Z`)
    const holdBusinessDays =
      position !== null && entryDate
        ? businessDaysBetween(entryDate, today.date)
        : 0

    const signal = strategy.decide({
      symbol: params.symbol,
      indicators,
      position,
      pendingOrder: null,
      cooldownUntil: null,
      holdBusinessDays,
      now,
    })

    if (signal.action === 'BUY' && position === null) {
      const price = today.close
      if (price > 0 && cash > 0) {
        const qty = Math.floor(cash / price)
        if (qty > 0) {
          cash -= qty * price
          position = {
            qty,
            avgPrice: price,
            openedAt: now.toISOString(),
          }
          entryDate = today.date
        }
      }
    } else if (signal.action === 'SELL' && position !== null) {
      const price = today.close
      const realizedPnl = (price - position.avgPrice) * position.qty
      cash += position.qty * price
      trades.push({
        entryTimestamp: position.openedAt,
        exitTimestamp: now.toISOString(),
        entryPrice: position.avgPrice,
        exitPrice: price,
        qty: position.qty,
        realizedPnl,
        exitReason: classifyExitReason(signal.reason),
        exitDetail: signal.reason,
        holdingDays: entryDate ? calendarDaysBetween(entryDate, today.date) : 0,
      })
      position = null
      entryDate = null
    }

    const eq = valueAt(cash, position, today.close)
    peakEquity = Math.max(peakEquity, eq)
    equityCurve.push({
      date: today.date,
      equity: eq,
      drawdown: peakEquity > 0 ? eq - peakEquity : 0,
    })
  }

  // Force-close any open position at the last close so realized PnL is
  // comparable across runs (otherwise totalPnl excludes the unrealized leg).
  if (position !== null && bars.length > 0) {
    const last = bars[bars.length - 1]!
    const price = last.close
    const realizedPnl = (price - position.avgPrice) * position.qty
    cash += position.qty * price
    trades.push({
      entryTimestamp: position.openedAt,
      exitTimestamp: new Date(`${last.date}T00:00:00.000Z`).toISOString(),
      entryPrice: position.avgPrice,
      exitPrice: price,
      qty: position.qty,
      realizedPnl,
      exitReason: 'END_OF_DATA',
      exitDetail: 'forced close at end of data',
      holdingDays: entryDate ? calendarDaysBetween(entryDate, last.date) : 0,
    })
    position = null
    entryDate = null
    // Refresh the last equity point to reflect the realized cash.
    if (equityCurve.length > 0) {
      const lastPoint = equityCurve[equityCurve.length - 1]!
      const newEq = cash
      peakEquity = Math.max(peakEquity, newEq)
      equityCurve[equityCurve.length - 1] = {
        date: lastPoint.date,
        equity: newEq,
        drawdown: peakEquity > 0 ? newEq - peakEquity : 0,
      }
    }
  }

  return finalize(params, trades, equityCurve)
}

/**
 * Annualized Sharpe ratio of a daily equity-return series.
 * Returns 0 when stddev is 0 or the input has fewer than 2 returns
 * (under-defined Sharpe — caller should treat this as "no signal" rather
 * than a strong neutral).
 */
export function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0
  let sum = 0
  for (const r of dailyReturns) sum += r
  const mean = sum / dailyReturns.length
  let sqSum = 0
  for (const r of dailyReturns) {
    const d = r - mean
    sqSum += d * d
  }
  const variance = sqSum / (dailyReturns.length - 1)
  const stdev = Math.sqrt(variance)
  if (stdev === 0 || !Number.isFinite(stdev)) return 0
  return (mean / stdev) * Math.sqrt(252)
}

/**
 * Compute peak-to-trough max drawdown of an equity curve.
 * `maxDd` is signed (<=0); `maxDdPct` is the same drawdown divided by the
 * peak that preceded it (e.g. -0.15 = 15% drawdown). Empty input → zeros.
 */
export function computeMaxDrawdown(
  equityCurve: number[],
): { maxDd: number; maxDdPct: number } {
  if (equityCurve.length === 0) return { maxDd: 0, maxDdPct: 0 }
  let peak = equityCurve[0]!
  let maxDd = 0
  let maxDdPct = 0
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq
    const dd = eq - peak
    if (dd < maxDd) {
      maxDd = dd
      maxDdPct = peak > 0 ? dd / peak : 0
    }
  }
  return { maxDd, maxDdPct }
}

function valueAt(cash: number, position: PositionState | null, price: number): number {
  if (position === null) return cash
  if (!Number.isFinite(price) || price <= 0) return cash + position.qty * position.avgPrice
  return cash + position.qty * price
}

function pushEquity(
  curve: EquityPoint[],
  date: string,
  equity: number,
  ctx: { peak: number },
): void {
  curve.push({
    date,
    equity,
    drawdown: ctx.peak > 0 ? equity - ctx.peak : 0,
  })
}

/**
 * Map the strategy's SELL reason text to a coarse exit category。
 * `decide()` の reason は `take-profit hit ...` / `stop-loss hit ...` /
 * `time-stop hit ...` 形式。startsWith で identify する (実装間結合は弱め)。
 */
function classifyExitReason(reason: string): ExitReason {
  if (reason.startsWith('take-profit')) return 'TP'
  if (reason.startsWith('stop-loss')) return 'STOP'
  if (reason.startsWith('time-stop')) return 'TIME_STOP'
  return 'END_OF_DATA'
}

function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00.000Z`)
  const b = Date.parse(`${toYmd}T00:00:00.000Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, Math.round((b - a) / SECONDS_PER_DAY))
}

/**
 * 簡易な営業日カウント (土日除外)。祝日は無視 (offline backtest 用途では
 * holiday カレンダーまで持つ overhead に見合わないため)。`PullbackUptrend
 * Strategy` の time-stop 判定は holdBusinessDays で動くので、ここでの近似
 * は exit timing に若干影響するが POC tuning には十分。
 */
function businessDaysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00.000Z`)
  const b = Date.parse(`${toYmd}T00:00:00.000Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0
  let count = 0
  for (let t = a + SECONDS_PER_DAY; t <= b; t += SECONDS_PER_DAY) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) count += 1
  }
  return count
}

function finalize(
  params: BacktestParams,
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
): BacktestResult {
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

  return {
    params,
    trades,
    totalPnl,
    totalReturn,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    sharpeRatio,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    totalTrades,
    avgHoldingDays: totalTrades > 0 ? totalHoldingDays / totalTrades : 0,
    equityCurve,
  }
}
