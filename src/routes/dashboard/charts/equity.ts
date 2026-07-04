import { type ChartsBodyOverview, ECHARTS_CDN } from './shared'
import type { BenchmarkPoint } from './benchmark'
import { jstDayKey, resolveFillSide } from './loaders'
import { esc, fmtNumber, safeJsonScript } from '../shared'

export interface EquityPoint {
  date: string // YYYY-MM-DD (JST)
  dailyPnl: number
  cumulativePnl: number
  drawdownPct: number // 0 or 負 (peak からの低下率)
}

/**
 * trade_journal の post_submit で realized_pnl が記録されている SELL fill を
 * 日次集計し、累積 PnL とドローダウン率を計算する。
 *
 * - peak は cumulativePnl の rolling max
 * - drawdownPct は peak が 0 以下のとき null 相当 (= 0%) として扱う
 *   (peak が小さい初期は割り算が暴れるため)
 */
export async function loadEquityCurve(db: D1Database): Promise<EquityPoint[]> {
  // SQLite の date(timestamp) はデフォルト UTC。JST 表示にするため +9h shift。
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
    // peak が +側になるまでは drawdown を 0 表示 (シード資金規模が不明なので
    // % 計算は意味をなさない。peak を絶対額として比較するのも手だが、トレーダー
    // 視点では「最高益からの下落率」が読みたいので peak>0 で初めて非ゼロに)
    const dd = peak > 0 ? (cumulative - peak) / peak : 0
    points.push({ date: d.date, dailyPnl: d.dailyPnl, cumulativePnl: cumulative, drawdownPct: dd })
  }
  return points
}

/** equity line に重ねる取引マーカー 1 件 (全銘柄の post_submit fill)。 */
export interface EquityTradeMarker {
  timestamp: string // ISO UTC (fill 時刻)
  /** YYYY-MM-DD (JST)。equity curve の category 軸に載せるための日次キー。 */
  date: string
  symbol: string
  side: 'BUY' | 'SELL'
  filledPrice: number
  filledQty: number | null
  realizedPnl: number | null
  /** クリック遷移先 `/dashboard/trades?clientOrderId=` 用。無い古い行は遷移なし。 */
  clientOrderId: string | null
}

/**
 * 全銘柄の post_submit fill を equity curve 用マーカーとして取得する。
 *
 * `loadSymbolChart` (loaders.ts) の fills SQL と同型だが symbol 条件なし。
 * side は post_submit 行に無い (writer は pre_submit にしか入れない) ため
 * client_order_id で pre_submit と self-JOIN、それも無い古い行は
 * realized_pnl の有無から推測する (`resolveFillSide` 共用)。
 * 期間フィルタは付けない: equity curve 自体が全期間 (trade_journal 全量の
 * 日次集計) なので、マーカーも同範囲 = 全件で揃える。
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
    if (!date) continue // timestamp 不正な行は category 軸に載せられないので捨てる
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

/** 期間別リターン 1 行 (PnL 変化額)。 */
export interface PeriodReturn {
  key: '1W' | '1M' | '3M' | 'YTD' | 'ALL'
  /** 日本語ラベル (UI 表示用)。 */
  label: string
  /** 期間内の累積 realized PnL 変化額。シード資金を保持していないため % は出さない。 */
  change: number
}

const JST_DAY_ONLY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * 期間別リターン (1W / 1M / 3M / YTD / ALL) を計算する (pure)。
 *
 * - 基準は「期間開始日 (JST) 前の最後の累積 PnL」。期間より古い point が
 *   無ければ 0 (= curve の開始値) を基準にする。ALL は常に 0 基準。
 * - `now` は引数で受ける (テスト容易性のため関数内で `Date.now()` は呼ばない)。
 * - % は返さない: equity は累積 realized PnL でシード資金額 (分母) が無く、
 *   変化率を計算すると初期の小さい累積値で数字が暴れて誤解を招く。
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
      // points は日付昇順。開始日より前の最後の累積値が基準。
      for (const p of points) {
        if (p.date < d.start) baseline = p.cumulativePnl
        else break
      }
    }
    return { key: d.key, label: d.label, change: latest - baseline }
  })
}

/** 月次 PnL 1 本 (bar チャート用)。 */
export interface MonthlyReturn {
  /** YYYY-MM (JST)。 */
  month: string
  /** その月の realized PnL 増分 (= dailyPnl の月内合計)。 */
  pnl: number
}

