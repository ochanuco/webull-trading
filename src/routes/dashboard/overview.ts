import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import type { VixRegime } from '../../trading/risk/vixRegimeFilter'
import type { SymbolState } from '../../trading/state/types'
import { formatRealizedPnl } from './cron'
import { ECHARTS_CDN } from './charts/shared'
import { type EquityRange, renderPortfolioEquityChart, renderVixRegimeCell } from './portfolio'
import { pickFreshQuote } from './positions'
import { displaySymbol, esc, fmtJst, fmtNumber, safeJsonScript } from './shared'

export type OverviewPanel = 'risk' | 'activity'

export const ALL_OVERVIEW_PANELS: readonly OverviewPanel[] = ['risk', 'activity']

export const OVERVIEW_PANEL_LABELS: Record<OverviewPanel, string> = {
  risk: 'リスクと保有銘柄 (保有一覧 + 資産構成 / 含み損益ランキング)',
  activity: '最近の活動 (直近の約定 + 資産推移)',
}

// Maps old panel keys to their new area so a previously saved CSV keeps working without the
// operator having to reconfigure. `status` has no target: it's now always shown, not a panel.
const LEGACY_PANEL_MAP: Record<string, OverviewPanel | null> = {
  status: null,
  kpi: 'risk',
  positions: 'risk',
  composition: 'risk',
  equity: 'activity',
  recent: 'activity',
}

/** Invalid tokens are dropped; an empty or fully-invalid result falls back to all panels. */
export function parseOverviewPanels(csv: string | null | undefined): Set<OverviewPanel> {
  const set = new Set<OverviewPanel>()
  let sawLegacy = false
  for (const tok of (csv ?? '').split(',').map((s) => s.trim())) {
    if ((ALL_OVERVIEW_PANELS as readonly string[]).includes(tok)) {
      set.add(tok as OverviewPanel)
      continue
    }
    const mapped = LEGACY_PANEL_MAP[tok]
    if (mapped !== undefined) {
      sawLegacy = true
      if (mapped !== null) set.add(mapped)
    }
  }
  // An old CSV of just `status` maps to zero areas now that it's always shown; falling back to
  // all panels is closer to the operator's original intent than showing nothing.
  if (set.size === 0 && sawLegacy) return new Set(ALL_OVERVIEW_PANELS)
  return set.size === 0 ? new Set(ALL_OVERVIEW_PANELS) : set
}

export interface HomeRunSignals {
  /** 直近の戦略判定の時刻 (= cron が生きている証拠)。null なら判定ログが空。 */
  lastCronAt: string | null
  /** 直近 24h の critical / warning 件数。ack の概念はまだ無いので件数で代用。 */
  alertCritical: number
  alertWarning: number
}

/** 保有銘柄 1 件の「あと何 % で損切りか」。実効 stop は ATR / R:R cap で動く。 */
export interface StopDistanceView {
  /** 現在の含み損益 (%)。 */
  pnlPct: number
  /** 実効 stop (%、負値)。atr20 が無ければ pct stop。 */
  effectiveStopPct: number
  /** stop までの距離 (%、正値)。0 以下なら既に到達している。 */
  toStopPct: number
}

export interface OverviewData {
  panels: Set<OverviewPanel>
  /** 運転状態帯の追加シグナル。未取得 (DB 不在) は null。 */
  runSignals: HomeRunSignals | null
  /** symbol → 実効 stop までの距離。計算できない銘柄は不在。 */
  stopDistances: Map<string, StopDistanceView>
  /** 直近 30 日の成績 (勝ち / 負け / 発注エラー)。未取得は null。 */
  activityStats: { wins: number; losses: number; errors: number } | null
  portfolio: {
    dailyStartEquity: number
    dailyRealizedPnl: number
    openExposureUsd: number
    openExposureJpy: number
    tradingDisabledUntil: string | null
    updatedAt: string
  } | null
  snapshots: PortfolioEquitySnapshotRow[]
  range: EquityRange
  /** USDJPY レート (資産サマリ帯表示用)。取得失敗は null → "—" 表示。 */
  usdJpy: number | null
  /** SYMBOL_STATE binding の有無。false なら保有ポジションは誘導リンクのみ。 */
  symbolStateBound: boolean
  positions: Array<{ sym: string; state: SymbolState | null; error: string | null }>
  strategyPriceMap: Map<string, { price: number; asOf: string }>
  recentTrades: Array<{
    id: number
    timestamp: string
    symbol: string | null
    side: string | null
    filledQty: number | null
    filledPrice: number | null
    realizedPnl: number | null
    brokerStatus: string | null
  }>
  vixRegime: VixRegime | null
  dryRun: boolean
  tradingEnabled: boolean
  universe: SymbolUniverse
}

