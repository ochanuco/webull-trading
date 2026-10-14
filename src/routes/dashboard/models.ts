import type { ModelRegistryView } from '../adminModels'
import type { ReplayComparison } from '../../trading/models/replayComparison'
import type { ReplayMetrics } from '../../trading/models/replay'
import { ECHARTS_CDN } from './charts/shared'
import { esc, fmtJstCompact, safeJsonScript } from './shared'

export interface ModelsPageQuery {
  from: string
  to: string
  symbols: string
  modelIds: string
}

export function modelsBody(
  registry: ModelRegistryView,
  replay: { ok: true; data: ReplayComparison } | { ok: false; error: string },
  query: ModelsPageQuery,
): string {
  return [
    renderActiveCard(registry),
    renderReplayCard(replay, query),
    renderModelsCard(registry),
    renderDeploymentsCard(registry),
  ].join('')
}

function renderActiveCard(registry: ModelRegistryView): string {
  const active = registry.active
  const activeModel = active ? registry.models.find((m) => m.model.id === active.modelId)?.model : undefined
  const drift =
    registry.driftKeys.length > 0
      ? `<p class="warn" style="margin:8px 0 0">global_config がモデル昇格後に手動変更されています (${registry.driftKeys.map(esc).join(', ')})。稼働中モデルのリプレイは本番の挙動と一致しません。</p>`
      : ''
  const body = active
    ? `<p style="margin:0"><strong>#${active.modelId} ${esc(activeModel?.label ?? '')}</strong> <span class="muted">(${esc(registry.env)} / ${esc(fmtJstCompact(active.startedAt))} から稼働 / ${esc(active.actor)})</span></p>
       <p class="muted" style="margin:4px 0 0">${esc(active.reason)}</p>${drift}`
    : `<p class="empty">${esc(registry.env)} にはまだ昇格済みモデルがありません。<code>POST /admin/models</code> (<code>{"fromGlobalConfig":true}</code>) で現行設定を登録し、検証後に <code>/admin/models/:id/promote</code> で昇格します。</p>`
  return `<div class="card"><div class="card-head"><h2 class="card-title">稼働中モデル</h2></div><div class="card-body">${body}</div></div>`
}

function renderReplayCard(
  replay: { ok: true; data: ReplayComparison } | { ok: false; error: string },
  query: ModelsPageQuery,
): string {
  const form = `<form method="get" action="/dashboard/models" class="models-form">
      <label>開始 <input type="date" name="from" value="${esc(query.from)}"/></label>
      <label>終了 <input type="date" name="to" value="${esc(query.to)}"/></label>
      <label>銘柄 (CSV) <input type="text" name="symbols" value="${esc(query.symbols)}" placeholder="既定: 有効銘柄すべて"/></label>
      <label>モデル ID (CSV) <input type="text" name="modelIds" value="${esc(query.modelIds)}" placeholder="既定: 稼働実績のあるモデル"/></label>
      <button type="submit" class="btn primary">リプレイ</button>
    </form>`
  const head = `<div class="card-head"><h2 class="card-title">リプレイ比較</h2><span class="card-actions"><a href="/admin/models/replay?${replayQueryString(query)}">JSON</a></span></div>`
  if (!replay.ok) {
    return `<div class="card">${head}<div class="card-body">${form}<p class="warn">リプレイに失敗しました: ${esc(replay.error)}</p></div></div>`
  }
  const data = replay.data
  if (data.models.length === 0) {
    return `<div class="card">${head}<div class="card-body">${form}<p class="empty">登録済みモデルがありません。</p></div></div>`
  }
  const failed =
    data.failedSymbols.length > 0
      ? `<p class="warn">取得失敗で除外した銘柄: ${data.failedSymbols.map((f) => esc(`${f.symbol} (${f.error})`)).join(', ')}</p>`
      : ''
  const rows = data.models
    .map((m) => {
      const state = m.isActive
        ? '<span class="ok">稼働中</span>'
        : m.livePeriods.length > 0
          ? '<span class="muted">過去に稼働</span>'
          : '<span class="muted">候補</span>'
      return `<tr><td><strong>#${m.id}</strong> ${esc(m.label)}</td><td>${state}</td>${metricCells(m.result.metrics)}</tr>`
    })
    .join('')
  const chartData = {
    series: data.models.map((m) => ({
      name: `#${m.id} ${m.label}`,
      points: m.result.equityCurve.map((p) => [p.date, Number(((p.equity - 1) * 100).toFixed(3))]),
    })),
    promotions: data.models.flatMap((m) =>
      m.livePeriods
        .filter((p) => p.startedAt.slice(0, 10) >= data.from && p.startedAt.slice(0, 10) <= data.to)
        .map((p) => ({ date: p.startedAt.slice(0, 10), label: `#${m.id}` })),
    ),
  }
  return `<div class="card">${head}<div class="card-body">
    ${form}
    <p class="muted" style="font-size:12px;margin:6px 0">${esc(data.from)} 〜 ${esc(data.to)} / ${data.symbols.length} 銘柄 (${data.symbols.map(esc).join(', ')}) を各モデルで日足リプレイ。銘柄ごとに等金額で始めた場合の平均リターン。サイズ計算・リスクゲート・銘柄別上書きは含まない。縦線は昇格日。</p>
    ${failed}
    <div id="models-replay-chart" style="width:100%;height:300px"></div>
    <div class="tablewrap"><table>
      <thead><tr><th>モデル</th><th>状態</th>${METRIC_HEADERS}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div></div>
  ${safeJsonScript('__modelsReplayData', chartData)}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${REPLAY_CHART_SCRIPT}</script>`
}

