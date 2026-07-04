import type { Env } from '../../../config/env'
import type { DailyBar } from '../../../trading/strategy/indicators'
import { YahooBarClient } from '../../../infrastructure/quotes/YahooBarClient'

/**
 * overview タブの equity curve に重ねるベンチマーク銘柄。
 * 現行 universe はレバレッジ NASDAQ 系 (TQQQ/SOXL 等) が主力なので、
 * 「市場に乗っているだけ」との比較対象は QQQ (NASDAQ-100 1x) が最も素直。
 */
export const EQUITY_BENCHMARK_SYMBOL = 'QQQ'

export interface BenchmarkPoint {
  /** YYYY-MM-DD (Yahoo daily bar の UTC 日付) */
  date: string
  /** 期間先頭 close を 0% とした騰落率 (%)。+5.2 = +5.2% */
  returnPct: number
}

/**
 * 日足 bars → 期間先頭 close を 0% 基準とした騰落率 % 系列 (pure)。
 *
 * equity curve は「累積 realized PnL ($)」でありシード資金額を持たないため、
 * ベンチマークを同じ $ 軸に載せることはできない。% 騰落率に正規化して
 * 右 y 軸に重ね、「傾き / 方向」の比較だけを意図する (絶対値の比較は不能)。
 * 不正 bar (close <= 0 / 非有限) は除外し、日付昇順に整えてから変換する。
 */
export function toBenchmarkReturns(bars: DailyBar[]): BenchmarkPoint[] {
  const valid = bars.filter((b) => typeof b.close === 'number' && Number.isFinite(b.close) && b.close > 0)
  if (valid.length === 0) return []
  const sorted = [...valid].sort((a, b) => a.date.localeCompare(b.date))
  const base = sorted[0]!.close
  return sorted.map((b) => ({ date: b.date, returnPct: (b.close / base - 1) * 100 }))
}

/**
 * ベンチマーク (QQQ) の騰落率系列を Yahoo 日足から取得する。
 *
 * - fetch は route (index.ts) 側から呼ぶ: `loadEquityCurve` は D1-pure を保ち、
 *   network 依存をここに隔離する。Yahoo 失敗は throw をそのまま伝播 →
 *   呼出元が `.catch(() => null)` で「series 省略 + 注記のみ」に落とす
 *   (既存の fail-graceful 方針)。
 * - `fromDate` (equity curve の先頭日) 以降の bar だけ残し、その先頭を 0% に。
 * - `env` は現状未使用 (YahooBarClient は無認証)。将来ベンチマーク銘柄や
 *   quote source を global_config で切り替える時の口として受けておく。
 */
export async function loadBenchmarkSeries(
  env: Env,
  fromDate: string,
  now: Date = new Date(),
): Promise<BenchmarkPoint[]> {
  void env
  const fromMs = new Date(`${fromDate}T00:00:00Z`).getTime()
  if (!Number.isFinite(fromMs)) return []
  // lookback は暦日差 + 余裕 5 日 (休場ずれ吸収)。YahooBarClient は正整数のみ
  // 受けるので下限 5、Yahoo range 上限 (5y) を考慮して 1830 日で clamp。
  const calendarDays = Math.ceil((now.getTime() - fromMs) / 86_400_000)
  const lookback = Math.min(Math.max(calendarDays + 5, 5), 1830)
  const bars = await new YahooBarClient().getDailyBars(EQUITY_BENCHMARK_SYMBOL, lookback)
  return toBenchmarkReturns(bars.filter((b) => b.date >= fromDate))
}