/** 開いている保有銘柄 (qty != 0) を評価額・含み損益% 付きで抽出。 */
interface OpenPositionView {
  sym: string
  qty: number
  currency: SymbolCurrency
  price: number | null
  marketValue: number | null
  pnlPct: number | null
}

// post_submit rows never carry `side` (only pre_submit does), so this self-joins on
// client_order_id to recover it — same approach as loadSymbolChart. A pre_submit-less legacy
// fill falls back to inferring side from whether realized_pnl is set (null=BUY, set=SELL).
export async function loadRecentFills(
  db: D1Database,
  limit: number,
): Promise<OverviewData['recentTrades']> {
  const result = await db
    .prepare(
      `SELECT ps.id AS id, ps.timestamp AS timestamp, ps.symbol AS symbol,
         COALESCE(pre.side, CASE WHEN ps.realized_pnl IS NOT NULL THEN 'SELL' ELSE 'BUY' END) AS side,
         ps.filled_qty AS filledQty, ps.filled_price AS filledPrice,
         ps.realized_pnl AS realizedPnl, ps.broker_status AS brokerStatus
       FROM trade_journal AS ps
       LEFT JOIN trade_journal AS pre
         ON pre.client_order_id = ps.client_order_id AND pre.trade_event_type = 'pre_submit'
       WHERE ps.trade_event_type = 'post_submit' AND ps.filled_price IS NOT NULL
       ORDER BY ps.id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: number
      timestamp: string
      symbol: string | null
      side: string | null
      filledQty: number | null
      filledPrice: number | null
      realizedPnl: number | null
      brokerStatus: string | null
    }>()
  return result.results ?? []
}

function collectOpenPositions(data: OverviewData): OpenPositionView[] {
  const out: OpenPositionView[] = []
  for (const r of data.positions) {
    const pos = r.state?.position
    if (!r.state || !pos || pos.qty === 0) continue
    const webull = r.state.lastQuote
      ? { price: r.state.lastQuote.price, source: r.state.lastQuote.source, asOf: r.state.lastQuote.asOf ?? r.state.lastQuote.fetchedAt }
      : null
    const yahoo = data.strategyPriceMap.get(r.state.symbol) ?? null
    const quote = pickFreshQuote(webull, yahoo)
    const price = quote?.price ?? null
    const pnlPct = price !== null && pos.avgPrice > 0 ? ((price - pos.avgPrice) / pos.avgPrice) * 100 : null
    out.push({
      sym: r.state.symbol,
      qty: pos.qty,
      currency: data.universe.symbolCurrency[r.state.symbol] ?? 'USD',
      price,
      marketValue: price !== null ? pos.qty * price : null,
      pnlPct,
    })
  }
  return out
}

// Not configurable/hideable like the panels below: mode, trading on/off, and quote freshness
// stay visible because hiding them risks an operator missing an unsafe state.
function renderRunStatePanel(data: OverviewData): string {
  const mode = data.dryRun
    ? { text: 'DRY-RUN', tone: 'hold' as const }
    : { text: 'LIVE', tone: 'live' as const }
  const trading = data.tradingEnabled
    ? { text: 'ON', tone: 'live' as const }
    : { text: 'OFF', tone: 'hold' as const }
  const cron = renderRelativeAge(data.runSignals?.lastCronAt ?? null, 20)
  const quote = latestQuoteFreshness(data)
  const crit = data.runSignals?.alertCritical ?? 0
  const warn = data.runSignals?.alertWarning ?? 0
  const alert =
    crit > 0
      ? { text: `${crit} critical`, tone: 'alarm' as const }
      : warn > 0
        ? { text: `${warn} warning`, tone: 'hold' as const }
        : { text: '0', tone: 'plain' as const }
  const card = (label: string, value: string, tone: 'live' | 'hold' | 'alarm' | 'plain') =>
    `<div class="state-card${tone === 'plain' ? '' : ` ${tone}`}"><div class="kpi-label">${esc(label)}</div><div class="state-value">${value}</div></div>`
  return `<div class="state-band">
    ${card('実行モード', esc(mode.text), mode.tone)}
    ${card('取引', esc(trading.text), trading.tone)}
    ${card('最終 cron', cron.html, cron.tone)}
    ${card('株価の鮮度', quote.html, quote.tone)}
    ${card('VIX レジーム', `<span style="font-size:13px;font-weight:400">${renderVixRegimeCell(data.vixRegime)}</span>`, 'plain')}
    ${card('未確認アラート', `<a href="/dashboard/alerts">${esc(alert.text)}</a>`, alert.tone)}
    <a class="state-kill" href="/dashboard/config" title="global_config で trading_enabled を切る">緊急停止</a>
  </div>`
}

// Callers pick staleMin to match their own cadence: 20min for the 15min cron cycle (some
// slack), 15min for quotes to match global_config.stale_quote_ms's default.
function renderRelativeAge(
  iso: string | null,
  staleMin: number,
): { html: string; tone: 'live' | 'hold' | 'plain' } {
  if (iso === null) return { html: '<span class="muted">—</span>', tone: 'plain' }
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return { html: '<span class="muted">—</span>', tone: 'plain' }
  const min = Math.floor((Date.now() - t) / 60000)
  const text = min < 1 ? '1 分未満' : min < 60 ? `${min} 分前` : `${Math.floor(min / 60)} 時間前`
  return { html: esc(text), tone: min >= staleMin ? 'hold' : 'live' }
}

// Reports the newest quote across all held/watched symbols: if the quote feed stops, every
// symbol goes stale together, so the freshest one is representative of the whole feed's health.
function latestQuoteFreshness(data: OverviewData): { html: string; tone: 'live' | 'hold' | 'plain' } {
  let latest: number | null = null
  for (const r of data.positions) {
    const q = r.state?.lastQuote
    const iso = q?.asOf ?? q?.fetchedAt
    if (!iso) continue
    const t = new Date(iso).getTime()
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t
  }
  for (const v of data.strategyPriceMap.values()) {
    const t = new Date(v.asOf).getTime()
    if (Number.isFinite(t) && (latest === null || t > latest)) latest = t
  }
  if (latest === null) return { html: '<span class="muted">—</span>', tone: 'plain' }
  return renderRelativeAge(new Date(latest).toISOString(), 15)
}

export function kpiCard(label: string, value: string, sub?: string, subClass?: string): string {
  const subHtml = sub ? `<div class="kpi-sub ${subClass ?? 'muted'}">${sub}</div>` : ''
  return `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${subHtml}</div>`
}

function renderRiskPanel(data: OverviewData, open: OpenPositionView[]): string {
  const exposurePill = renderExposurePill(data, open)
  if (!data.symbolStateBound) {
    return `<div class="panel"><div class="panel-title"><span>保有銘柄</span></div><p class="muted" style="margin:0">SYMBOL_STATE 未配線のため表示できません。</p></div>`
  }
  if (open.length === 0) {
    return `<div class="panel"><div class="panel-title"><span>保有銘柄 0 件</span>${exposurePill}</div><p class="muted" style="margin:0">保有中の銘柄はありません。</p></div>`
  }
  const rows = open
    .map((o) => {
      const stop = data.stopDistances.get(o.sym)
      const pnlCls = o.pnlPct === null ? '' : o.pnlPct >= 0 ? 'ok' : 'err'
      const state =
        stop === undefined
          ? '<span class="muted">—</span>'
          : stop.toStopPct <= 0
            ? '<span class="pill off">損切り水準</span>'
            : stop.toStopPct <= 2
              ? `<span class="pill warn">損切りまで ${fmtNumber(stop.toStopPct, 1)}%</span>`
              : '<span class="pill">保有継続</span>'
      return `<tr>
        <td class="grow"><a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(o.sym)}" title="${esc(displaySymbol(o.sym, data.universe))}">${esc(o.sym)}</a></td>
        <td class="num">${fmtNumber(o.qty, 0)}</td>
        <td class="num">${o.price === null ? '<span class="muted">—</span>' : fmtNumber(o.price, 2)}</td>
        <td class="num ${pnlCls}">${o.pnlPct === null ? '—' : `${fmtNumber(o.pnlPct, 2)}%`}</td>
        <td>${state}</td>
      </tr>`
    })
    .join('')
  return `<div class="panel">
    <div class="panel-title"><span>保有銘柄 ${open.length} 件 / エクスポージャー</span>${exposurePill}</div>
    <table class="fit">
      <thead><tr><th class="grow">銘柄</th><th class="num">数量</th><th class="num">現在値</th><th class="num">損益</th><th>状態</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="muted" style="font-size:12px;margin:10px 0 0">実効 stop は ATR と R:R 上限で銘柄ごとに変動します。詳細は <a href="/dashboard/charts?tab=symbol">銘柄</a> へ。</p>
  </div>`
}

/** 保有銘柄合計 / total_capital の比率 pill。total_capital 未設定なら件数のみ。 */
function renderExposurePill(data: OverviewData, open: OpenPositionView[]): string {
  const usd = open
    .filter((o) => o.currency === 'USD' && o.marketValue !== null)
    .reduce((a, o) => a + (o.marketValue ?? 0), 0)
  const cap = data.portfolio?.dailyStartEquity ?? 0
  if (!(cap > 0) || usd <= 0) return ''
  const pct = (usd / cap) * 100
  const cls = pct >= 60 ? 'warn' : ''
  return `<span class="pill ${cls}">開始 equity の ${fmtNumber(pct, 0)}%</span>`
}

function renderRecentPanel(data: OverviewData): string {
  const trades = data.recentTrades
    .map((t) => {
      const sideClass = t.side === 'BUY' ? 'ok' : t.side === 'SELL' ? 'err' : 'muted'
      const pnl = t.realizedPnl !== null ? formatRealizedPnl(t.realizedPnl) : '<span class="muted">—</span>'
      return `<tr>
        <td class="muted" style="font-size:12px">${esc(fmtJst(t.timestamp))}</td>
        <td class="grow"><strong title="${esc(displaySymbol(t.symbol ?? '—', data.universe))}">${esc(t.symbol ?? '—')}</strong></td>
        <td class="${sideClass}">${esc(t.side ?? '—')}</td>
        <td class="num">${t.filledQty !== null ? esc(t.filledQty) : '—'}</td>
        <td class="num">${t.filledPrice !== null ? fmtNumber(t.filledPrice, 2) : '—'}</td>
        <td class="num">${pnl}</td>
      </tr>`
    })
    .join('')
  const recentTable = data.recentTrades.length
    ? `<table class="fit"><thead><tr><th>時刻</th><th class="grow">銘柄</th><th>売買</th><th class="num">数量</th><th class="num">約定値</th><th class="num">実損益</th></tr></thead><tbody>${trades}</tbody></table>`
    : '<p class="muted">約定履歴がありません。</p>'
  // Mode / trading / VIX live in renderRunStatePanel now — not repeated here.
  return `<div class="panel">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:baseline"><span>直近の約定</span><span style="font-weight:400;font-size:12px"><a href="/dashboard/cron">判定ログ →</a></span></div>
    ${recentTable}
    <div style="margin-top:8px"><a href="/dashboard/trades">約定履歴をすべて見る →</a></div>
    ${activityFooter(data)}
  </div>`
}

/** Renders nothing (not a placeholder) when activityStats hasn't been loaded. */
function activityFooter(data: OverviewData): string {
  const st = data.activityStats
  if (st === null) return ''
  return `<p class="muted" style="font-size:12px;margin:10px 0 0">直近 30 日 ・ 勝ち ${st.wins} / 負け ${st.losses} ・ 発注エラー ${st.errors}</p>`
}

// Fetched client-side (not SSR) so a slow/failed /admin/buying-power call never blocks the
// page render; a failure degrades to a ⚠ badge instead of breaking the page.
export function buyingPowerBadge(): string {
  return `<div id="buying-power-badge" class="panel" style="display:flex;align-items:center;gap:8px;font-size:13px;padding:10px 14px">
    <strong>買付余力</strong> <span class="muted">読込中…</span>
  </div>
  <script>
  (function () {
    var el = document.getElementById('buying-power-badge');
    if (!el) return;
    fetch('/admin/buying-power', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { status: 'unavailable', reason: 'http ' + r.status }; })
      .then(function (d) {
        if (!d || d.status !== 'ok') {
          el.innerHTML = '<strong>買付余力</strong> <span style="color:#c22;font-weight:600">⚠ 取得不可</span>' +
            ' <span class="muted" style="font-size:11px">' + ((d && d.reason) ? String(d.reason).slice(0, 80) : '') + '</span>';
          return;
        }
        var parts = (d.byCurrency || []).map(function (a) {
          var bp = Number(a.buyingPower);
          var sym = a.currency === 'JPY' ? '¥' : (a.currency === 'USD' ? '$' : '');
          var v = isFinite(bp) ? bp.toLocaleString('ja-JP', { maximumFractionDigits: a.currency === 'JPY' ? 0 : 2 }) : a.buyingPower;
          var zero = isFinite(bp) && bp <= 0;
          return '<span style="' + (zero ? 'color:#86868b' : 'font-weight:600') + '">' + a.currency + ' ' + sym + v + '</span>';
        });
        el.innerHTML = '<strong>買付余力</strong> ' + (parts.join(' &nbsp;/&nbsp; ') || '—') +
          ' <span class="muted" style="font-size:11px">(口座 ' + (d.baseCurrency || '') + ' 総現金 ' + Number(d.totalCash).toLocaleString('ja-JP') + ')</span>';
      })
      .catch(function () {
        el.innerHTML = '<strong>買付余力</strong> <span style="color:#c22;font-weight:600">⚠ 取得不可</span>';
      });
  })();
  </script>`
}

// Each ECharts-using panel embeds its own CDN <script> tag so it works standalone; this
// collapses duplicates when more than one is enabled at once, to skip the redundant parse/exec.
function dedupeEchartsCdnTag(html: string): string {
  const tag = `<script src="${ECHARTS_CDN}" defer></script>`
  const parts = html.split(tag)
  if (parts.length <= 2) return html
  return parts[0] + tag + parts.slice(1).join('')
}

function areaLabel(text: string): string {
  return `<div class="area-label">${esc(text)}</div>`
}

export function overviewBody(data: OverviewData): string {
  const open = collectOpenPositions(data)
  const sections: string[] = []

  sections.push(renderRunStatePanel(data))

  if (data.panels.has('risk')) {
    sections.push(areaLabel('リスクと保有銘柄'))
    sections.push(renderRiskPanel(data, open))
  }

  if (data.panels.has('activity')) {
    sections.push(areaLabel('最近の活動'))
    sections.push(renderRecentPanel(data))
    sections.push(
      `<div class="panel">${renderPortfolioEquityChart(data.snapshots, data.range, '/dashboard')}</div>`,
    )
  }

  return dedupeEchartsCdnTag(buyingPowerBadge() + sections.join(''))
}