function renderModelsCard(registry: ModelRegistryView): string {
  if (registry.models.length === 0) {
    return `<div class="card"><div class="card-head"><h2 class="card-title">登録モデル</h2></div><div class="card-body"><p class="empty">まだモデルがありません。</p></div></div>`
  }
  const rows = registry.models
    .map(({ model, runs, gate, promotable }) => {
      const oos = runs.find((r) => r.purpose === 'out_of_sample')
      const gateCell = !promotable
        ? '<span class="muted">昇格対象外 (バックテスト専用)</span>'
        : gate.passed
          ? '<span class="ok">通過</span>'
          : `<span class="warn" title="${esc(
              gate.checks
                .filter((c) => c.passed === false)
                .map((c) => c.message)
                .join('\n'),
            )}">未通過</span>`
      return `<tr>
        <td><strong>#${model.id}</strong> ${esc(model.label)}${model.parentModelId ? ` <span class="muted">(← #${model.parentModelId})</span>` : ''}</td>
        <td><code>${esc(model.spec.kind)}</code></td>
        <td><details><summary class="muted">表示</summary><pre style="font-size:11px;margin:4px 0 0">${esc(JSON.stringify(model.spec.params, null, 2))}</pre></details></td>
        <td>${runs.length}</td>
        <td>${oos ? `${esc(oos.fromDate)}〜${esc(oos.toDate)}<br/><span class="muted">return ${fmtSignedPct(oos.metrics.totalReturn)} / PF ${fmtNum(oos.metrics.profitFactor)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${gateCell}</td>
        <td>${esc(fmtJstCompact(model.createdAt))}</td>
      </tr>`
    })
    .join('')
  return `<div class="card"><div class="card-head"><h2 class="card-title">登録モデル</h2></div><div class="card-body tablewrap"><table>
    <thead><tr><th>モデル</th><th>種類</th><th>パラメタ</th><th>検証回数</th><th>直近の検証期間 (OOS)</th><th>昇格ゲート</th><th>登録</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`
}

function renderDeploymentsCard(registry: ModelRegistryView): string {
  if (registry.deployments.length === 0) return ''
  const rows = [...registry.deployments]
    .reverse()
    .map(
      (d) => `<tr>
        <td>#${d.modelId}</td>
        <td>${esc(fmtJstCompact(d.startedAt))}</td>
        <td>${d.endedAt ? esc(fmtJstCompact(d.endedAt)) : '<span class="ok">稼働中</span>'}</td>
        <td>${esc(d.actor)}</td>
        <td>${esc(d.reason)}</td>
        <td>${d.evidenceRunIds.map((id) => `#${id}`).join(', ') || '<span class="muted">—</span>'}</td>
      </tr>`,
    )
    .join('')
  return `<div class="card"><div class="card-head"><h2 class="card-title">昇格履歴 (${esc(registry.env)})</h2></div><div class="card-body tablewrap"><table>
    <thead><tr><th>モデル</th><th>開始</th><th>終了</th><th>実行者</th><th>理由</th><th>根拠の検証</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`
}

const METRIC_HEADERS =
  '<th>リターン</th><th>Sharpe</th><th>最大DD</th><th>取引数</th><th>勝率</th><th>PF</th><th>平均/取引</th><th>平均保有日</th><th>TP / SL / 時間切れ</th>'

function metricCells(m: ReplayMetrics): string {
  return [
    fmtSignedPct(m.totalReturn),
    fmtNum(m.sharpeRatio),
    fmtSignedPct(m.maxDrawdownPct),
    String(m.totalTrades),
    `${(m.winRate * 100).toFixed(1)}%`,
    fmtNum(m.profitFactor),
    fmtSignedPct(m.avgTradeReturn),
    m.avgHoldingDays.toFixed(1),
    `${m.exitReasons.TP} / ${m.exitReasons.STOP} / ${m.exitReasons.TIME_STOP}`,
  ]
    .map((v) => `<td>${v}</td>`)
    .join('')
}

function fmtSignedPct(v: number): string {
  if (!Number.isFinite(v)) return '<span class="muted">—</span>'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
}

function fmtNum(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '<span class="muted">—</span>' : v.toFixed(2)
}

function replayQueryString(q: ModelsPageQuery): string {
  return new URLSearchParams(
    Object.entries(q).filter(([, v]) => v.trim().length > 0) as Array<[string, string]>,
  ).toString().replace(/&/g, '&amp;')
}

export const MODELS_PAGE_STYLE = `
.models-form { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:flex-end; margin-bottom:8px }
.models-form label { display:flex; flex-direction:column; font-size:12px; gap:2px }
.models-form input[type=text] { min-width:180px }
`

const REPLAY_CHART_SCRIPT = `
  document.addEventListener('DOMContentLoaded', function () {
    if (typeof echarts === 'undefined' || typeof window.wtChart !== 'function') return;
    var data = window.__modelsReplayData;
    var el = document.getElementById('models-replay-chart');
    if (!data || !el) return;
    var marks = data.promotions.map(function (p) { return { xAxis: p.date, label: { formatter: p.label } }; });
    window.wtChart(el, {
      tooltip: { trigger: 'axis', valueFormatter: function (v) { return v == null ? '—' : Number(v).toFixed(2) + '%'; } },
      legend: { type: 'scroll', top: 0 },
      grid: { left: 46, right: 28, top: 36, bottom: 28, containLabel: true },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', scale: true, axisLabel: { formatter: '{value}%' } },
      series: data.series.map(function (s, i) {
        return {
          name: s.name,
          type: 'line',
          showSymbol: false,
          data: s.points,
          markLine: i === 0 && marks.length > 0 ? { symbol: 'none', silent: true, lineStyle: { type: 'dashed' }, data: marks } : undefined,
        };
      }),
    });
  });
`
