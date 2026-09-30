import { esc, fmtNumber, safeJsonScript } from '../shared'
import { type ChartsBodyQuality, type QualityPeriod, ECHARTS_CDN, QUALITY_PERIOD_LABELS } from './shared'

/** Per-trade realized PnL — one row per SELL fill (`realized_pnl` is null on BUY rows). */
export interface TradePnlRow {
  realizedPnl: number
  symbol: string
  /** ISO timestamp (trade_journal.timestamp, assumed UTC). */
  timestamp: string
}

export async function loadTradePnls(db: D1Database): Promise<TradePnlRow[]> {
  const result = await db
    .prepare(
      `SELECT realized_pnl AS pnl, symbol, timestamp
       FROM trade_journal
       WHERE realized_pnl IS NOT NULL
         AND trade_event_type = 'post_submit'
       ORDER BY id ASC`,
    )
    .all<{ pnl: number; symbol: string | null; timestamp: string }>()
  const rows: TradePnlRow[] = []
  for (const r of result.results ?? []) {
    const realizedPnl = Number(r.pnl)
    if (!Number.isFinite(realizedPnl) || !r.symbol) continue
    rows.push({ realizedPnl, symbol: r.symbol, timestamp: r.timestamp })
  }
  return rows
}

const PERIOD_DAYS: Record<'30d' | '90d', number> = { '30d': 30, '90d': 90 }

/**
 * Rolling window from `now` (not a JST calendar-day boundary) — period
 * switching reads as "how far back", which a calendar cutoff wouldn't match
 * near a day boundary. `now` defaults so tests can inject a fixed time.
 */
export function filterTradePnlsByPeriod(
  rows: TradePnlRow[],
  period: QualityPeriod,
  now: Date = new Date(),
): TradePnlRow[] {
  if (period === 'all') return rows
  const cutoffMs = now.getTime() - PERIOD_DAYS[period] * 86_400_000
  return rows.filter((r) => {
    const t = new Date(r.timestamp).getTime()
    return Number.isFinite(t) && t >= cutoffMs
  })
}

export interface TradeStats {
  count: number
  wins: number
  losses: number
  /** 0..1 (勝率) */
  winRate: number
  avgWin: number
  avgLoss: number // 負値
  /** 総利益 / |総損失|。loss=0 のときは Infinity (UI 側で "—" 表示) */
  profitFactor: number
  /** 1 trade あたり期待損益 = total / 全トレード数 (break-even 含む) */
  expectancy: number
  total: number
}

// break-even (pnl=0) counts toward neither wins nor losses, but still
// contributes 0 to `expectancy`'s denominator below.
export function computeTradeStats(pnls: number[]): TradeStats {
  if (pnls.length === 0) {
    return { count: 0, wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, total: 0 }
  }
  let wins = 0
  let losses = 0
  let sumWin = 0
  let sumLoss = 0
  let total = 0
  for (const p of pnls) {
    total += p
    if (p > 0) {
      wins += 1
      sumWin += p
    } else if (p < 0) {
      losses += 1
      sumLoss += p
    }
  }
  const decisive = wins + losses
  const winRate = decisive > 0 ? wins / decisive : 0
  const avgWin = wins > 0 ? sumWin / wins : 0
  const avgLoss = losses > 0 ? sumLoss / losses : 0
  const profitFactor = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0
  // Divides by all trades, not just decisive ones — winRate*avgWin +
  // (1-winRate)*avgLoss divides by decisive trades only, which undercounts
  // break-even trades against a "per-trade" label.
  const expectancy = total / pnls.length
  return { count: pnls.length, wins, losses, winRate, avgWin, avgLoss, profitFactor, expectancy, total }
}

export interface SymbolStat {
  symbol: string
  count: number
  winRate: number
  totalPnl: number
  profitFactor: number
}

export function computeSymbolStats(rows: TradePnlRow[]): SymbolStat[] {
  const bySymbol = new Map<string, number[]>()
  for (const r of rows) {
    const list = bySymbol.get(r.symbol)
    if (list) {
      list.push(r.realizedPnl)
    } else {
      bySymbol.set(r.symbol, [r.realizedPnl])
    }
  }
  const out: SymbolStat[] = []
  for (const [symbol, pnls] of bySymbol) {
    const s = computeTradeStats(pnls)
    out.push({ symbol, count: s.count, winRate: s.winRate, totalPnl: s.total, profitFactor: s.profitFactor })
  }
  return out.sort((a, b) => b.totalPnl - a.totalPnl)
}

