import { loadPortfolioEquitySnapshots, type LoadPortfolioEquitySnapshotOptions } from '../../infrastructure/db/portfolioEquitySnapshotRepo'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import type { VixRegime } from '../../trading/risk/vixRegimeFilter'
import { ECHARTS_CDN } from './charts/shared'
import { esc, fmtJst, fmtNumber, safeJsonScript } from './shared'

export type EquityRange = '30d' | '90d' | '365d' | 'all'

export function parseEquityRange(value: string | undefined): EquityRange {
  if (value === '30d' || value === '90d' || value === '365d' || value === 'all') return value
  return '90d'
}

function equityRangeLimit(range: EquityRange): number {
  if (range === '30d') return 30
  if (range === '90d') return 90
  if (range === '365d') return 365
  return 3650
}

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

interface EquityHeroStats {
  latestUsd: number | null
  latestJpy: number | null
  deltaUsd: number | null
  deltaPct: number | null
}

// snapshots load oldest-first (portfolioEquitySnapshotRepo orders ASC to feed
// the chart directly), so the first USD value seen is the range start and the
// last is the current reading.
function computeHeroStats(snapshots: PortfolioEquitySnapshotRow[]): EquityHeroStats {
  let firstUsd: number | null = null
  let latestUsd: number | null = null
  let latestJpy: number | null = null
  for (const row of snapshots) {
    const usd =
      typeof row.dailyStartEquityUsd === 'number' && Number.isFinite(row.dailyStartEquityUsd)
        ? row.dailyStartEquityUsd
        : null
    const jpy =
      typeof row.dailyStartEquityJpy === 'number' && Number.isFinite(row.dailyStartEquityJpy)
        ? row.dailyStartEquityJpy
        : null
    if (usd !== null) {
      if (firstUsd === null) firstUsd = usd
      latestUsd = usd
    }
    if (jpy !== null) latestJpy = jpy
  }
  const deltaUsd = firstUsd !== null && latestUsd !== null ? latestUsd - firstUsd : null
  const deltaPct =
    deltaUsd !== null && firstUsd !== null && firstUsd !== 0 ? (deltaUsd / firstUsd) * 100 : null
  return { latestUsd, latestJpy, deltaUsd, deltaPct }
}

function renderHeroDelta(stats: EquityHeroStats): string {
  if (stats.deltaUsd === null || stats.deltaPct === null) return ''
  const cls = stats.deltaUsd > 0 ? 'ok' : stats.deltaUsd < 0 ? 'err' : 'muted'
  const sign = stats.deltaUsd > 0 ? '+' : ''
  return `<span class="hero-delta ${cls}">${sign}$${fmtNumber(stats.deltaUsd, 0)} (${sign}${stats.deltaPct.toFixed(1)}%)</span>`
}

function renderHeroValue(stats: EquityHeroStats): string {
  const usdText = stats.latestUsd !== null ? `$${fmtNumber(stats.latestUsd, 0)}` : '—'
  const jpyText =
    stats.latestJpy !== null ? `<span class="hero-jpy">(¥${fmtNumber(stats.latestJpy, 0)})</span>` : ''
  return `<div class="hero-row"><span class="kpi-value hero">${usdText}</span>${jpyText}${renderHeroDelta(stats)}</div>`
}

