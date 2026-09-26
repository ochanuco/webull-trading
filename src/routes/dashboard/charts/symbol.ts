import type { SymbolUniverse } from '../../../infrastructure/db/symbolUniverse'
import type { SymbolRole } from '../../../infrastructure/db/symbolConfigRepo'
import { SYMBOL_ROLES } from '../../../infrastructure/db/symbolConfigRepo'
import type { BuyabilityView, EntryGateStatus } from '../../../trading/strategy/entryDistance'
import type { EntryStatus, EntryStatusResult } from '../../../trading/strategy/entryStatus'
import { PAIR_REGIME_ZONE_LABELS, type PairRegimeDecision } from '../../../trading/strategy/pairRegime'
import type { SymbolAllocation } from '../../../trading/strategy/conditionalAllocation'
import { MAX_CHART_DECISIONS, type SymbolChartData, type SymbolChartPoint, type SymbolChartPosition } from './loaders'
import { type ChartsBodyArgs, type ChartsBodySymbol, ECHARTS_CDN, type StrategyParamsSnapshot, SYMBOL_CHART_STATIC_PATH, type SymbolPolicySummary, type SymbolTabView, renderZoomPresetButtons } from './shared'
import { renderOverviewTab } from './equity'
import { renderQualityTab } from './quality'
import { type DecisionRow, localizeReason, renderDecisionTable } from '../cron'
import { currencyOfSymbol, displaySymbol, esc, fmtJst, fmtPctSigned, fmtPriceCcy, inactiveTooltip, isSymbolInactive } from '../shared'
import { SYMBOL_ROLE_LABELS, SYMBOL_ROLE_LABELS_SHORT } from '../symbols'

function renderSymbolDecisionHistory(args: ChartsBodySymbol): string {
  const rows = args.decisionRows ?? []
  if (rows.length === 0 || !args.focusSymbol) return ''
  const symbolCronHref = `/dashboard/cron?symbol=${encodeURIComponent(args.focusSymbol)}`
  return `<div style="margin-top:14px">
    <h2 class="section-head">判定履歴 <span class="muted" style="font-size:11px;font-weight:normal">直近 ${rows.length} 件 — チャートの判定 pin と同じデータ</span>
      <a href="${esc(symbolCronHref)}" style="font-size:11px">この銘柄の全件 →</a>
      <a href="/dashboard/trades?symbol=${encodeURIComponent(args.focusSymbol)}" style="font-size:11px">この銘柄の約定 →</a>
      <a href="/dashboard/cron" style="font-size:11px">全銘柄 →</a>
      <a href="/dashboard/charts/symbol/json?symbol=${encodeURIComponent(args.focusSymbol)}" target="_blank" rel="noreferrer" style="font-size:11px" title="チャート + 判定履歴の機械可読版 (#dashboard-json-api)">この銘柄の JSON →</a>
    </h2>
    ${renderDecisionTable(rows, args.universe, {
      copyVarName: '__decisionCopy',
      showSymbol: false,
      filterLabel: `symbol=${args.focusSymbol}, limit=30`,
    })}
  </div>`
}

function renderPairRegimeLine(
  view: { decision: PairRegimeDecision; side: 'bull' | 'bear'; mode: string } | null,
): string {
  if (!view) return ''
  const d = view.decision
  const color =
    d.zone === 'bull' ? '#057a55' : d.zone === 'bear' ? '#b25000' : d.zone === 'neutral' ? '#46608a' : '#c22'
  const sideJa = view.side === 'bull' ? 'ブル側' : 'ベア側'
  const allowed = (view.side === 'bull' && d.zone === 'bull') || (view.side === 'bear' && d.zone === 'bear')
  const verdict = allowed ? 'entry 可' : 'entry 不可'
  return `<div style="margin-top:8px;font-size:13px;color:#3a3a3c;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    ペアレジーム: <strong style="color:${color}">${esc(PAIR_REGIME_ZONE_LABELS[d.zone])}</strong>
    <span class="muted" style="font-size:12px">この銘柄は${sideJa} → ${verdict}${view.mode === 'observe' ? ' (observe: gate は未適用)' : ''}</span>
    <span class="muted" style="font-size:12px">${d.score !== null ? `score ${(d.score * 100).toFixed(2)}%` : ''} proxy ${esc(d.proxySymbol)}${d.asOfDate ? ` / ${esc(d.asOfDate)} 時点` : ''}</span>
    ${d.zone === 'unknown' ? `<span class="err" style="font-size:12px">${esc(d.reason)}</span>` : ''}
  </div>`
}

// Not renderAnalysisSubnav (layout.ts): this needs a dynamic href carrying
// the current `symbol=`, which that shared helper doesn't support.
const SYMBOL_VIEW_ITEMS: ReadonlyArray<{ key: SymbolTabView; label: string }> = [
  { key: 'chart', label: 'チャート' },
  { key: 'detail', label: '履歴・設定' },
]