// Colors are slots 1-7 of the dataviz skill's validated categorical
// palette, in order — not picked ad hoc, so don't reorder without checking
// its light/dark and CVD-adjacency validation still holds.
const SKIP_REASON_CATEGORIES = [
  { key: 'halt', label: '取引停止中', color: '#2a78d6' },
  { key: 'risk_gate', label: 'リスクゲート', color: '#eb6834' },
  { key: 'role', label: '銘柄ロール抑止', color: '#1baf7a' },
  { key: 'funds', label: '資金不足', color: '#eda100' },
  { key: 'sizing', label: 'サイジング不可', color: '#e87ba4' },
  { key: 'system_guard', label: 'システムガード', color: '#008300' },
  { key: 'other', label: 'その他', color: '#4a3aa7' },
] as const

export type SkipReasonCategoryKey = (typeof SKIP_REASON_CATEGORIES)[number]['key']

// Unrecognized reason strings (future prefixes, old formats) fall to
// 'other' rather than being dropped, so aggregate counts never go missing.
export function categorizeSkipReason(reason: string | null | undefined): SkipReasonCategoryKey {
  if (!reason) return 'other'
  if (/^(?:portfolio_halted|drawdown_kill):/.test(reason)) return 'halt'
  if (/^role:/.test(reason)) return 'role'
  if (/^sizing rejected:/.test(reason)) return 'sizing'
  if (/^risk:/.test(reason)) return /buying[- ]power/.test(reason) ? 'funds' : 'risk_gate'
  if (/^pair_regime:/.test(reason)) return 'risk_gate'
  if (
    /^insufficient bars for indicators$/.test(reason) ||
    /^invalid (?:price|notional|position qty|expiresAt)/.test(reason) ||
    /^SELL without position$/.test(reason) ||
    /^pending order already in flight$/.test(reason)
  ) {
    return 'system_guard'
  }
  return 'other'
}

export interface SkipReasonBreakdownPoint {
  date: string
  counts: Record<SkipReasonCategoryKey, number>
}

function emptySkipCounts(): Record<SkipReasonCategoryKey, number> {
  const counts = {} as Record<SkipReasonCategoryKey, number>
  for (const c of SKIP_REASON_CATEGORIES) counts[c.key] = 0
  return counts
}

export function aggregateSkipReasonRows(
  rows: Array<{ day: string; reason: string | null; n: number }>,
): SkipReasonBreakdownPoint[] {
  const map = new Map<string, Record<SkipReasonCategoryKey, number>>()
  for (const r of rows) {
    let bucket = map.get(r.day)
    if (!bucket) {
      bucket = emptySkipCounts()
      map.set(r.day, bucket)
    }
    bucket[categorizeSkipReason(r.reason)] += Number(r.n)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, counts]) => ({ date, counts }))
}

// Fixed 90-day window, independent of `?period=` — this chart tracks recent
// gate trends, not the trade-stats period the rest of the tab switches on.
export async function loadSkipReasonBreakdown(db: D1Database): Promise<SkipReasonBreakdownPoint[]> {
  const result = await db
    .prepare(
      `SELECT date(timestamp, '+9 hours') AS day,
              reason,
              COUNT(*) AS n
       FROM strategy_decision_log
       WHERE decision = 'SKIP'
         AND timestamp >= date('now', '-90 days')
       GROUP BY day, reason
       ORDER BY day ASC`,
    )
    .all<{ day: string; reason: string | null; n: number }>()
  return aggregateSkipReasonRows(result.results ?? [])
}

const PCT_FMT = (n: number) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—')
const PF_FMT = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '∞')
/** Sign before the $ mark, comma-grouped via `fmtNumber` (`+$170.02`, `-$12,345.67`) — these are all $ PnL figures, never a bare number. */
const MONEY_FMT = (n: number) => (Number.isFinite(n) ? `${n >= 0 ? '+' : '-'}$${fmtNumber(Math.abs(n))}` : '—')
const signClass = (n: number) => (n > 0 ? 'ok' : n < 0 ? 'err' : 'muted')

