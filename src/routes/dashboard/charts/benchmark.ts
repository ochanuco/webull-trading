import type { Env } from '../../../config/env'
import type { DailyBar } from '../../../trading/strategy/indicators'
import { YahooBarClient } from '../../../infrastructure/quotes/YahooBarClient'
import { cachedDashboardJson } from './dashboardBarsCache'

// QQQ: current universe is leveraged NASDAQ names (TQQQ/SOXL), so it's the
// plainest "just riding the market" comparison.
const EQUITY_BENCHMARK_SYMBOL = 'QQQ'

export interface BenchmarkPoint {
  /** YYYY-MM-DD (Yahoo daily bar's UTC date) */
  date: string
  /** Return vs. the period's first close, in %. +5.2 = +5.2% */
  returnPct: number
}

/**
 * Normalizes daily bars to % return from the first valid close — the equity
 * curve is cumulative $ PnL with no seed capital, so a benchmark can't share
 * its $ axis; only slope/direction is comparable.
 */
export function toBenchmarkReturns(bars: DailyBar[]): BenchmarkPoint[] {
  const valid = bars.filter((b) => typeof b.close === 'number' && Number.isFinite(b.close) && b.close > 0)
  if (valid.length === 0) return []
  const sorted = [...valid].sort((a, b) => a.date.localeCompare(b.date))
  const base = sorted[0]!.close
  return sorted.map((b) => ({ date: b.date, returnPct: (b.close / base - 1) * 100 }))
}

/**
 * Fetches the benchmark's % return series from Yahoo daily bars. Network
 * access lives here (not in the D1-pure equity loader) behind a short-TTL
 * dashboard-only cache separate from cron's own Yahoo calls, so this can't
 * affect trading data freshness. Callers catch failures and drop the series
 * rather than blocking the equity view.
 */
export async function loadBenchmarkSeries(
  env: Env,
  fromDate: string,
  now: Date = new Date(),
): Promise<BenchmarkPoint[]> {
  // Unused today (YahooBarClient needs no auth) — kept so a future
  // per-symbol benchmark or quote-source override has a place to plug in
  // without changing the signature.
  void env
  const fromMs = new Date(`${fromDate}T00:00:00Z`).getTime()
  if (!Number.isFinite(fromMs)) return []
  // +5 days absorbs market-holiday drift; clamp to YahooBarClient's
  // positive-integer input and its 5y range ceiling.
  const calendarDays = Math.ceil((now.getTime() - fromMs) / 86_400_000)
  const lookback = Math.min(Math.max(calendarDays + 5, 5), 1830)
  const bars = await cachedDashboardJson(
    'equityBenchmarkDaily',
    { symbol: EQUITY_BENCHMARK_SYMBOL, lookback: String(lookback) },
    () => new YahooBarClient().getDailyBars(EQUITY_BENCHMARK_SYMBOL, lookback),
    { shouldCache: (v) => v.length > 0 },
  )
  return toBenchmarkReturns(bars.filter((b) => b.date >= fromDate))
}
