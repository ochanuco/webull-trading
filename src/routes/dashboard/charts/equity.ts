import { type ChartsBodyOverview, ECHARTS_CDN } from './shared'
import type { BenchmarkPoint } from './benchmark'
import { jstDayKey, resolveFillSide } from './loaders'
import { esc, exportMeta, fmtNumber, safeJsonScript } from '../shared'

export interface EquityPoint {
  date: string // YYYY-MM-DD (JST)
  dailyPnl: number
  cumulativePnl: number
  drawdownPct: number // 0 or negative, % drop from peak
}

/** Daily-aggregates realized_pnl from SELL fills, then feeds computeEquitySeries. */
export async function loadEquityCurve(db: D1Database): Promise<EquityPoint[]> {
  // SQLite's date() defaults to UTC; +9h shifts the group-by key to JST.
  const result = await db
    .prepare(
      `SELECT date(timestamp, '+9 hours') AS day,
              SUM(realized_pnl) AS daily_pnl
       FROM trade_journal
       WHERE realized_pnl IS NOT NULL
         AND trade_event_type = 'post_submit'
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all<{ day: string; daily_pnl: number }>()
  const rows = result.results ?? []
  return computeEquitySeries(rows.map((r) => ({ date: r.day, dailyPnl: Number(r.daily_pnl) })))
}

export function computeEquitySeries(
  daily: Array<{ date: string; dailyPnl: number }>,
): EquityPoint[] {
  const points: EquityPoint[] = []
  let cumulative = 0
  let peak = 0
  for (const d of daily) {
    cumulative += d.dailyPnl
    if (cumulative > peak) peak = cumulative
    // drawdownPct stays 0 until peak turns positive — there's no seed
    // capital to divide by, so a % against a near-zero/negative peak would
    // swing wildly early in the series.
    const dd = peak > 0 ? (cumulative - peak) / peak : 0
    points.push({ date: d.date, dailyPnl: d.dailyPnl, cumulativePnl: cumulative, drawdownPct: dd })
  }
  return points
}

/** One trade marker overlaid on the equity line — post_submit fills across all symbols. */
export interface EquityTradeMarker {
  timestamp: string // ISO UTC (fill time)
  /** YYYY-MM-DD (JST) — category-axis key for the equity chart. */
  date: string
  symbol: string
  side: 'BUY' | 'SELL'
  filledPrice: number
  filledQty: number | null
  realizedPnl: number | null
  /** Links to `/dashboard/trades?clientOrderId=`; null on older rows that predate the column. */
  clientOrderId: string | null
}

/**
 * Mirrors loadSymbolChart's fills query (loaders.ts) minus the symbol
 * filter. `side` isn't written on post_submit rows, so it's resolved via a
 * self-join to the matching pre_submit row, falling back to
 * `resolveFillSide`'s realized_pnl inference for older rows with none. No
 * period filter: the equity curve itself is all-time, so markers stay
 * aligned with it.
 */
export async function loadEquityTradeMarkers(db: D1Database): Promise<EquityTradeMarker[]> {
  const result = await db
    .prepare(
      `SELECT
         ps.timestamp AS timestamp,
         ps.symbol AS symbol,
         pre.side AS pre_side,
         ps.filled_price AS filled_price,
         ps.filled_qty AS filled_qty,
         ps.realized_pnl AS realized_pnl,
         ps.client_order_id AS client_order_id
       FROM trade_journal AS ps
       LEFT JOIN trade_journal AS pre
         ON pre.client_order_id = ps.client_order_id
         AND pre.trade_event_type = 'pre_submit'
       WHERE ps.trade_event_type = 'post_submit'
         AND ps.filled_price IS NOT NULL
       ORDER BY ps.id ASC`,
    )
    .all<{
      timestamp: string
      symbol: string
      pre_side: string | null
      filled_price: number | null
      filled_qty: number | null
      realized_pnl: number | null
      client_order_id: string | null
    }>()
  const markers: EquityTradeMarker[] = []
  for (const r of result.results ?? []) {
    if (r.filled_price === null || !Number.isFinite(Number(r.filled_price))) continue
    const date = jstDayKey(r.timestamp)
    if (!date) continue // can't place a marker on the category axis without a valid date
    markers.push({
      timestamp: r.timestamp,
      date,
      symbol: r.symbol,
      side: resolveFillSide(r.pre_side, r.realized_pnl),
      filledPrice: Number(r.filled_price),
      filledQty: r.filled_qty === null ? null : Number(r.filled_qty),
      realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
      clientOrderId: r.client_order_id,
    })
  }
  return markers
}

export interface PeriodReturn {
  key: '1W' | '1M' | '3M' | 'YTD' | 'ALL'
  /** Japanese label for display. */
  label: string
  /** $ change in cumulative realized PnL over the period — no % (no seed-capital denominator). */
  change: number
}

const JST_DAY_ONLY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * Per-period PnL change vs. the last cumulative value before the period's
 * JST start date (0 when no earlier point exists; ALL is always vs. 0).
 */
export function computePeriodReturns(points: EquityPoint[], now: Date): PeriodReturn[] {
  if (points.length === 0) return []
  const latest = points[points.length - 1]!.cumulativePnl
  const dayMs = 24 * 3600 * 1000
  const jstDay = (d: Date): string => JST_DAY_ONLY_FMT.format(d)
  const year = jstDay(now).slice(0, 4)
  const defs: Array<{ key: PeriodReturn['key']; label: string; start: string | null }> = [
    { key: '1W', label: '1週間', start: jstDay(new Date(now.getTime() - 7 * dayMs)) },
    { key: '1M', label: '1か月', start: jstDay(new Date(now.getTime() - 30 * dayMs)) },
    { key: '3M', label: '3か月', start: jstDay(new Date(now.getTime() - 90 * dayMs)) },
    { key: 'YTD', label: '年初来', start: `${year}-01-01` },
    { key: 'ALL', label: '全期間', start: null },
  ]
  return defs.map((d) => {
    let baseline = 0
    if (d.start !== null) {
      // points is date-ascending, so the last point before d.start wins.
      for (const p of points) {
        if (p.date < d.start) baseline = p.cumulativePnl
        else break
      }
    }
    return { key: d.key, label: d.label, change: latest - baseline }
  })
}

/** One monthly PnL bar. */
export interface MonthlyReturn {
  /** YYYY-MM (JST). */
  month: string
  /** Sum of dailyPnl within the month. */
  pnl: number
}

export function computeMonthlyReturns(points: EquityPoint[]): MonthlyReturn[] {
  const byMonth = new Map<string, number>()
  for (const p of points) {
    const month = p.date.slice(0, 7)
    byMonth.set(month, (byMonth.get(month) ?? 0) + p.dailyPnl)
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, pnl]) => ({ month, pnl }))
}

/**
 * MCP `get_equity` packet. Reuses the same pure aggregations
 * (computePeriodReturns / computeMonthlyReturns) the SSR overview tab
 * renders, so the JSON payload can't drift from what the dashboard shows.
 */
export function buildEquityPacket(points: EquityPoint[], now: Date) {
  return {
    ...exportMeta('dashboard_equity_export.v1'),
    points,
    periodReturns: computePeriodReturns(points, now),
    monthlyReturns: computeMonthlyReturns(points),
  }
}

/** View model for the overview chart, shaped for the client inline script. */
export interface OverviewChartData {
  /** Category axis: union of equity dates and marker dates, ascending. */
  dates: string[]
  /** Cumulative PnL per `dates` index; forward-filled on days with no equity point. */
  equity: number[]
  /** Drawdown % per `dates` index (0 or negative). */
  drawdownPct: number[]
  /** Each marker plus its day's equity y-value, for scatter placement. */
  markers: Array<EquityTradeMarker & { y: number }>
  /** QQQ return % per `dates` index; null before the series starts or if benchmark is unavailable. */
  benchmark: Array<number | null> | null
}

/**
 * Aligns equity, markers, and benchmark onto one category axis (pure).
 *
 * The axis is the union of equity and marker dates, not equity dates alone:
 * a BUY fill carries no realized_pnl, so it often has no same-day equity
 * point to sit on. Marker days forward-fill the prior cumulative value;
 * before the first equity point, cumulative is 0.
 *
 * Benchmark (QQQ) forward-fills by date key onto the same axis. Its Yahoo
 * UTC date can drift up to a day from the JST key, which is fine since only
 * the return curve's slope is compared, not day-for-day values.
 */
export function buildOverviewChartData(
  equityPoints: EquityPoint[],
  markers: EquityTradeMarker[],
  benchmark: BenchmarkPoint[] | null,
): OverviewChartData {
  const dateSet = new Set<string>(equityPoints.map((p) => p.date))
  for (const m of markers) dateSet.add(m.date)
  const dates = [...dateSet].sort()
  const eqByDate = new Map(equityPoints.map((p) => [p.date, p]))
  const equity: number[] = []
  const drawdownPct: number[] = []
  const yByDate = new Map<string, number>()
  let cum = 0
  let dd = 0
  for (const d of dates) {
    const p = eqByDate.get(d)
    if (p) {
      cum = p.cumulativePnl
      dd = p.drawdownPct
    }
    equity.push(cum)
    drawdownPct.push(dd * 100)
    yByDate.set(d, cum)
  }
  const outMarkers = markers.map((m) => ({ ...m, y: yByDate.get(m.date) ?? 0 }))
  let benchAligned: Array<number | null> | null = null
  if (benchmark && benchmark.length > 0) {
    const sorted = [...benchmark].sort((a, b) => a.date.localeCompare(b.date))
    benchAligned = []
    let bi = 0
    let last: number | null = null
    for (const d of dates) {
      while (bi < sorted.length && sorted[bi]!.date <= d) {
        last = sorted[bi]!.returnPct
        bi += 1
      }
      benchAligned.push(last)
    }
  }
  return { dates, equity, drawdownPct, markers: outMarkers, benchmark: benchAligned }
}

function fmtSignedAmount(v: number): string {
  return `${v > 0 ? '+' : ''}${fmtNumber(v)}`
}

/** No %, same reason as computePeriodReturns (no seed-capital denominator). */
function renderPeriodReturnsTable(rows: PeriodReturn[]): string {
  if (rows.length === 0) return ''
  const cells = rows
    .map((r) => {
      const cls = r.change > 0 ? 'ok' : r.change < 0 ? 'err' : 'muted'
      return `<td class="${cls} num">${esc(fmtSignedAmount(r.change))}</td>`
    })
    .join('')
  const heads = rows.map((r) => `<th>${esc(r.label)}</th>`).join('')
  return `<h3 class="sub-head">期間別リターン (実現 PnL 変化額)</h3>
  <table>
    <thead><tr>${heads}</tr></thead>
    <tbody><tr>${cells}</tr></tbody>
  </table>`
}

export function renderOverviewTab(args: ChartsBodyOverview): string {
  if (args.equity.length === 0) {
    return `<p class="muted">まだ実 fill (realized_pnl) が無いためエクイティカーブを描けません。最初の SELL が約定すると表示されます。</p>`
  }
  const vm = buildOverviewChartData(args.equity, args.tradeMarkers ?? [], args.benchmark ?? null)
  const hasBenchmark = vm.benchmark !== null
  const benchmarkNote = hasBenchmark
    ? 'ベンチマーク: 実現 PnL ($ 左軸) vs QQQ 騰落率 (% 右軸) — 意味の異なる系列の重ね描きなので傾き / 方向の比較のみに使う (絶対値は比較不能)。'
    : 'ベンチマーク (QQQ 騰落率) は取得失敗のため非表示 (チャート本体には影響なし)。'
  const markerNote =
    (args.tradeMarkers ?? []).length > 0
      ? ' 取引マーカー: 売り (SELL) は実現損益で緑 (益) / 赤 (損)、買い (BUY) は灰。点クリックで該当注文の約定履歴へ。'
      : ''
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var vm = data.vm;
      var escHtml = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
      var SIDE_JA = { BUY: '買い', SELL: '売り' };
      function markerSeries(name, color, filter) {
        var items = [];
        for (var i = 0; i < vm.markers.length; i++) {
          var m = vm.markers[i];
          if (filter(m)) items.push({ value: [m.date, m.y], marker: m });
        }
        return { name: name, type: 'scatter', symbolSize: 9, z: 5, itemStyle: { color: color }, data: items };
      }
      // Single source for legend/title/tooltip unit-detection, all three of
      // which match against this name.
      var BENCH_SERIES = '市場に乗るだけ (QQQ)';
      var series = [
        { name: '確定損益 (累積)', type: 'line', data: vm.equity, smooth: false, areaStyle: { opacity: 0.1 }, lineStyle: { width: 2 } },
        markerSeries('売り・益 (SELL)', '#057a55', function (m) { return m.side === 'SELL' && (m.realizedPnl || 0) >= 0; }),
        markerSeries('売り・損 (SELL)', '#c22', function (m) { return m.side === 'SELL' && (m.realizedPnl || 0) < 0; }),
        markerSeries('買い (BUY)', '#86868b', function (m) { return m.side !== 'SELL'; }),
      ];
      if (vm.benchmark) {
        series.push({ name: BENCH_SERIES, type: 'line', yAxisIndex: 1, data: vm.benchmark, showSymbol: false, connectNulls: true, lineStyle: { width: 1, type: 'dashed', color: '#1471a8' }, itemStyle: { color: '#1471a8' } });
      }
      var equityChart = echarts.init(document.getElementById('equity-chart'));
      equityChart.setOption({
        title: { text: vm.benchmark ? 'bot の確定損益 vs ' + BENCH_SERIES : 'bot の確定損益の推移', left: 'center', textStyle: { fontSize: 14 } },
        legend: { top: 24, textStyle: { fontSize: 11 } },
        tooltip: {
          trigger: 'axis',
          formatter: function (params) {
            if (!params || params.length === 0) return '';
            var lines = [escHtml(params[0].axisValue)];
            for (var i = 0; i < params.length; i++) {
              var p = params[i];
              if (p.data && p.data.marker) {
                var m = p.data.marker;
                var qty = m.filledQty == null ? '?' : m.filledQty;
                var pnl = m.realizedPnl == null ? '' : ' / 実現損益 ' + Number(m.realizedPnl).toFixed(2);
                lines.push(p.marker + escHtml(m.symbol) + ' ' + (SIDE_JA[m.side] || escHtml(m.side)) + ' ' + Number(m.filledPrice).toFixed(2) + ' × ' + qty + pnl);
              } else if (p.value != null) {
                var unit = p.seriesName === BENCH_SERIES ? '%' : '';
                lines.push(p.marker + escHtml(p.seriesName) + ': ' + Number(p.value).toFixed(2) + unit);
              }
            }
            return lines.join('<br/>');
          },
        },
        grid: { left: 50, right: vm.benchmark ? 55 : 20, top: 52, bottom: 40 },
        xAxis: { type: 'category', data: vm.dates },
        yAxis: [
          { type: 'value', name: 'PnL', axisLabel: { formatter: '{value}' } },
          { type: 'value', name: 'QQQ %', show: !!vm.benchmark, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } },
        ],
        series: series,
      });
      equityChart.on('click', function (p) {
        if (p && p.data && p.data.marker && p.data.marker.clientOrderId) {
          window.location.href = '/dashboard/trades?clientOrderId=' + encodeURIComponent(p.data.marker.clientOrderId);
        }
      });
      var ddChart = echarts.init(document.getElementById('dd-chart'));
      ddChart.setOption({
        title: { text: 'ドローダウン (累積 PnL の peak からの低下率)', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2) + '%'; } },
        grid: { left: 50, right: 20, top: 40, bottom: 40 },
        xAxis: { type: 'category', data: vm.dates },
        yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
        series: [{ type: 'line', data: vm.drawdownPct, areaStyle: { color: '#c22', opacity: 0.2 }, lineStyle: { color: '#c22', width: 1 } }],
      });
      var monthlyEl = document.getElementById('monthly-chart');
      var monthlyChart = null;
      if (monthlyEl && data.monthly && data.monthly.length > 0) {
        monthlyChart = echarts.init(monthlyEl);
        monthlyChart.setOption({
          title: { text: '月次 realized PnL (JST 集計)', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2); } },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: data.monthly.map(function (m) { return m.month; }) },
          yAxis: { type: 'value', name: 'PnL' },
          series: [{ type: 'bar', barMaxWidth: 40, data: data.monthly.map(function (m) { return { value: m.pnl, itemStyle: { color: m.pnl >= 0 ? '#057a55' : '#c22' } }; }) }],
        });
      }
      window.addEventListener('resize', function () { equityChart.resize(); ddChart.resize(); if (monthlyChart) monthlyChart.resize(); });
    });
  `
  const monthly = args.monthlyReturns ?? []
  const monthlyChartHtml =
    monthly.length > 0
      ? `<div id="monthly-chart" style="width:100%;height:260px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>`
      : ''
  return `<p class="muted" style="font-size:12px">
    累積 realized PnL と peak からの下落率 (MaxDD)。戦略の長期パフォーマンス指標。
    シード資金額を保持していないため下落率は「累積 PnL の peak からの相対」で計算
    (peak ≤ 0 のときは 0%)。当日 intraday の risk halt 閾値 (drawdown_kill /
    risk_dd_halt) は別概念のため重畳しない。
    ${esc(benchmarkNote)}${esc(markerNote)}
  </p>
  <div id="equity-chart" style="width:100%;height:340px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  <div id="dd-chart" style="width:100%;height:280px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${renderPeriodReturnsTable(args.periodReturns ?? [])}
  ${monthlyChartHtml}
  ${safeJsonScript('__chartData', { vm, monthly })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}