function renderPeriodPills(period: QualityPeriod): string {
  const periods: QualityPeriod[] = ['30d', '90d', 'all']
  const links = periods
    .map((p) => {
      const cls = p === period ? ' class="active"' : ''
      return `<a${cls} href="/dashboard/charts?tab=quality&period=${p}">${esc(QUALITY_PERIOD_LABELS[p])}</a>`
    })
    .join('')
  return `<div class="seg" style="margin-bottom:12px">${links}</div>`
}

/**
 * 640px-wide tile (spec: this exact card gets screenshotted for X posts).
 * Custom markup rather than `overview.ts`'s `kpiCard()`: that helper's
 * label-then-value stack has no room for a hero row (bigger value, two
 * secondary stats beside it) or for the row2/row3 divider grid below, both
 * asked for explicitly — reusing it would mean fighting its layout with
 * overrides rather than just writing the shape once.
 *
 * Row 1 (hero) sits on `--surface-2` with no inner border; rows 2-3 are
 * flat cells divided by 1px rules (no per-cell card chrome). `min-width:0`
 * on every value plus `font-variant-numeric:tabular-nums` (`.perf-*` rules,
 * `CHARTS_PAGE_STYLE`) keeps a long value (`+$12,345.67`) from overflowing
 * its cell instead of shrinking the grid track to fit it.
 */
function renderStatsCard(stats: TradeStats, period: QualityPeriod, asOfJst: string): string {
  const cell = (label: string, text: string, cls?: string) =>
    `<div class="perf-cell"><div class="perf-cell-label">${esc(label)}</div><div class="perf-cell-value ${cls ?? ''}">${esc(text)}</div></div>`
  const wideCell = (label: string, text: string, cls?: string) =>
    `<div class="perf-cell perf-cell-wide"><div class="perf-cell-label">${esc(label)}</div><div class="perf-cell-value ${cls ?? ''}">${esc(text)}</div></div>`
  // TradeStats has no per-trade max-win/max-loss, so row 3 is 勝/負 spanning
  // 2 columns each rather than 4 single cells matching row 2's width.
  const cells = [
    cell('profit factor', PF_FMT(stats.profitFactor)),
    cell('期待値 (トレード毎)', MONEY_FMT(stats.expectancy), signClass(stats.expectancy)),
    cell('平均利益', MONEY_FMT(stats.avgWin), 'ok'),
    cell('平均損失', MONEY_FMT(stats.avgLoss), 'err'),
    wideCell('勝', String(stats.wins), 'ok'),
    wideCell('負', String(stats.losses), 'err'),
  ].join('')
  return `<div class="card" style="width:640px;box-sizing:border-box">
    <div class="card-head">
      <span class="card-title">運用成績 (${esc(QUALITY_PERIOD_LABELS[period])})</span>
      <span class="card-actions muted" style="font-size:11px">as of ${esc(asOfJst)}</span>
    </div>
    <div class="perf-hero-row">
      <div class="perf-hero">
        <div class="perf-hero-label">合計 PnL</div>
        <div class="perf-hero-value ${signClass(stats.total)}">${esc(MONEY_FMT(stats.total))}</div>
      </div>
      <div class="perf-hero-secondary">
        <div class="perf-stat"><div class="perf-cell-label">件数</div><div class="perf-stat-value">${stats.count}</div></div>
        <div class="perf-stat"><div class="perf-cell-label">勝率</div><div class="perf-stat-value">${esc(PCT_FMT(stats.winRate))}</div></div>
      </div>
    </div>
    <div class="perf-cell-grid">${cells}</div>
  </div>`
}

