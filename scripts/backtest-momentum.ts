/**
 * モメンタム(ブレイクアウト)戦略のオフライン・エッジ検証 (#momentum)。
 *
 * red-team が要求した「コードを書く前/載せた直後の安いキルスイッチ」。
 * 1x 銘柄の Yahoo 日足に対し BreakoutMomentumStrategy を回し、
 *   - 発火頻度 (trades 数) / 勝率 / 実現 R:R / 最大DD
 *   - 同じ銘柄で押し目戦略も回し、重複(同じ局面でしか勝たないか)の粗比較
 * を出す。**発注は一切しない**(オフライン backtest)。
 *
 * 注意:
 * - これは「エッジが存在するか」の一次判定。コスト(スプレッド+為替)は引いて
 *   いない粗リターン。コスト後で勝てるかは別途。
 * - 対象は OpenAPI 発注可否と無関係(過去データはオフラインで引ける)。SPY/QQQ 等
 *   発注不可銘柄も「エッジの有無」研究のため含める。
 *
 * Usage: pnpm tsx scripts/backtest-momentum.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { YahooBarClient } from '../src/infrastructure/quotes/YahooBarClient'
import { runBacktest, type BacktestResult } from '../src/trading/backtest/runBacktest'
import {
  BreakoutMomentumStrategy,
  TEST_DEFAULT_MOMENTUM_RULE,
} from '../src/trading/strategy/strategies/BreakoutMomentumStrategy'
import { TEST_DEFAULT_RULE } from '../src/trading/strategy/strategies/PullbackUptrendStrategy'

const SYMBOLS: ReadonlyArray<{ symbol: string; label: string; tradable: boolean }> = [
  { symbol: 'ICLN', label: 'ICLN クリーンエネ (発注可)', tradable: true },
  { symbol: 'TAN', label: 'TAN ソーラー (発注可)', tradable: true },
  { symbol: 'QCLN', label: 'QCLN クリーンエネ (発注可)', tradable: true },
  { symbol: 'SPY', label: 'SPY S&P500 (発注不可・研究用)', tradable: false },
  { symbol: 'QQQ', label: 'QQQ Nasdaq100 (発注不可・研究用)', tradable: false },
  { symbol: 'SMH', label: 'SMH 半導体 (発注不可・研究用)', tradable: false },
  { symbol: 'XLK', label: 'XLK テック (発注不可・研究用)', tradable: false },
]

const LOOKBACK_DAYS = 5 * 252
const INITIAL_CASH = 10_000

interface Row {
  symbol: string
  label: string
  tradable: boolean
  momentum: BacktestResult | null
  pullback: BacktestResult | null
}

function summarize(r: BacktestResult | null): string {
  if (!r) return 'n/a'
  const rr =
    r.avgLoss !== 0 ? Math.abs(r.avgWin / r.avgLoss).toFixed(2) : (r.avgWin > 0 ? '∞' : '0')
  return [
    `trades ${r.totalTrades}`,
    `勝率 ${(r.winRate * 100).toFixed(0)}%`,
    `R:R ${rr}`,
    `総%${(r.totalReturn * 100).toFixed(1)}`,
    `maxDD ${(r.maxDrawdownPct * 100).toFixed(1)}%`,
    `Sharpe ${r.sharpeRatio.toFixed(2)}`,
  ].join(' / ')
}

async function main() {
  const client = new YahooBarClient({ timeoutMs: 15_000 })
  const rows: Row[] = []

  for (const { symbol, label, tradable } of SYMBOLS) {
    process.stdout.write(`fetching ${symbol} ... `)
    let bars
    try {
      bars = await client.getDailyBars(symbol, LOOKBACK_DAYS)
    } catch (e) {
      console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`)
      rows.push({ symbol, label, tradable, momentum: null, pullback: null })
      continue
    }
    if (bars.length < 60) {
      console.log(`SKIP ${bars.length} bars`)
      rows.push({ symbol, label, tradable, momentum: null, pullback: null })
      continue
    }
    console.log(`${bars.length} bars (${bars[0]?.date}–${bars[bars.length - 1]?.date})`)
    const common = {
      symbol,
      from: bars[0]?.date ?? 'start',
      to: bars[bars.length - 1]?.date ?? 'end',
      initialCash: INITIAL_CASH,
      rule: TEST_DEFAULT_RULE,
    }
    const momentum = await runBacktest(bars, {
      ...common,
      strategy: new BreakoutMomentumStrategy(TEST_DEFAULT_MOMENTUM_RULE),
    })
    const pullback = await runBacktest(bars, common)
    rows.push({ symbol, label, tradable, momentum, pullback })
  }

  const lines: string[] = []
  lines.push('# Momentum (breakout) backtest — エッジ一次検証')
  lines.push('')
  lines.push('粗リターン(コスト/為替**控除前**)。発火頻度・勝率・R:R・maxDD の確認用。')
  lines.push('')
  for (const r of rows) {
    lines.push(`## ${r.label}${r.tradable ? '' : ' ※OpenAPI発注不可'}`)
    lines.push(`- モメンタム: ${summarize(r.momentum)}`)
    lines.push(`- 押し目    : ${summarize(r.pullback)}`)
    lines.push('')
  }
  const out = lines.join('\n')
  console.log('\n' + out)
  const reportPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'backtest-momentum-report.md')
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, out, 'utf8')
  console.log(`\nreport: ${reportPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