/**
 * 月次 (JST) の PnL 増分を集計する (pure)。EquityPoint.date は既に JST の
 * 日次キーなので、先頭 7 文字 (YYYY-MM) でグルーピングするだけでよい。
 */
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

/** overview チャート描画用に整列済みの view model (client inline JS に渡す形)。 */
export interface OverviewChartData {
  /** category 軸 (equity 日付 ∪ マーカー日付、昇順)。 */
  dates: string[]
  /** `dates` と同 index の累積 PnL (equity point の無い日は直前値で forward-fill)。 */
  equity: number[]
  /** `dates` と同 index のドローダウン (%、0 or 負)。 */
  drawdownPct: number[]
  /** 各マーカー + その日の equity y 値 (scatter の座標)。 */
  markers: Array<EquityTradeMarker & { y: number }>
  /** `dates` と同 index の QQQ 騰落率 (%)。データ開始前は null。系列自体が無ければ null。 */
  benchmark: Array<number | null> | null
}

/**
 * equity curve / マーカー / ベンチマークを 1 本の category 軸に整列する (pure)。
 *
 * - 軸は equity 日付とマーカー日付の和集合: BUY fill は realized_pnl を生まない
 *   ため equity curve に同日 point が無いことが多く、equity 日付だけを軸にすると
 *   BUY マーカーの置き場が無くなる。マーカー日は直前の累積値で forward-fill。
 * - 最初の equity point より前 (エントリーだけあって未確定の期間) は累積 0 扱い。
 * - benchmark (QQQ) は日付キーで forward-fill して同軸に載せる。QQQ の date は
 *   Yahoo の UTC 日付で JST キーと最大 1 日ずれるが、% 騰落率の傾き比較用途では
 *   許容する (厳密な同日照合はしない)。
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

/** 符号付き金額表示 ("+12.34" / "-3.00")。色分けは class 側でやる。 */
function fmtSignedAmount(v: number): string {
  return `${v > 0 ? '+' : ''}${fmtNumber(v)}`
}

/**
 * 期間別リターンの小テーブル (13px 基準、日本語ラベル)。
 * % は出さない (シード資金を保持していない — computePeriodReturns 参照)。
 */
export function renderPeriodReturnsTable(rows: PeriodReturn[]): string {
  if (rows.length === 0) return ''
  const cells = rows
    .map((r) => {
      const cls = r.change > 0 ? 'ok' : r.change < 0 ? 'err' : 'muted'
      return `<td class="${cls}" style="text-align:right">${esc(fmtSignedAmount(r.change))}</td>`
    })
    .join('')
  const heads = rows.map((r) => `<th>${esc(r.label)}</th>`).join('')
  return `<h3 style="font-size:14px;margin:20px 0 6px">期間別リターン (実現 PnL 変化額)</h3>
  <table style="font-size:13px">
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
  // ベンチマーク注記: 左軸 ($) と右軸 (%) は意味の異なる系列の重ね描きである
  // ことを明示する。取得失敗時は series を省略して注記だけ残す (fail-graceful)。
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
      var series = [
        { name: '累積 realized PnL', type: 'line', data: vm.equity, smooth: false, areaStyle: { opacity: 0.1 }, lineStyle: { width: 2 } },
        markerSeries('売り・益 (SELL)', '#057a55', function (m) { return m.side === 'SELL' && (m.realizedPnl || 0) >= 0; }),
        markerSeries('売り・損 (SELL)', '#c22', function (m) { return m.side === 'SELL' && (m.realizedPnl || 0) < 0; }),
        markerSeries('買い (BUY)', '#86868b', function (m) { return m.side !== 'SELL'; }),
      ];
      if (vm.benchmark) {
        series.push({ name: 'QQQ 騰落率', type: 'line', yAxisIndex: 1, data: vm.benchmark, showSymbol: false, connectNulls: true, lineStyle: { width: 1, type: 'dashed', color: '#1471a8' }, itemStyle: { color: '#1471a8' } });
      }
      var equityChart = echarts.init(document.getElementById('equity-chart'));
      equityChart.setOption({
        title: { text: vm.benchmark ? '累積 realized PnL ($ 左軸) vs QQQ 騰落率 (% 右軸)' : '累積 realized PnL', left: 'center', textStyle: { fontSize: 14 } },
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
                var unit = p.seriesName === 'QQQ 騰落率' ? '%' : '';
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