function renderSymbolTable(symbolStats: SymbolStat[]): string {
  if (symbolStats.length === 0) return `<div class="empty">まだ銘柄別の確定損益がありません。</div>`
  const rows = symbolStats
    .map(
      (s) => `<tr>
        <td>${esc(s.symbol)}</td>
        <td class="num">${s.count}</td>
        <td class="num">${PCT_FMT(s.winRate)}</td>
        <td class="num ${signClass(s.totalPnl)}">${MONEY_FMT(s.totalPnl)}</td>
        <td class="num">${PF_FMT(s.profitFactor)}</td>
      </tr>`,
    )
    .join('')
  return `<div class="card">
    <div class="card-head"><span class="card-title">銘柄別 成績</span></div>
    <div class="tablewrap">
      <table>
        <thead><tr><th>銘柄</th><th class="num">件数</th><th class="num">勝率</th><th class="num">合計PnL</th><th class="num">PF</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`
}

export function renderQualityTab(args: ChartsBodyQuality): string {
  if (!args.hasTradeData && args.skipBreakdown.length === 0) {
    return `<p class="muted">まだ判定ログも実 fill も無いため成績を描けません。cron が動き出すと SKIP 理由の内訳、SELL が約定すると成績サマリが出ます。</p>`
  }
  const symbolBarChart =
    args.symbolStats.length > 0
      ? `<div class="card">
        <div class="card-head"><span class="card-title">銘柄別 合計PnL</span></div>
        <div id="symbol-pnl-chart" style="width:100%;height:${Math.max(200, args.symbolStats.length * 34 + 60)}px"></div>
      </div>`
      : ''
  // The bar chart stacks under the table in the same right-hand column
  // (rather than full-width below the row) so the two columns read as a
  // matched pair against the fixed 640px hero card, instead of the right
  // column ending noticeably shorter than the left.
  const tradeSection = args.hasTradeData
    ? `${renderPeriodPills(args.period)}
      <div class="quality-perf-row">
        ${renderStatsCard(args.stats, args.period, args.asOfJst)}
        <div>${renderSymbolTable(args.symbolStats)}${symbolBarChart}</div>
      </div>`
    : ''
  const skipSection =
    args.skipBreakdown.length > 0
      ? `<div class="card">
        <div class="card-head"><span class="card-title">日次 SKIP 理由内訳</span></div>
        <div id="skip-reason-chart" style="width:100%;height:340px"></div>
      </div>`
      : ''
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined' || typeof window.wtChart !== 'function') return;
      var t = window.wtTokens ? window.wtTokens() : {};
      var data = window.__chartData;
      var barEl = document.getElementById('symbol-pnl-chart');
      if (barEl && data.symbolStats && data.symbolStats.length > 0) {
        var symbols = data.symbolStats.map(function (s) { return s.symbol; });
        window.wtChart(barEl, {
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          grid: { left: 70, right: 60, top: 20, bottom: 20 },
          xAxis: { type: 'value', splitLine: { lineStyle: { color: t.border } } },
          yAxis: { type: 'category', data: symbols, inverse: true },
          series: [{
            type: 'bar',
            barWidth: 14,
            data: data.symbolStats.map(function (s) {
              var positive = s.totalPnl >= 0;
              return {
                value: s.totalPnl,
                itemStyle: { color: positive ? t.up : t.down, borderRadius: 3 },
                label: {
                  show: true,
                  position: positive ? 'right' : 'left',
                  formatter: function () { return s.totalPnl.toFixed(2); },
                  fontSize: 11,
                },
              };
            }),
          }],
        });
      }
      var skipEl = document.getElementById('skip-reason-chart');
      if (skipEl && data.skipBreakdown && data.skipBreakdown.length > 0) {
        var dates = data.skipBreakdown.map(function (p) { return p.date; });
        var categories = data.skipCategories;
        window.wtChart(skipEl, {
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 4, data: categories.map(function (c) { return c.label; }) },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: dates },
          yAxis: { type: 'value', name: '件数' },
          series: categories.map(function (c) {
            return {
              name: c.label,
              type: 'bar',
              stack: 'skip',
              itemStyle: { color: c.color, borderWidth: 2, borderColor: t.surface },
              data: data.skipBreakdown.map(function (p) { return p.counts[c.key] || 0; }),
            };
          }),
        });
      }
    });
  `
  return `${tradeSection}
  ${skipSection}
  ${safeJsonScript('__chartData', {
    symbolStats: args.symbolStats,
    skipBreakdown: args.skipBreakdown,
    skipCategories: SKIP_REASON_CATEGORIES,
  })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}