export function renderSymbolViewSubnav(symbol: string, active: SymbolTabView): string {
  const items = SYMBOL_VIEW_ITEMS.map((i) => {
    const qs = i.key === 'detail' ? '&view=detail' : ''
    const href = `/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(symbol)}${qs}`
    if (i.key === active) return `<span class="subnav-link active">${esc(i.label)}</span>`
    return `<a class="subnav-link" href="${href}">${esc(i.label)}</a>`
  }).join('')
  return `<nav class="symbol-subnav">${items}</nav>`
}

/** Keep in sync with `DECISION_LABEL_JA` in symbolChartScript.ts (duplicated for server vs. client rendering). */
const DECISION_LABEL_JA: Record<string, string> = {
  BUY: '買い',
  SELL: '売り',
  SKIP: '見送り',
  REJECT: '拒否',
  ERROR: 'エラー',
  HOLD: '保有継続',
}

/** Keep in sync with `renderDecisionTable`'s pill coloring. */
function decisionPillClass(decision: string): string {
  if (decision === 'BUY') return 'ok'
  if (decision === 'SELL' || decision === 'SKIP') return 'warn'
  if (decision === 'ERROR' || decision === 'REJECT') return 'err'
  return 'neutral'
}

/** Holding: distance from current price to stop/TP. Not holding: condensed buyability verdict. */
export function renderConclusionValue(
  buyability: BuyabilityView | null,
  position: SymbolChartPosition | null,
  strategyParams: StrategyParamsSnapshot,
  latestCronPrice: number | null,
): { value: string; color: string } {
  if (position !== null) {
    const current = latestCronPrice ?? position.avgPrice
    if (!(current > 0)) return { value: '算出不可 (現在値なし)', color: '#86868b' }
    const stopPrice = position.avgPrice * (1 + strategyParams.stopPct)
    const tpPrice = position.avgPrice * (1 + strategyParams.takeProfitPct)
    const toStop = (stopPrice - current) / current
    const toTp = (tpPrice - current) / current
    return {
      value: `stop まで ${fmtPctSigned(toStop)} ／ TP まで ${fmtPctSigned(toTp)}`,
      color: '#3a3a3c',
    }
  }
  const cur = buyability?.current ?? null
  if (!cur) return { value: '判定データなし', color: '#86868b' }
  if (cur.buyable) return { value: '入場条件 充足（BUY 候補）', color: '#057a55' }
  if (cur.entryPrice !== null && cur.priceMove !== null) {
    const bottleneck = cur.bindingGate ? `（${esc(cur.bindingGate.labelJa)}）` : ''
    return {
      value: `入場まで あと 価格 ${fmtPctSigned(cur.priceMove)}${bottleneck}`,
      color: '#b25000',
    }
  }
  const g = cur.bindingGate
  return {
    value: g ? `価格でも入場不可 — ${esc(g.labelJa)}` : '評価不可',
    color: '#c22',
  }
}

/** The qty/$-PnL line is added only when `position.qty` is present — older fills derived without qty still render, percent-only. */
export function renderPositionSummaryValue(
  position: SymbolChartPosition | null,
  strategyParams: StrategyParamsSnapshot,
  latestCronPrice: number | null,
  ccy: string | null,
): string {
  if (!position) return '<span class="muted">未保有</span>'
  const current = latestCronPrice ?? position.avgPrice
  const pnlPct =
    position.avgPrice > 0 && current > 0 ? (current - position.avgPrice) / position.avgPrice : null
  const pnlCls = pnlPct === null ? 'muted' : pnlPct >= 0 ? 'ok' : 'err'
  const pnlText = pnlPct === null ? '—' : fmtPctSigned(pnlPct)
  const stopPrice = position.avgPrice * (1 + strategyParams.stopPct)
  const tpPrice = position.avgPrice * (1 + strategyParams.takeProfitPct)
  const qty = position.qty
  const qtyLine =
    typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && current > 0
      ? (() => {
          const pnlAmt = (current - position.avgPrice) * qty
          const pnlAmtCls = pnlAmt >= 0 ? 'ok' : 'err'
          const pnlAmtText = `${pnlAmt >= 0 ? '+' : '-'}${fmtPriceCcy(Math.abs(pnlAmt), ccy)}`
          return `<div class="muted" style="margin-top:2px">保有数量 ${esc(String(qty))}｜含み損益 $ <span class="${pnlAmtCls}">${esc(pnlAmtText)}</span></div>`
        })()
      : ''
  return `<div>平均取得 ${esc(fmtPriceCcy(position.avgPrice, ccy))}｜含み損益 <span class="${pnlCls}">${esc(pnlText)}</span></div>
    <div class="muted" style="margin-top:2px">stop ${esc(fmtPriceCcy(stopPrice, ccy))} ／ TP ${esc(fmtPriceCcy(tpPrice, ccy))}</div>
    ${qtyLine}`
}