// Card title is "総資産" only (no "チャート" suffix) — the redesigned home
// treats this as the account's headline number, with the chart as supporting
// detail, not the other way around (#ui-redesign Lane B).
export function renderPortfolioEquityChart(
  snapshots: PortfolioEquitySnapshotRow[],
  range: EquityRange,
  basePath = '/dashboard/portfolio',
): string {
  const rangeTabs = renderEquityRangeTabs(range, basePath)
  const infoTip = `<span class="info-tip" tabindex="0" aria-label="総資産チャートの説明" data-tip="${esc(
    '日次ロール時点の口座総資産のスナップショット (現金・保有時価の合計)。確定損益の推移 (レビュー) とは別の指標で、JPY 換算はツールチップで確認できる。',
  )}">?</span>`
  const head = `<div class="card-head"><span class="card-title">総資産</span>${infoTip}<span class="card-actions">${rangeTabs}</span></div>`
  if (snapshots.length === 0) {
    return `${head}<p class="empty">まだ日次ロールの実行履歴がありません。<code>/admin/portfolio/roll-daily</code> を実行すると、ここに時系列が描画されます。</p>`
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
  const stats = computeHeroStats(snapshots)
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined' || typeof window.wtChart !== 'function') return;
      var t = window.wtTokens ? window.wtTokens() : {};
      var data = window.__equityChartData;
      var dates = data.usd.map(function (p) { return p.date; });
      function toRgba(hex, alpha) {
        var h = String(hex).replace('#', '');
        if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
        var r = parseInt(h.substring(0, 2), 16) || 0;
        var g = parseInt(h.substring(2, 4), 16) || 0;
        var b = parseInt(h.substring(4, 6), 16) || 0;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
      }
      // Single visible series (USD): a second axis for JPY competed with the
      // headline "is USD going up" line for attention, and the hero number
      // above already shows JPY — the tooltip formatter below still surfaces
      // it per-point without drawing it.
      var series = [{
        name: 'USD',
        type: 'line',
        data: data.usd.map(function (p) { return p.value; }),
        connectNulls: false,
        showSymbol: false,
        smooth: 0.25,
        lineStyle: { width: 2, color: t.accent },
        itemStyle: { color: t.accent },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: toRgba(t.accent, 0.22) },
            { offset: 1, color: toRgba(t.accent, 0) },
          ]),
        },
      }];
      // No in-canvas title (card head reads "総資産") and no legend — a
      // single-series chart has nothing to toggle.
      window.wtChart(document.getElementById('portfolio-equity-chart'), {
        tooltip: {
          trigger: 'axis',
          formatter: function (params) {
            var p = params && params[0];
            if (!p) return '';
            var idx = p.dataIndex;
            var usdVal = data.usd[idx] ? data.usd[idx].value : null;
            var jpyVal = data.jpy[idx] ? data.jpy[idx].value : null;
            var lines = [p.axisValueLabel || p.name];
            lines.push((p.marker || '') + ' $' + (usdVal == null ? '—' : Number(usdVal).toFixed(2)));
            if (jpyVal != null) lines.push('&nbsp;&nbsp;&nbsp;&nbsp;¥' + Number(jpyVal).toLocaleString('ja-JP'));
            return lines.join('<br/>');
          },
        },
        grid: { left: 46, right: 28, top: 16, bottom: 28, containLabel: true },
        xAxis: {
          type: 'category',
          data: dates,
          boundaryGap: false,
          axisLabel: {
            hideOverlap: true,
            formatter: function (value) { return String(value).slice(5).replace('-', '/'); },
          },
        },
        yAxis: { type: 'value', scale: true },
        series: series,
      });
    });
  `
  return `${head}
  ${renderHeroValue(stats)}
  <div id="portfolio-equity-chart" style="width:100%;height:260px"></div>
  ${safeJsonScript('__equityChartData', { usd: usdPoints, jpy: jpyPoints, hasUsd, hasJpy })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

function renderEquityRangeTabs(active: EquityRange, basePath = '/dashboard/portfolio'): string {
  const options: Array<{ id: EquityRange; label: string }> = [
    { id: '30d', label: '30日' },
    { id: '90d', label: '90日' },
    { id: '365d', label: '365日' },
    { id: 'all', label: '全期間' },
  ]
  const links = options
    .map((opt) => {
      const cls = opt.id === active ? 'tab tab-active' : 'tab'
      return `<a class="${cls}" href="${basePath}?range=${opt.id}">${opt.label}</a>`
    })
    .join(' ')
  return `<div class="seg">${links}</div>`
}

// The snapshot table stores only the regime label, not the VIX value itself —
// see strategy_decision_log's VIX reject reason if the number is needed.
export function renderVixRegimeCell(regime: VixRegime | null): string {
  if (regime === null) {
    return `<span class="muted">— (判定処理が未到達、または DB 未接続のため通常運用)</span>`
  }
  if (regime === 'critical') {
    return `<span class="err">critical: 新規買い停止 (売却は通常)</span>`
  }
  if (regime === 'warning') {
    return `<span class="warn">warning: 新規買いを縮小 (数量を減らす)</span>`
  }
  return `<span class="ok">normal: 通常運用</span>`
}

// 24h/48h thresholds mirror runStrategyCron.emitStaleRollWarningIfNeeded — keep the two in sync.
export function renderLastRolledCell(
  lastRolledAt: string | null,
  now: () => number = Date.now,
): string {
  if (lastRolledAt === null) {
    return `<span class="warn">未実行 (日次終業処理が未到達、またはポートフォリオ状態が未接続)</span>`
  }
  const ms = new Date(lastRolledAt).getTime()
  if (!Number.isFinite(ms)) {
    return `<span class="err">${esc(lastRolledAt)} (形式不正)</span>`
  }
  const elapsedHours = (now() - ms) / 3_600_000
  const formatted = esc(fmtJst(lastRolledAt))
  const elapsedLabel = `${elapsedHours.toFixed(1)}h 前`
  if (elapsedHours >= 48) {
    return `<span class="err">${formatted} <small>(${esc(elapsedLabel)}, 48h 超。日次終業処理を確認)</small></span>`
  }
  if (elapsedHours >= 24) {
    return `<span class="warn">${formatted} <small>(${esc(elapsedLabel)}, 24h 超)</small></span>`
  }
  return `<span class="ok">${formatted} <small class="muted">(${esc(elapsedLabel)})</small></span>`
}
