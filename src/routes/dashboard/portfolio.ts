import { loadPortfolioEquitySnapshots, type LoadPortfolioEquitySnapshotOptions } from '../../infrastructure/db/portfolioEquitySnapshotRepo'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import type { VixRegime } from '../../trading/risk/vixRegimeFilter'
import { ECHARTS_CDN } from './charts/shared'
import { esc, fmtJst, fmtNumber, safeJsonScript } from './shared'

export function portfolioBody(p: {
  dailyStartEquity: number
  dailyRealizedPnl: number
  tradingDisabledUntil: string | null
  lastRolledAt?: string | null
  updatedAt: string
}, vixRegime: VixRegime | null, equity?: {
  snapshots: PortfolioEquitySnapshotRow[]
  range: EquityRange
}): string {
  const drawdownPct =
    p.dailyStartEquity > 0 ? (p.dailyRealizedPnl / p.dailyStartEquity) * 100 : null
  const ddClass = drawdownPct === null ? 'muted' : drawdownPct >= 0 ? 'ok' : 'err'
  const kill = p.tradingDisabledUntil
  const lastRolledCell = renderLastRolledCell(p.lastRolledAt ?? null)
  const vixCell = renderVixRegimeCell(vixRegime)
  const summaryTable = `<table>
    <tbody>
      <tr><th>当日始値資産 (dailyStartEquity)</th><td>${fmtNumber(p.dailyStartEquity, 2)}</td></tr>
      <tr><th>当日実現損益 (dailyRealizedPnl)</th><td class="${ddClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</td></tr>
      <tr><th>ドローダウン (drawdown)</th><td class="${ddClass}">${drawdownPct === null ? '—' : fmtNumber(drawdownPct, 2) + '%'}</td></tr>
      <tr><th>取引停止解除時刻 (tradingDisabledUntil)</th><td>${kill ? `<span class="warn">${esc(fmtJst(kill))}</span>` : '<span class="ok">稼働中</span>'}</td></tr>
      <tr><th>VIX レジーム (vixRegime)</th><td>${vixCell}</td></tr>
      <tr><th>EOD ロールオーバー実行時刻 (lastRolledAt)</th><td>${lastRolledCell}</td></tr>
      <tr><th>更新時刻 (updatedAt)</th><td class="muted">${esc(fmtJst(p.updatedAt))}</td></tr>
    </tbody>
  </table>`
  const chartSection = equity ? renderPortfolioEquityChart(equity.snapshots, equity.range) : ''
  return summaryTable + chartSection
}

/**
 * `?range=30d|90d|365d|all` の解釈。default は 90d (3 ヶ月で trend が読める粒度)。
 * 不正値は default に倒す。`all` は cap 内 (3650 件) で全件返し。
 */
export type EquityRange = '30d' | '90d' | '365d' | 'all'

export function parseEquityRange(value: string | undefined): EquityRange {
  if (value === '30d' || value === '90d' || value === '365d' || value === 'all') return value
  return '90d'
}

export function equityRangeLimit(range: EquityRange): number {
  if (range === '30d') return 30
  if (range === '90d') return 90
  if (range === '365d') return 365
  return 3650
}

/**
 * `loadPortfolioEquitySnapshots` を try/catch で wrap。table 未 migration や
 * D1 エラー時は空配列で fallback → ページ自体は描画。チャート枠は "データ無し"
 * メッセージに置き換わる。
 */
export async function safeLoadPortfolioSnapshots(
  db: D1Database,
  range: EquityRange,
): Promise<PortfolioEquitySnapshotRow[]> {
  const opts: LoadPortfolioEquitySnapshotOptions = { limit: equityRangeLimit(range) }
  try {
    return await loadPortfolioEquitySnapshots(db, opts)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'portfolio_equity_snapshot_load_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return []
  }
}

/**
 * `/dashboard/portfolio` の総資産チャート。echarts inline JS で USD / JPY の
 * 2 ライン (片方 NULL は skip)。
 *
 * - X: snapshotAt の日付部分 (UTC date)
 * - Y: dailyStartEquity (通貨別)
 * - range tab で 30d / 90d / 365d / all 切替 (URL `?range=` を維持)
 */
