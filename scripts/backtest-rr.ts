/**
 * Run R:R 1.75 expectancy backtest against Yahoo daily bars and write a
 * report to `.local/backtest-rr-report.md` (issue #317).
 *
 * Inputs:
 *   - Default `SymbolRule` (post #318 — 20d filter + 10d hold, stopPct -4%, TP +7%)
 *   - Yahoo `/v8/finance/chart` daily bars over the last 5y for SOXL / SOXS / 1570
 *   - Initial cash $10_000 per symbol (independent backtests, not portfolio)
 *
 * Outputs:
 *   - stdout: per-symbol summary + aggregate table
 *   - `.local/backtest-rr-report.md`: full markdown report incl. exit_reason
 *     histogram, time_stop loss distribution stats, and realized R:R.
 *
 * Usage:
 *   pnpm tsx scripts/backtest-rr.ts
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { YahooBarClient } from '../src/infrastructure/quotes/YahooBarClient'
import { runBacktest, type BacktestResult, type ExitReason } from '../src/trading/backtest/runBacktest'
import { TEST_DEFAULT_RULE } from '../src/trading/strategy/strategies/PullbackUptrendStrategy'

const SYMBOLS: ReadonlyArray<{ symbol: string; label: string }> = [
  { symbol: 'SOXL', label: 'SOXL (3x semi long)' },
  { symbol: 'SOXS', label: 'SOXS (3x semi short)' },
  { symbol: '1570', label: '1570 (JP NEXT FUNDS NK 2x)' },
]

const LOOKBACK_DAYS = 5 * 252 // ~5y of trading days, fits Yahoo 5y window
const INITIAL_CASH = 10_000
const FROM_LABEL = 'last-5y'
const TO_LABEL = 'today'

interface PerSymbolStats {
  symbol: string
  label: string
  result: BacktestResult
  exitReasonCount: Record<ExitReason, number>
  exitReasonAvgPnl: Record<ExitReason, number>
  exitReasonHoldDays: Record<ExitReason, number>
  timeStopStats: { count: number; mean: number; median: number; std: number } | null
  expectancy: number
  realizedRR: number | null
}

async function main() {
  const client = new YahooBarClient({ timeoutMs: 15_000 })
  const perSymbol: PerSymbolStats[] = []

  for (const { symbol, label } of SYMBOLS) {
    process.stdout.write(`fetching ${symbol} (lookback=${LOOKBACK_DAYS}) ... `)
    let bars
    try {
      bars = await client.getDailyBars(symbol, LOOKBACK_DAYS)
    } catch (err) {
      console.warn(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    if (bars.length < 60) {
      console.warn(`SKIP: only ${bars.length} bars (need >=60 for warmup)`)
      continue
    }
    console.log(`got ${bars.length} bars (${bars[0]?.date}–${bars[bars.length - 1]?.date})`)

    const result = await runBacktest(bars, {
      symbol,
      from: bars[0]?.date ?? FROM_LABEL,
      to: bars[bars.length - 1]?.date ?? TO_LABEL,
      initialCash: INITIAL_CASH,
      rule: TEST_DEFAULT_RULE,
    })

    perSymbol.push(makeStats(symbol, label, result))
  }

  const report = renderReport(perSymbol)
  console.log('\n' + report)

  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = join(here, '..', '.local', 'backtest-rr-report.md')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, report, 'utf8')
  console.log(`\nReport saved to ${outPath}`)
}

function makeStats(symbol: string, label: string, result: BacktestResult): PerSymbolStats {
  const exitReasonCount: Record<ExitReason, number> = { TP: 0, STOP: 0, TIME_STOP: 0, END_OF_DATA: 0 }
  const exitReasonPnlSum: Record<ExitReason, number> = { TP: 0, STOP: 0, TIME_STOP: 0, END_OF_DATA: 0 }
  const exitReasonHoldSum: Record<ExitReason, number> = { TP: 0, STOP: 0, TIME_STOP: 0, END_OF_DATA: 0 }
  const timeStopPnls: number[] = []

  for (const t of result.trades) {
    exitReasonCount[t.exitReason] += 1
    exitReasonPnlSum[t.exitReason] += t.realizedPnl
    exitReasonHoldSum[t.exitReason] += t.holdingDays
    if (t.exitReason === 'TIME_STOP') timeStopPnls.push(t.realizedPnl)
  }

  const exitReasonAvgPnl = mapAvg(exitReasonPnlSum, exitReasonCount)
  const exitReasonHoldDays = mapAvg(exitReasonHoldSum, exitReasonCount)

  const timeStopStats = timeStopPnls.length > 0
    ? {
        count: timeStopPnls.length,
        mean: mean(timeStopPnls),
        median: median(timeStopPnls),
        std: std(timeStopPnls),
      }
    : null

  const expectancy = result.winRate * result.avgWin + (1 - result.winRate) * result.avgLoss
  const realizedRR = result.avgLoss !== 0 ? result.avgWin / Math.abs(result.avgLoss) : null

  return { symbol, label, result, exitReasonCount, exitReasonAvgPnl, exitReasonHoldDays, timeStopStats, expectancy, realizedRR }
}

function mapAvg(sum: Record<ExitReason, number>, count: Record<ExitReason, number>): Record<ExitReason, number> {
  return {
    TP: count.TP > 0 ? sum.TP / count.TP : 0,
    STOP: count.STOP > 0 ? sum.STOP / count.STOP : 0,
    TIME_STOP: count.TIME_STOP > 0 ? sum.TIME_STOP / count.TIME_STOP : 0,
    END_OF_DATA: count.END_OF_DATA > 0 ? sum.END_OF_DATA / count.END_OF_DATA : 0,
  }
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  let sq = 0
  for (const v of arr) sq += (v - m) * (v - m)
  return Math.sqrt(sq / (arr.length - 1))
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`
}

function money(x: number): string {
  const sign = x < 0 ? '-' : ''
  return `${sign}$${Math.abs(x).toFixed(2)}`
}

function renderReport(stats: PerSymbolStats[]): string {
  const lines: string[] = []
  lines.push('# Backtest report — R:R 1.75 expectancy (issue #317)')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Setup')
  lines.push('')
  lines.push(`- Rule (post #318): stopPct=${TEST_DEFAULT_RULE.stopPct}, takeProfitPct=${TEST_DEFAULT_RULE.takeProfitPct}, timeStopDays=${TEST_DEFAULT_RULE.timeStopDays}, minReturn (20d)=${TEST_DEFAULT_RULE.minReturn50d}, pullback=[${TEST_DEFAULT_RULE.pullbackMin}, ${TEST_DEFAULT_RULE.pullbackMax}], kAtr=${TEST_DEFAULT_RULE.kAtr}`)
  lines.push(`- Theoretical R:R: ${(TEST_DEFAULT_RULE.takeProfitPct / Math.abs(TEST_DEFAULT_RULE.stopPct)).toFixed(2)} = ${TEST_DEFAULT_RULE.takeProfitPct} / |${TEST_DEFAULT_RULE.stopPct}|`)
  lines.push(`- Initial cash per symbol: $${INITIAL_CASH}`)
  lines.push(`- Bars source: Yahoo Finance \`/v8/finance/chart\` (last 5y, daily)`)
  lines.push(`- Backtest engine: \`src/trading/backtest/runBacktest.ts\``)
  lines.push('')
  lines.push('## Aggregate')
  lines.push('')
  lines.push('| symbol | trades | win | avg_win | avg_loss | realized R:R | expectancy / trade | total_pnl | total_return | sharpe | maxDD% |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')

  for (const s of stats) {
    const r = s.result
    lines.push(
      `| ${s.symbol} | ${r.totalTrades} | ${pct(r.winRate)} | ${money(r.avgWin)} | ${money(r.avgLoss)} | ${s.realizedRR !== null ? s.realizedRR.toFixed(2) : '—'} | ${money(s.expectancy)} | ${money(r.totalPnl)} | ${pct(r.totalReturn)} | ${r.sharpeRatio.toFixed(2)} | ${pct(r.maxDrawdownPct)} |`,
    )
  }

  lines.push('')
  lines.push('## Exit-reason distribution (per symbol)')
  lines.push('')
  lines.push('| symbol | TP n / avg | STOP n / avg | TIME_STOP n / avg | END_OF_DATA n / avg |')
  lines.push('|---|---|---|---|---|')
  for (const s of stats) {
    lines.push(
      `| ${s.symbol} | ${s.exitReasonCount.TP} / ${money(s.exitReasonAvgPnl.TP)} | ${s.exitReasonCount.STOP} / ${money(s.exitReasonAvgPnl.STOP)} | ${s.exitReasonCount.TIME_STOP} / ${money(s.exitReasonAvgPnl.TIME_STOP)} | ${s.exitReasonCount.END_OF_DATA} / ${money(s.exitReasonAvgPnl.END_OF_DATA)} |`,
    )
  }

  lines.push('')
  lines.push('## TIME_STOP exit PnL distribution')
  lines.push('')
  lines.push('| symbol | n | mean | median | stdev |')
  lines.push('|---|---|---|---|---|')
  for (const s of stats) {
    if (!s.timeStopStats) {
      lines.push(`| ${s.symbol} | 0 | — | — | — |`)
      continue
    }
    const t = s.timeStopStats
    lines.push(`| ${s.symbol} | ${t.count} | ${money(t.mean)} | ${money(t.median)} | ${money(t.std)} |`)
  }

  lines.push('')
  lines.push('## Average holding days by exit reason')
  lines.push('')
  lines.push('| symbol | TP days | STOP days | TIME_STOP days | END_OF_DATA days |')
  lines.push('|---|---|---|---|---|')
  for (const s of stats) {
    lines.push(
      `| ${s.symbol} | ${s.exitReasonHoldDays.TP.toFixed(1)} | ${s.exitReasonHoldDays.STOP.toFixed(1)} | ${s.exitReasonHoldDays.TIME_STOP.toFixed(1)} | ${s.exitReasonHoldDays.END_OF_DATA.toFixed(1)} |`,
    )
  }

  lines.push('')
  lines.push('## Per-symbol detail')
  lines.push('')
  for (const s of stats) {
    const r = s.result
    lines.push(`### ${s.symbol} — ${s.label}`)
    lines.push(`- Period: ${r.params.from} → ${r.params.to}`)
    lines.push(`- Trades: ${r.totalTrades}, win rate: ${pct(r.winRate)}, profit factor: ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}`)
    lines.push(`- Avg holding: ${r.avgHoldingDays.toFixed(1)} days`)
    lines.push(`- TIME_STOP exits: ${s.exitReasonCount.TIME_STOP} (${pct(r.totalTrades > 0 ? s.exitReasonCount.TIME_STOP / r.totalTrades : 0)} of trades)`)
    lines.push(`- TIME_STOP avg PnL: ${money(s.exitReasonAvgPnl.TIME_STOP)}`)
    lines.push('')
  }

  lines.push('## Interpretation')
  lines.push('')
  lines.push('- **R:R theoretical = 1.75** (= 0.07 / 0.04). The "realized R:R" column is `avg_win / |avg_loss|` from actually-taken exits; it can drift from theoretical because TP/STOP intra-bar fills clip the realized magnitude (always close at the bar that crossed the trigger).')
  lines.push('- **TIME_STOP mean PnL** indicates whether the time-out exits are pulling expectancy down. If `TIME_STOP mean` is significantly negative (e.g. < -1.5%), the 10d hold is too short / signal too weak. If it\'s near zero or positive, the time-stop is doing its job.')
  lines.push('- **Expectancy / trade** is the bottom line. Negative expectancy with positive R:R means win rate is too low to compensate.')
  lines.push('')
  return lines.join('\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