/** `rows[0]` is the latest decision — caller must supply rows ordered id DESC. */
export function renderLatestDecisionValue(rows: DecisionRow[] | undefined): string {
  const row = rows?.[0]
  if (!row) return '<span class="muted">判定履歴なし</span>'
  const ja = DECISION_LABEL_JA[row.decision] ?? row.decision
  const cls = decisionPillClass(row.decision)
  return `<div><span class="pill ${cls}">${esc(row.decision)} (${esc(ja)})</span> <span class="muted" style="font-size:11px">${esc(fmtJst(row.timestamp))}</span></div>
    <div style="margin-top:2px">${esc(localizeReason(row.reason))}</div>`
}

/** `p` must be the resolved effective value (global → role preset → symbol override, via `buildSymbolRules`), not a raw symbol_config read — displaying raw config here previously drifted from what the strategy actually used. */
export function renderEffectiveRuleChips(p: StrategyParamsSnapshot): string {
  const pct = (n: number): string => (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
  return `<span class="chip">stop ${esc(pct(p.stopPct))}</span> <span class="chip">TP ${esc(pct(p.takeProfitPct))}</span> <span class="chip">time-stop ${p.timeStopDays}営業日</span>`
}

/** Returns '' when there's no chart data — the noData branch is handled by the caller instead. */
export function renderJudgmentSummaryGrid(args: ChartsBodySymbol): string {
  const chart = args.symbolChart
  if (!chart) return ''
  const ccy = args.focusSymbol ? currencyOfSymbol(args.focusSymbol) : null
  const conclusion = renderConclusionValue(
    args.buyability ?? null,
    chart.position,
    args.strategyParams,
    chart.latestCronPrice,
  )
  return `<div class="judgment-grid">
    <div class="judgment-card">
      <div class="jc-label">結論</div>
      <div class="jc-value" style="color:${conclusion.color}">${conclusion.value}</div>
    </div>
    <div class="judgment-card">
      <div class="jc-label">保有状態</div>
      <div class="jc-value">${renderPositionSummaryValue(chart.position, args.strategyParams, chart.latestCronPrice, ccy)}</div>
    </div>
    <div class="judgment-card">
      <div class="jc-label">直近判定</div>
      <div class="jc-value">${renderLatestDecisionValue(args.decisionRows)}</div>
    </div>
    <div class="judgment-card">
      <div class="jc-label">有効ルール</div>
      <div class="jc-value">${renderEffectiveRuleChips(args.strategyParams)}</div>
    </div>
  </div>`
}

/**
 * Not a normal executable `<script>` (`window.X = ...`): browsers don't run a
 * `<script>` inserted via `innerHTML`, which client-side partial swap does on
 * every symbol switch. `type="application/json"` is inert either way, so the
 * client reads it with `JSON.parse(el.textContent)` consistently on both full
 * page load and swap. The `<` escape stays regardless of `type`, since the
 * HTML parser treats `</script>` as a tag terminator independent of it.
 */
function chartDataScript(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script type="application/json" id="__chartData">${json}</script>`
}

/**
 * `#symbol-main` inner HTML, shared by the full page (`renderSymbolTab`) and
 * the partial endpoint (`GET /dashboard/charts?tab=symbol&...&partial=1`).
 */
export function renderSymbolMainInner(args: ChartsBodySymbol): string {
  const noData =
    args.symbolChart === null ||
    args.symbolChart.points.length === 0
  if (noData) {
    return (
      renderFocusSymbolHeader(args) +
      `<p class="muted">この銘柄にはまだ判定ログ / fill がありません。</p>` +
      renderStrategyParamsPanel(args.strategyParams, args.strategyParamsGlobal)
    )
  }
  // evalIndicators omitted: buyability is computed server-side, so the
  // client doesn't need per-point indicator data.
  const symbolChartPayload = args.symbolChart
    ? (({ evalIndicators: _omit, ...rest }) => ({
        ...rest,
        displayName: displaySymbol(args.symbolChart!.symbol, args.universe),
      }))(args.symbolChart)
    : null
  const projection = args.buyability?.projection ?? null
  // Single source for both the header's day-over-day diff and the chart's markLine.
  const prevClose = prevDailyClose(args.symbolChart)
  const prevCloseLabel =
    prevClose !== null
      ? `前日終値 ${fmtPriceCcy(prevClose, args.universe?.symbolCurrency[args.symbolChart!.symbol.toUpperCase()] ?? null)}`
      : null
  const view: SymbolTabView = args.view === 'detail' ? 'detail' : 'chart'
  const subnav = args.focusSymbol ? renderSymbolViewSubnav(args.focusSymbol, view) : ''
  const focusHeader = renderFocusSymbolHeader(args)

  const chartViewContent = `<div class="symbol-chart-pin">
  ${renderPriceHeader(args.symbolChart, args.universe)}
  <div id="symbol-chart" style="width:100%;height:380px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:8px"></div>
  ${renderZoomPresetButtons(args.symbolChart)}
  </div>
  ${renderSymbolPolicyLine(args.focusSymbol, args.symbolPolicy ?? null)}
  ${renderPairRegimeLine(args.pairRegime ?? null)}
  ${renderJudgmentSummaryGrid(args)}
  <details style="margin-top:10px">
    <summary style="cursor:pointer;font-size:13px">入場まで — ゲートチェックリスト・距離推移 (詳細)</summary>
    ${renderBuyabilityPanel(args.buyability ?? null, {
      entryStatus: args.entryStatus ?? null,
      currency: args.focusSymbol ? currencyOfSymbol(args.focusSymbol) : null,
    })}
  </details>
  ${renderDecisionPlotCaption(args.symbolChart)}
  <div id="decision-trace-panel" class="reason-panel" style="margin-top:10px;display:none"></div>`

  const detailViewContent = `
  ${renderSymbolDecisionHistory(args)}
  ${renderStrategyParamsPanel(args.strategyParams, args.strategyParamsGlobal)}`

  const content = `${subnav}${focusHeader}${view === 'detail' ? detailViewContent : chartViewContent}`
  return `${content}
  ${chartDataScript({
    symbolChart: symbolChartPayload,
    projection,
    prevClose,
    prevCloseLabel,
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  })}`
}

export function renderSymbolTab(args: ChartsBodySymbol): string {
  // Loads unconditionally even when this symbol has no chart data: the rail
  // can switch to a symbol that does, and echarts must already be loaded for
  // that client-side switch to initialize a chart.
  return `${wrapWithSymbolRail(args, renderSymbolMainInner(args))}
  <script src="${ECHARTS_CDN}" defer></script>
  <script src="${SYMBOL_CHART_STATIC_PATH}" defer></script>`
}

const ENTRY_STATUS_BADGE: Record<EntryStatus, { label: string; bg: string; fg: string }> = {
  ENTRY: { label: 'ENTRY', bg: '#e6f6ec', fg: '#057a55' },
  HALF: { label: 'HALF 0.5x', bg: '#fff4e6', fg: '#b25000' },
  WATCH: { label: 'WATCH', bg: '#eef2f8', fg: '#46608a' },
  NG: { label: 'NG', bg: '#fdecec', fg: '#c22' },
}

function entryStatusBadgeHtml(status: EntryStatus): string {
  const b = ENTRY_STATUS_BADGE[status]
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:${b.bg};color:${b.fg};font-weight:700;font-size:11px" title="段階判定 (#452): 発注対象は ENTRY / HALF のみ">${b.label}</span>`
}

/** Renders nothing when `alloc` is undefined (symbol has no target weight and received no reroute). */
export function renderAllocationLine(alloc: SymbolAllocation | undefined): string {
  if (!alloc) return ''
  const pct = (w: number) => `${Math.round(w * 1000) / 10}%`
  const changed = Math.abs(alloc.activeWeight - alloc.targetWeight) > 1e-9
  const color = alloc.activeWeight === 0 ? '#b25000' : changed ? '#057a55' : '#86868b'
  const arrow = changed ? ` → <strong>${pct(alloc.activeWeight)}</strong>` : ''
  const reroute = alloc.rerouteTo ? `（${esc(alloc.rerouteTo)} へ退避中）` : ''
  const rerouted = alloc.reroutedInWeight > 0 ? `（+${pct(alloc.reroutedInWeight)} 退避受入）` : ''
  return `<div style="font-size:11px;color:${color};margin-bottom:4px" title="${esc(alloc.reason)}">配分 target ${pct(alloc.targetWeight)}${arrow}${reroute}${rerouted}</div>`
}

/** Renders nothing when role/weight/entryRequired/alwaysActive/cashFallback are all unset, so unconfigured symbols show no noise. */
export function renderSymbolPolicyLine(
  symbol: string | null,
  policy: SymbolPolicySummary | null,
): string {
  if (!symbol || !policy) return ''
  const hasAny =
    policy.role !== null ||
    policy.targetWeight !== null ||
    policy.entryRequired ||
    policy.alwaysActive ||
    policy.cashFallbackSymbols !== null
  if (!hasAny) return ''
  const parts: string[] = []
  if (policy.role !== null) {
    const known = (SYMBOL_ROLES as readonly string[]).includes(policy.role)
    parts.push(
      known
        ? `ロール: <code style="font-size:12px" title="${esc(SYMBOL_ROLE_LABELS[policy.role as SymbolRole])}">${esc(policy.role)}</code>: <strong>${esc(SYMBOL_ROLE_LABELS_SHORT[policy.role as SymbolRole])}</strong>`
        : `ロール: <span class="err" title="不正な role 値 — entry は抑止されます (fail-closed)">⚠ ${esc(policy.role)}</span>`,
    )
  }
  if (policy.targetWeight !== null) {
    parts.push(`配分 target ${Math.round(policy.targetWeight * 1000) / 10}%`)
  }
  if (policy.alwaysActive) parts.push('<span title="判定に関わらず常時 target = active">常時配分</span>')
  if (policy.entryRequired) parts.push('<span title="entry 判定 (ENTRY/HALF) 通過時のみ実配分有効">条件連動</span>')
  if (policy.cashFallbackSymbols !== null) {
    parts.push(
      `退避先 ${policy.cashFallbackSymbols.map((fb) => `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(fb)}">${esc(fb)}</a>`).join(' / ')}`,
    )
  }
  return `<div style="margin-top:8px;font-size:13px;color:#3a3a3c;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
    ${parts.join('<span style="color:#d0d0d5">｜</span>')}
    <a href="/dashboard/symbols/${encodeURIComponent(symbol)}/edit" style="font-size:12px">設定変更</a>
  </div>`
}

/** Mirrors `PullbackUptrendStrategy.TEST_DEFAULT_RULE` — keep in sync; used only to flag values that differ from the code default. */
const STRATEGY_DEFAULTS: StrategyParamsSnapshot = {
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.0,
  maxSma50DeviationPct: 0.6,
  maxAtrRatio: 1.5,
  maxStopToTpRatio: 2.0,
  reentryMinAtrBelowLastExit: 1.0,
  reentryGuardBusinessDays: 3,
}

/** Flags values that differ from `STRATEGY_DEFAULTS` so a leftover debug override (e.g. `pullbackMax=0`) stands out. */
export function renderStrategyParamsPanel(
  p: StrategyParamsSnapshot,
  globalParams?: StrategyParamsSnapshot,
): string {
  const flag = (current: number | boolean, def: number | boolean): string =>
    current === def ? '' : ' <span class="warn" title="default 値から変更">⚠</span>'
  // Tags a row "symbol-specific" only when the effective value differs from
  // global — without this, an override that happens to match global would
  // read as an unmodified global value.
  const symbolTag = (key: keyof StrategyParamsSnapshot): string =>
    globalParams !== undefined && p[key] !== globalParams[key]
      ? ' <span style="font-size:10px;padding:1px 5px;border-radius:8px;background:#e8f0fe;color:#1a56db" title="role preset / 銘柄別 override 由来 (global と異なる)">銘柄別</span>'
      : ''
  const pct = (n: number): string =>
    (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
  const rows: Array<{ label: string; key: keyof StrategyParamsSnapshot; current: string; def: string; flag: string }> = [
    {
      label: '損切ライン (stopPct)',
      key: 'stopPct',
      current: pct(p.stopPct),
      def: pct(STRATEGY_DEFAULTS.stopPct),
      flag: flag(p.stopPct, STRATEGY_DEFAULTS.stopPct),
    },
    {
      label: '利食ライン (takeProfitPct)',
      key: 'takeProfitPct',
      current: pct(p.takeProfitPct),
      def: pct(STRATEGY_DEFAULTS.takeProfitPct),
      flag: flag(p.takeProfitPct, STRATEGY_DEFAULTS.takeProfitPct),
    },
    {
      label: '時間切れ (timeStopDays)',
      key: 'timeStopDays',
      current: `${p.timeStopDays} 営業日`,
      def: `${STRATEGY_DEFAULTS.timeStopDays} 営業日`,
      flag: flag(p.timeStopDays, STRATEGY_DEFAULTS.timeStopDays),
    },
    {
      label: '押し目 上限 (pullbackMax)',
      key: 'pullbackMax',
      current: pct(p.pullbackMax),
      def: pct(STRATEGY_DEFAULTS.pullbackMax),
      flag: flag(p.pullbackMax, STRATEGY_DEFAULTS.pullbackMax),
    },
    {
      label: '押し目 下限 (pullbackMin)',
      key: 'pullbackMin',
      current: pct(p.pullbackMin),
      def: pct(STRATEGY_DEFAULTS.pullbackMin),
      flag: flag(p.pullbackMin, STRATEGY_DEFAULTS.pullbackMin),
    },
    {
      // Field kept as `minReturn50d` for global_config column compat even
      // though the actual lookback is 20 business days.
      label: '20日騰落率 閾値 (minReturn50d)',
      key: 'minReturn50d',
      current: pct(p.minReturn50d),
      def: pct(STRATEGY_DEFAULTS.minReturn50d),
      flag: flag(p.minReturn50d, STRATEGY_DEFAULTS.minReturn50d),
    },
    {
      label: 'SMA50 上 必須 (requireAboveSma50)',
      key: 'requireAboveSma50',
      current: p.requireAboveSma50 ? 'true' : 'false',
      def: STRATEGY_DEFAULTS.requireAboveSma50 ? 'true' : 'false',
      flag: flag(p.requireAboveSma50, STRATEGY_DEFAULTS.requireAboveSma50),
    },
    {
      label: 'ATR 倍率 (kAtr、サイジング用)',
      key: 'kAtr',
      current: p.kAtr.toFixed(2),
      def: STRATEGY_DEFAULTS.kAtr.toFixed(2),
      flag: flag(p.kAtr, STRATEGY_DEFAULTS.kAtr),
    },
  ]
  const tbody = rows
    .map(
      (r) =>
        `<tr><th>${esc(r.label)}</th><td>${esc(r.current)}${r.flag}${symbolTag(r.key)}</td><td class="muted">${esc(r.def)}</td></tr>`,
    )
    .join('')
  return `<details open style="margin-top:12px">
    <summary style="cursor:pointer;font-size:13px">戦略パラメータ (PullbackUptrendStrategy${globalParams !== undefined ? ' — この銘柄に適用される値' : ''}) — <span class="muted">⚠ は default から変更されている項目</span></summary>
    <table style="margin-top:8px">
      <thead><tr><th>項目</th><th>現在値</th><th>default</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">
      「銘柄別」タグは role preset / 銘柄管理の override 由来 (設定は 銘柄管理 → 編集)。
      global の変更は 設定ページ (pullback_default_*)。
    </p>
  </details>`
}

const JST_MD_FMT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
})

function fmtGateValue(g: EntryGateStatus, currency: string | null = null): string {
  const sym = ({ '>': '>', '>=': '≥', '<': '<', '<=': '≤' } as Record<string, string>)[g.operator] ?? g.operator
  const price = (v: number): string => fmtPriceCcy(v, currency)
  switch (g.key) {
    case 'trend':
      return `20日騰落率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'overextension':
      return `移動平均乖離率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'pullback_shallow':
    case 'pullback_deep':
      return `押し目率 ${fmtPctSigned(g.actual)} ${sym} ${fmtPctSigned(g.threshold)}`
    case 'above_sma50':
      return `株価 ${price(g.actual)} ${sym} SMA50 ${price(g.threshold)}`
    case 'volatility':
      return `ATR倍率 ${g.actual.toFixed(2)}× ${sym} ${g.threshold.toFixed(2)}×`
    case 'high20d_valid':
      return `直近高値 ${price(g.actual)} ${sym} ${price(g.threshold)}`
  }
}

export interface BuyabilityPanelContext {
  /** null = badge omitted. */
  entryStatus?: EntryStatusResult | null
  /** Defaults to $ when unset. */
  currency?: string | null
}

/** "How far until entry" panel: verdict headline, distance trend bars, extrapolated ETA, and the gate checklist. Returns '' without current buyability data. */
export function renderBuyabilityPanel(
  buyability: BuyabilityView | null,
  ctx: BuyabilityPanelContext = {},
): string {
  if (!buyability || !buyability.current) return ''
  const cur = buyability.current
  const status = ctx.entryStatus ?? null
  const ccy = ctx.currency ?? null

  // --- 結論 ---
  let headline: string
  let headColor: string
  if (cur.buyable) {
    headline =
      '現在 入場条件を充足（cron 評価では BUY 候補。実発注は資金 / 単元など発注側ゲート次第）'
    headColor = '#057a55'
  } else if (cur.entryPrice !== null && cur.priceMove !== null) {
    const dir = cur.priceMove < 0 ? '下落' : '上昇'
    const binding = cur.bindingGate ? ` ／ ボトルネック: ${esc(cur.bindingGate.labelJa)}` : ''
    headline = `入場まで: あと 価格 <strong>${fmtPctSigned(cur.priceMove)}</strong>（${fmtPriceCcy(cur.entryPrice, ccy)} 到達 = ${dir}）${binding}`
    headColor = '#b25000'
  } else {
    const g = cur.bindingGate
    const why = g
      ? g.priceDependent
        ? '押し目ゾーンと過熱上限が同時に成立しない局面です。'
        : 'この指標が条件を満たすまでは、価格がどこでも入場しません。'
      : ''
    headline = g
      ? `価格を動かすだけでは入場不可 — ボトルネック: <strong>${esc(g.labelJa)}</strong>（${esc(fmtGateValue(g, ccy))} 不成立）。${why}`
      : '入場条件 評価不可'
    headColor = '#c22'
  }

  // --- 距離の推移 (mini bars) ---
  const movePts = buyability.series.filter(
    (p): p is typeof p & { priceMove: number } => p.priceMove !== null,
  )
  const recent = movePts.slice(-8)
  let trendBlock = ''
  if (recent.length > 0) {
    const maxGap = Math.max(...recent.map((p) => Math.abs(p.priceMove)), 1e-9)
    const bars = recent
      .map((p, i) => {
        const gap = Math.abs(p.priceMove)
        const w = Math.max(2, Math.round((gap / maxGap) * 90))
        const last = i === recent.length - 1
        const color = last ? headColor : '#c9c9cf'
        const md = JST_MD_FMT.format(new Date(p.timestamp))
        return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.5">
          <span style="width:34px;color:#86868b;text-align:right">${esc(md)}</span>
          <span style="display:inline-block;height:8px;width:${w}px;background:${color};border-radius:2px"></span>
          <span style="font-variant-numeric:tabular-nums">${fmtPctSigned(p.priceMove)}</span>
        </div>`
      })
      .join('')
    const trendLabel =
      buyability.trend === 'closing'
        ? '<span style="color:#057a55">縮小中（入場に近づいている）</span>'
        : buyability.trend === 'widening'
          ? '<span style="color:#b25000">拡大中（入場から遠ざかっている）</span>'
          : buyability.trend === 'flat'
            ? '<span class="muted">横ばい</span>'
            : '<span class="muted">判定不能</span>'
    trendBlock = `<div style="margin-top:8px"><strong>距離の推移</strong>(入場までの価格距離)：${trendLabel}
      <div style="margin-top:4px">${bars}</div></div>`
  } else {
    trendBlock = `<div style="margin-top:8px" class="muted">距離の推移: 価格距離が算出できる評価日がありません（価格非依存ゲートが要因）。</div>`
  }

  // --- 参考 ETA ---
  let etaBlock = ''
  if (buyability.etaTradingDays !== null && buyability.trend === 'closing') {
    const days = Math.max(1, Math.ceil(buyability.etaTradingDays))
    etaBlock = `<div style="margin-top:8px"><strong>参考 ETA</strong>: このペースが続けば 約 ${days} 営業日
      <div class="muted" style="font-size:11px">⚠ 外挿の参考値・予測ではない（相場が逆行すれば遠のく / 押し目バンドも日々動く）</div></div>`
  }

  // --- ゲートチェックリスト ---
  const gateRows = cur.gates
    .map((g) => {
      const ok = g.passed
      const binding = cur.bindingGate?.key === g.key
      const mark = ok ? '✅' : '❌'
      const bg = ok ? '#f1f8f4' : '#fdf0f0'
      const border = binding ? 'border-left:3px solid #c22;' : 'border-left:3px solid transparent;'
      const tag = binding ? ' <span style="color:#c22;font-weight:600">◀ ボトルネック</span>' : ''
      return `<div style="display:flex;align-items:baseline;gap:8px;padding:3px 8px;background:${bg};${border}border-radius:4px;font-size:12px;flex-wrap:wrap">
        <span>${mark}</span><span>${esc(g.labelJa)}</span>
        <span style="color:#555;font-variant-numeric:tabular-nums">${esc(fmtGateValue(g, ccy))}</span>${tag}
      </div>`
    })
    .join('')

  // --- 段階判定 badge + HALF 説明 ---
  const statusBadge = status ? entryStatusBadgeHtml(status.status) : ''
  let halfNote = ''
  if (status?.status === 'HALF' && status.halfGate) {
    halfNote = `<div style="margin-top:6px;font-size:12px;color:#b25000">HALF: 未通過は「${esc(status.halfGate.labelJa)}」のみで閾値の許容バンド内 → 0.5x サイジングで entry 候補 (role が entry 有効な銘柄のみ発注対象)。</div>`
  }

  return `<div class="reason-panel" style="margin-top:10px;max-width:1000px">
    <div style="font-size:13px;color:${headColor};margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">${statusBadge}<span>${headline}</span></div>
    ${halfNote}
    <div class="panel-row" style="gap:8px 20px">
      <div>${trendBlock}${etaBlock}</div>
      <div style="margin-top:8px"><strong>入場ゲート</strong>(全条件。閾値は global 既定 + role preset + 銘柄 override、#452)
        <div style="margin-top:4px;display:flex;flex-direction:column;gap:3px">${gateRows}</div>
      </div>
    </div>
  </div>`
}

/** Shows a truncation note once `decisions.length >= MAX_CHART_DECISIONS`, rather than silently capping. Colors mirror the chart's DECISION_COLORS. */
export function renderDecisionPlotCaption(chart: SymbolChartData | null): string {
  const decisions = chart?.decisions ?? []
  if (decisions.length === 0) return ''
  const dot = (color: string, label: string): string =>
    `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span style="width:9px;height:9px;border-radius:50%;background:${color};box-shadow:0 0 0 1px #fff,0 0 0 2px ${color}"></span>${esc(label)}</span>`
  const capped =
    decisions.length >= MAX_CHART_DECISIONS
      ? ` <span class="muted">(直近 ${MAX_CHART_DECISIONS} 件まで表示)</span>`
      : ''
  return `<p class="muted" style="font-size:12px;margin:6px 0 2px">
    ● は cron の判定イベント。点をクリックすると下に判定トレースが出ます (文字ログとグラフを同期)。HOLD (保有継続 / 様子見) は省略。${capped}
  </p>
  <div style="font-size:12px;margin:0 0 4px">
    ${dot('#057a55', '買い (BUY)')}${dot('#1471a8', '売り (SELL)')}${dot('#b25000', '見送り・bot判定 (SKIP)')}${dot('#7c3aed', '拒否・証券会社 (REJECT)')}${dot('#c22', 'エラー (ERROR)')}
  </div>`
}

export function prevDailyClose(chart: SymbolChartData | null): number | null {
  const pts = chart?.points ?? []
  if (pts.length < 2) return null
  const v = pts[pts.length - 2]!.price
  return Number.isFinite(v) ? v : null
}

export function renderPriceHeader(
  chart: SymbolChartData | null,
  universe?: SymbolUniverse | null,
): string {
  if (!chart || chart.points.length === 0) return ''
  const last = chart.points[chart.points.length - 1]!
  const cur = chart.latestCronPrice ?? last.price
  if (!Number.isFinite(cur)) return ''
  const ccy = universe?.symbolCurrency[chart.symbol.toUpperCase()] ?? null
  const prev = prevDailyClose(chart)
  let changeHtml = ''
  if (prev !== null && prev > 0) {
    const diff = cur - prev
    const pct = (diff / prev) * 100
    const up = diff >= 0
    // 日本式: 上昇=赤 / 下落=緑 (Google Finance JA と同じ)
    const color = up ? '#d23f31' : '#188038'
    const arrow = up ? '▲' : '▼'
    const sign = up ? '+' : ''
    changeHtml = ` <span style="font-size:14px;font-weight:600;color:${color};margin-left:6px">${arrow} ${sign}${pct.toFixed(2)}% (${sign}${diff.toFixed(2)}) 前日比</span>`
  }
  // 最新の indicator 付き point (Yahoo filler は indicators null)
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  const subItems: Array<[string, string]> = latest
    ? [
        ['SMA50', fmt(latest.sma50)],
        ['high20d', fmt(latest.high20d)],
        ['low20d', fmt(latest.low20d)],
      ]
    : []
  const sub = subItems
    .map(
      ([k, v]) =>
        `<span style="display:inline-block;margin-right:10px;font-size:12px"><span class="muted">${esc(k)}:</span> <strong>${esc(v)}</strong></span>`,
    )
    .join('')
  return `<div style="margin:2px 0 0">
    <span style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${esc(fmtPriceCcy(cur, ccy))}</span>${changeHtml}
  </div>
  ${sub ? `<p style="margin:2px 0 0">${sub}</p>` : ''}`
}

function renderSymbolRail(args: ChartsBodySymbol): string {
  if (args.availableSymbols.length === 0) return ''
  // Carries the current zoom range into rail links so switching symbols keeps it.
  const zoomQs = args.zoom
    ? `&from=${encodeURIComponent(args.zoom.from.toISOString())}&to=${encodeURIComponent(args.zoom.to.toISOString())}`
    : ''
  const items = args.availableSymbols
    .map((s) => {
      const inactive = isSymbolInactive(s, args.universe)
      const isFocus = s === args.focusSymbol
      const name = args.universe?.symbolName[s.toUpperCase()] ?? ''
      const cls = ['rail-item', isFocus ? 'active' : '', inactive ? 'inactive' : '']
        .filter(Boolean)
        .join(' ')
      const titleAttr = inactive
        ? ` title="${esc(inactiveTooltip(s, args.universe))}"`
        : name
          ? ` title="${esc(name)}"`
          : ''
      return `<a class="${cls}" href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(s)}${zoomQs}"${titleAttr}>
        <span class="rail-sym">${esc(s)}</span>${name ? `<span class="rail-name">${esc(name)}</span>` : ''}
      </a>`
    })
    .join('')
  return `<aside class="symbol-rail"><div class="rail-head">銘柄</div>${items}</aside>`
}

function wrapWithSymbolRail(args: ChartsBodySymbol, content: string): string {
  const rail = renderSymbolRail(args)
  // `id="symbol-main"` must stay stable even with no rail (zero symbols):
  // the client swap target keys off this id regardless of layout.
  if (!rail) return `<div id="symbol-main">${content}</div>`
  return `<div class="symbol-layout">${rail}<div id="symbol-main" class="symbol-main">${content}</div></div>`
}

/** Always rendered (not just when the rail is hidden, e.g. mobile) so the viewed symbol is identifiable on its own. */
function renderFocusSymbolHeader(args: ChartsBodySymbol): string {
  if (!args.focusSymbol) return ''
  const focusInactive = isSymbolInactive(args.focusSymbol, args.universe)
  const focusLabel = displaySymbol(args.focusSymbol, args.universe)
  const note = focusInactive
    ? ` <span class="muted" style="font-size:11px">(inactive — ${esc(
        args.universe?.symbolNotes[args.focusSymbol.toUpperCase()] ?? 'cron 評価対象外',
      )})</span>`
    : ''
  return `<p class="muted" style="font-size:12px;margin:0 0 4px">銘柄: <strong>${esc(focusLabel)}</strong>${note}</p>`
}

export function chartsBody(args: ChartsBodyArgs): string {
  if (args.tab === 'overview') return renderOverviewTab(args)
  if (args.tab === 'quality') return renderQualityTab(args)
  return renderSymbolTab(args)
}