export function renderPortfolioEquityChart(
  snapshots: PortfolioEquitySnapshotRow[],
  range: EquityRange,
  basePath = '/dashboard/portfolio',
): string {
  const rangeTabs = renderEquityRangeTabs(range, basePath)
  if (snapshots.length === 0) {
    return `<h3 style="margin-top:24px">総資産チャート</h3>
    ${rangeTabs}
    <p class="muted">まだ roll-daily 実行履歴がありません。<code>/admin/portfolio/roll-daily</code> を実行すると、ここに時系列が描画されます。</p>`
  }
  const usdPoints: Array<{ date: string; value: number | null }> = []
  const jpyPoints: Array<{ date: string; value: number | null }> = []
  let hasUsd = false
  let hasJpy = false
  for (const row of snapshots) {
    const date = (row.snapshotAt ?? '').slice(0, 10)
    const usd =
      typeof row.dailyStartEquityUsd === 'number' && Number.isFinite(row.dailyStartEquityUsd)
        ? row.dailyStartEquityUsd
        : null
    const jpy =
      typeof row.dailyStartEquityJpy === 'number' && Number.isFinite(row.dailyStartEquityJpy)
        ? row.dailyStartEquityJpy
        : null
    if (usd !== null) hasUsd = true
    if (jpy !== null) hasJpy = true
    usdPoints.push({ date, value: usd })
    jpyPoints.push({ date, value: jpy })
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__equityChartData;
      var dates = data.usd.map(function (p) { return p.date; });
      var series = [];
      if (data.hasUsd) {
        series.push({
          name: 'USD',
          type: 'line',
          data: data.usd.map(function (p) { return p.value; }),
          connectNulls: false,
          smooth: false,
          lineStyle: { width: 2, color: '#1471a8' },
          itemStyle: { color: '#1471a8' },
        });
      }
      if (data.hasJpy) {
        series.push({
          name: 'JPY',
          type: 'line',
          yAxisIndex: data.hasUsd ? 1 : 0,
          data: data.jpy.map(function (p) { return p.value; }),
          connectNulls: false,
          smooth: false,
          lineStyle: { width: 2, color: '#b25000' },
          itemStyle: { color: '#b25000' },
        });
      }
      var yAxis = [{ type: 'value', name: 'USD', axisLabel: { formatter: '{value}' } }];
      if (data.hasUsd && data.hasJpy) {
        yAxis.push({ type: 'value', name: 'JPY', axisLabel: { formatter: '{value}' } });
      } else if (!data.hasUsd && data.hasJpy) {
        yAxis = [{ type: 'value', name: 'JPY', axisLabel: { formatter: '{value}' } }];
      }
      var chart = echarts.init(document.getElementById('portfolio-equity-chart'));
      chart.setOption({
        title: { text: '総資産 (dailyStartEquity) 時系列', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return v == null ? '—' : Number(v).toFixed(2); } },
        legend: { top: 24 },
        grid: { left: 50, right: 20, top: 60, bottom: 40, containLabel: true },
        xAxis: { type: 'category', data: dates },
        yAxis: yAxis,
        series: series,
      });
      window.addEventListener('resize', function () { chart.resize(); });
    });
  `
  return `<h3 style="margin-top:24px">総資産チャート</h3>
  ${rangeTabs}
  <p class="muted" style="font-size:12px">
    <code>PortfolioStateDO.dailyStartEquity</code> の roll-daily 時点スナップショット。
    <code>/dashboard/charts?tab=overview</code> は <code>trade_journal.realized_pnl</code> の
    累積で、こちらは口座総資産そのもの (cash + 保有時価)。USD / JPY を別軸でプロット。
  </p>
  <div id="portfolio-equity-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${safeJsonScript('__equityChartData', { usd: usdPoints, jpy: jpyPoints, hasUsd, hasJpy })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

export function renderEquityRangeTabs(active: EquityRange, basePath = '/dashboard/portfolio'): string {
  const options: Array<{ id: EquityRange; label: string }> = [
    { id: '30d', label: '30 日' },
    { id: '90d', label: '90 日' },
    { id: '365d', label: '365 日' },
    { id: 'all', label: '全期間' },
  ]
  const links = options
    .map((opt) => {
      const cls = opt.id === active ? 'tab tab-active' : 'tab'
      return `<a class="${cls}" href="${basePath}?range=${opt.id}">${opt.label}</a>`
    })
    .join(' ')
  return `<div class="tab-strip" style="margin-top:12px">${links}</div>`
}

/**
 * VIX regime snapshot を bage 風に表示 (issue #196 3/3)。
 *
 *   - normal:   緑 (size 1.0、通常運用)
 *   - warning:  黄 (size 0.5、新規 BUY 縮小)
 *   - critical: 赤 (新規 BUY 全停止 / SELL は通常)
 *   - null:     灰 (snapshot 未生成、初回 cron tick 前 or DB 未配線)
 *
 * VIX 値そのものは snapshot table に持たないので regime ラベルのみ表示。
 * 値が必要なら strategy_decision_log の VIX reject reason を見る運用 (POC)。
 */
export function renderVixRegimeCell(regime: VixRegime | null): string {
  if (regime === null) {
    return `<span class="muted">— (cron 未到達 or DB 未配線、fail-open で通常運用)</span>`
  }
  if (regime === 'critical') {
    return `<span class="err">critical — 新規買い停止 (売却は通常)</span>`
  }
  if (regime === 'warning') {
    return `<span class="warn">warning — 新規買いを縮小 (size scale 適用)</span>`
  }
  return `<span class="ok">normal — 通常運用</span>`
}

/**
 * Issue #140: `lastRolledAt` の経過時間で badge 色を切替。
 *  - null:       未実行 (muted)
 *  - <24h:       OK (ok)
 *  - 24h–48h:    warning (warn)
 *  - >=48h:      error  (err)
 *
 * EOD cron は毎日 22:00 UTC に走るので 24h 以内なら正常、48h 超は **2 日連続
 * miss** で要調査。閾値は `runStrategyCron.emitStaleRollWarningIfNeeded` の
 * 24h と一貫させている。
 */
export function renderLastRolledCell(
  lastRolledAt: string | null,
  now: () => number = Date.now,
): string {
  if (lastRolledAt === null) {
    return `<span class="warn">未実行 (EOD cron 未到達 or PORTFOLIO_STATE 未配線)</span>`
  }
  const ms = new Date(lastRolledAt).getTime()
  if (!Number.isFinite(ms)) {
    return `<span class="err">${esc(lastRolledAt)} (parse 不能)</span>`
  }
  const elapsedHours = (now() - ms) / 3_600_000
  const formatted = esc(fmtJst(lastRolledAt))
  const elapsedLabel = `${elapsedHours.toFixed(1)}h 前`
  if (elapsedHours >= 48) {
    return `<span class="err">${formatted} <small>(${esc(elapsedLabel)}, 48h 超 — EOD cron 要確認)</small></span>`
  }
  if (elapsedHours >= 24) {
    return `<span class="warn">${formatted} <small>(${esc(elapsedLabel)}, 24h 超)</small></span>`
  }
  return `<span class="ok">${formatted} <small class="muted">(${esc(elapsedLabel)})</small></span>`
}
