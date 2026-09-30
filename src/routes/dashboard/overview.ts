import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import type { VixRegime } from '../../trading/risk/vixRegimeFilter'
import type { SymbolState } from '../../trading/state/types'
import { formatRealizedPnl } from './cron'
import { ECHARTS_CDN } from './charts/shared'
import { type EquityRange, renderPortfolioEquityChart, renderVixRegimeCell } from './portfolio'
import { pickFreshQuote } from './positions'
import { JST_FORMATTER, displaySymbol, esc, fmtJst, fmtNumber, fmtPriceCcy } from './shared'

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
  /** 直近 30 日の成績 (勝ち / 負け / 発注エラー / 実現損益合計)。未取得は null。 */
  activityStats: { wins: number; losses: number; errors: number; realizedPnlSum: number } | null
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
  avgPrice: number
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
      avgPrice: pos.avgPrice,
      price,
      marketValue: price !== null ? pos.qty * price : null,
      pnlPct,
    })
  }
  return out
}

// Page-scoped CSS for pieces the shared STYLE doesn't already cover (run-state
// dot, hero-number layout). Kept out of layout.ts's STYLE per #ui-redesign so
// a home-only tweak never risks every other page's <style> block.
export const OVERVIEW_PAGE_STYLE = `
  .stat-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;background:var(--text-3)}
  .stat-dot.live{background:var(--up)}
  .stat-dot.hold{background:var(--warn)}
  .stat-dot.alarm{background:var(--down)}
  .stat-note{font-size:12.5px;font-weight:400}
  .hero-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:2px 0 14px}
  .hero-row .hero-jpy{font-size:14px;font-weight:400;color:var(--text-2)}
  .hero-row .hero-delta{font-size:14px;font-variant-numeric:tabular-nums}
  .mini-note{font-size:12px;color:var(--text-3);margin:8px 0 0}
  .stop-bar-wrap{min-width:88px}
  .stop-bar-track{width:80px}
  .kpi-hero-line{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .kpi-hero-line .kpi-value{font-size:28px}
  /* 4 flat cells sharing one surface-2 strip with vertical dividers, instead
     of 4 individually-bordered .kpi-card boxes nested inside an already
     bordered card. "エラー" (not 発注エラー) keeps every label readable at
     12px down to 390px without a narrow-viewport font shrink (12px is the
     info-row floor — never go below it, not even at phone width). */
  .flat-stats{display:flex;background:var(--surface-2);border-radius:var(--radius-sm);padding:10px 4px;margin-top:12px}
  .flat-stats .fstat{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;padding:0 6px;border-left:1px solid var(--border)}
  .flat-stats .fstat:first-child{border-left:none}
  .flat-stats .fstat .stat-value{font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
  .empty-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .empty-row .empty{text-align:right;padding:0}
  /* 保有銘柄 compact list (right column, 4-col width): ticker+qty/avg on the
     left, pnl% + stop bar stacked on the right — no table, since a 6-column
     table header doesn't fit a ~320px column without wrapping. */
  .holding-list{display:flex;flex-direction:column}
  .holding-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
  .holding-row:last-child{border-bottom:none}
  .holding-main{display:flex;flex-direction:column;gap:2px;min-width:0}
  .holding-sym{font-weight:600;font-size:13px}
  .holding-sub{font-size:12px;color:var(--text-3)}
  .holding-side{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:0 0 auto}
  .holding-side .num{font-size:13px;font-weight:650}
`

// Not configurable/hideable like the panels below: mode, trading on/off, and quote freshness
// stay visible because hiding them risks an operator missing an unsafe state.
function renderRunStateStrip(data: OverviewData): string {
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
  const stat = (label: string, valueHtml: string, tone: 'live' | 'hold' | 'alarm' | 'plain') => {
    const dot = tone === 'plain' ? '' : `<span class="stat-dot ${tone}"></span>`
    return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${dot}${valueHtml}</div></div>`
  }
  return `<div class="stat-strip">
    ${stat('実行モード', esc(mode.text), mode.tone)}
    ${stat('取引', esc(trading.text), trading.tone)}
    ${stat('最終 cron', cron.html, cron.tone)}
    ${stat('株価の鮮度', quote.html, quote.tone)}
    ${stat('VIX レジーム', `<span class="stat-note">${renderVixRegimeCell(data.vixRegime)}</span>`, 'plain')}
    ${stat('未確認アラート', `<a href="/dashboard/alerts">${esc(alert.text)}</a>`, alert.tone)}
    ${buyingPowerStat()}
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

// Rendered inside the run-state strip as one more `.stat` cell — not a
// full-width card — so a failed fetch never claims a whole row of the fold
// for a raw error message (#ui-redesign Lane B). Fetched client-side (not
// SSR) so a slow/failed /admin/buying-power call never blocks page render.
function buyingPowerStat(): string {
  return `<div class="stat" id="bp-stat">
    <div class="stat-label">買付余力</div>
    <div class="stat-value" id="bp-stat-value"><span class="muted stat-note">読込中…</span></div>
  </div>
  <script>
  (function () {
    var el = document.getElementById('bp-stat-value');
    if (!el) return;
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    fetch('/admin/buying-power', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { status: 'unavailable', reason: 'http ' + r.status }; })
      .then(function (d) {
        if (!d || d.status !== 'ok') {
          var reason = (d && d.reason) ? esc(String(d.reason).slice(0, 200)) : '';
          el.innerHTML = '<span class="pill err">取得不能</span> <span class="info-tip" tabindex="0" aria-label="買付余力エラー詳細" data-tip="' + reason + '">?</span>';
          return;
        }
        var parts = (d.byCurrency || []).map(function (a) {
          var bp = Number(a.buyingPower);
          var sym = a.currency === 'JPY' ? '¥' : (a.currency === 'USD' ? '$' : '');
          return sym + (isFinite(bp) ? bp.toLocaleString('ja-JP', { maximumFractionDigits: a.currency === 'JPY' ? 0 : 2 }) : a.buyingPower);
        });
        el.textContent = parts.join(' / ') || '—';
      })
      .catch(function () {
        el.innerHTML = '<span class="pill err">取得不能</span>';
      });
  })();
  </script>`
}

export function kpiCard(label: string, value: string, sub?: string, subClass?: string): string {
  const subHtml = sub ? `<div class="kpi-sub ${subClass ?? 'muted'}">${sub}</div>` : ''
  return `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${subHtml}</div>`
}

// exposure% (open USD positions / today's start equity) + a headcount of
// positions within 2pt of their stop — the two numbers an operator scans the
// hero row for right after the headline equity figure.
function renderExposureStopSummary(data: OverviewData, open: OpenPositionView[]): string {
  const usd = open
    .filter((o) => o.currency === 'USD' && o.marketValue !== null)
    .reduce((a, o) => a + (o.marketValue ?? 0), 0)
  const cap = data.portfolio?.dailyStartEquity ?? 0
  const near = open.filter((o) => {
    const s = data.stopDistances.get(o.sym)
    return s !== undefined && s.toStopPct <= 2
  }).length
  const parts: string[] = []
  if (cap > 0 && usd > 0) {
    parts.push(`エクスポージャー ${fmtNumber((usd / cap) * 100, 0)}%`)
  }
  if (near > 0) parts.push(`<span class="warn">損切り接近 ${near} 件</span>`)
  if (parts.length === 0) return ''
  return `<p class="mini-note">${parts.join(' ・ ')}</p>`
}

// Sign-before-currency (+$226.78 / -$10.41), unlike formatRealizedPnl's
// $-then-sign (used in the trades table, where the column already reads
// as a $ amount and doesn't need this card's headline emphasis).
function fmtMoneySigned(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  const cls = value > 0 ? 'ok' : value < 0 ? 'err' : 'muted'
  const abs = Math.abs(value).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `<span class="${cls}">${sign}$${abs}</span>`
}

function renderPerformanceCard(data: OverviewData, open: OpenPositionView[]): string {
  const st = data.activityStats
  const winRate = st && st.wins + st.losses > 0 ? (st.wins / (st.wins + st.losses)) * 100 : null
  const fstat = (label: string, valueHtml: string) =>
    `<div class="fstat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${valueHtml}</div></div>`
  const cells = [
    fstat('勝ち', st ? String(st.wins) : '—'),
    fstat('負け', st ? String(st.losses) : '—'),
    fstat('勝率', winRate !== null ? `${fmtNumber(winRate, 0)}%` : '—'),
    fstat('エラー', st ? `<span class="${st.errors > 0 ? 'err' : ''}">${st.errors}</span>` : '—'),
  ]
  return `<div class="card">
    <div class="card-head"><span class="card-title">直近30日</span></div>
    <div class="kpi-hero-line">
      <span class="stat-label">実現損益</span>
      <span class="kpi-value">${st ? fmtMoneySigned(st.realizedPnlSum) : '—'}</span>
    </div>
    <div class="flat-stats">${cells.join('')}</div>
    ${renderExposureStopSummary(data, open)}
  </div>`
}

function renderStopBar(stop: StopDistanceView | undefined): string {
  if (stop === undefined) return '<span class="muted">—</span>'
  if (stop.toStopPct <= 0) {
    return `<div class="stop-bar-wrap"><div class="bar-track stop-bar-track"><div class="bar-fill down" style="width:100%"></div></div><span class="err stat-note">損切り水準</span></div>`
  }
  // Normalized against 2x the effective stop's own magnitude so breakeven
  // (toStopPct == |effectiveStopPct|) reads as the bar's halfway point,
  // regardless of whether the stop is pct-based or ATR-widened.
  const magnitude = Math.abs(stop.effectiveStopPct) || 4
  const fillPct = Math.max(4, Math.min(100, (stop.toStopPct / (magnitude * 2)) * 100))
  const tone = stop.toStopPct <= 2 ? '' : 'up'
  const style = tone === '' ? `width:${fillPct}%;background:var(--warn)` : `width:${fillPct}%`
  return `<div class="stop-bar-wrap"><div class="bar-track stop-bar-track"><div class="bar-fill ${tone}" style="${style}"></div></div><span class="muted stat-note">あと ${fmtNumber(stop.toStopPct, 1)}%</span></div>`
}

// Renders as a compact list (ticker + qty/avg, pnl% + stop bar), not a
// table — this card lives in the hero row's 4-col right column, where a
// 6-column table header wraps before it fits.
function renderHoldingsCard(data: OverviewData, open: OpenPositionView[]): string {
  if (!data.symbolStateBound) {
    return `<div class="card"><div class="empty-row"><span class="card-title">保有銘柄</span><span class="empty">SYMBOL_STATE 未配線のため表示できません。</span></div></div>`
  }
  if (open.length === 0) {
    return `<div class="card"><div class="empty-row"><span class="card-title">保有銘柄 0 件</span><span class="empty">保有中の銘柄はありません。</span></div></div>`
  }
  const stopTip = `<span class="info-tip" tabindex="0" aria-label="stop 距離の説明" data-tip="${esc(
    '実効 stop は ATR と R:R 上限で銘柄ごとに変動します。詳細は 銘柄 タブへ。',
  )}">?</span>`
  const rows = open
    .map((o) => {
      const pnlCls = o.pnlPct === null ? '' : o.pnlPct >= 0 ? 'ok' : 'err'
      return `<div class="holding-row">
        <div class="holding-main">
          <a class="holding-sym" href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(o.sym)}" title="${esc(displaySymbol(o.sym, data.universe))}">${esc(o.sym)}</a>
          <div class="holding-sub">${fmtNumber(o.qty, 0)}株 @ ${fmtPriceCcy(o.avgPrice, o.currency)}</div>
        </div>
        <div class="holding-side">
          <div class="num ${pnlCls}">${o.pnlPct === null ? '—' : `${fmtNumber(o.pnlPct, 2)}%`}</div>
          ${renderStopBar(data.stopDistances.get(o.sym))}
        </div>
      </div>`
    })
    .join('')
  const exposurePill = renderExposurePill(data, open)
  return `<div class="card">
    <div class="card-head"><span class="card-title">保有銘柄 ${open.length} 件</span><span class="card-actions">${exposurePill}${stopTip}</span></div>
    <div class="holding-list">${rows}</div>
  </div>`
}

/** 保有銘柄合計 / total_capital の比率 pill。total_capital 未設定なら省略。 */
function renderExposurePill(data: OverviewData, open: OpenPositionView[]): string {
  const usd = open
    .filter((o) => o.currency === 'USD' && o.marketValue !== null)
    .reduce((a, o) => a + (o.marketValue ?? 0), 0)
  const cap = data.portfolio?.dailyStartEquity ?? 0
  if (!(cap > 0) || usd <= 0) return ''
  const pct = (usd / cap) * 100
  const cls = pct >= 60 ? 'warn' : 'neutral'
  return `<span class="pill ${cls}">開始 equity の ${fmtNumber(pct, 0)}%</span>`
}

function fmtJstShort(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')} ${pick('hour')}:${pick('minute')}`
}

// Win/loss/error counts already live in the "直近30日" performance card right
// above this one — repeating them in the card head here was pure duplication.
function renderRecentTradesCard(data: OverviewData): string {
  const trades = data.recentTrades
    .map((t) => {
      const sidePill = t.side === 'BUY' ? '<span class="pill buy">BUY</span>' : t.side === 'SELL' ? '<span class="pill sell">SELL</span>' : '<span class="muted">—</span>'
      const pnl = t.realizedPnl !== null ? formatRealizedPnl(t.realizedPnl) : '<span class="muted">—</span>'
      return `<tr>
        <td class="muted stat-note" title="${esc(fmtJst(t.timestamp))}">${esc(fmtJstShort(t.timestamp))}</td>
        <td class="grow"><strong title="${esc(displaySymbol(t.symbol ?? '—', data.universe))}">${esc(t.symbol ?? '—')}</strong></td>
        <td>${sidePill}</td>
        <td class="num">${t.filledQty !== null ? esc(t.filledQty) : '—'}</td>
        <td class="num">${t.filledPrice !== null ? fmtNumber(t.filledPrice, 2) : '—'}</td>
        <td class="num">${pnl}</td>
      </tr>`
    })
    .join('')
  const body = data.recentTrades.length
    ? `<div class="tablewrap"><table class="fit"><thead><tr><th>時刻</th><th class="grow">銘柄</th><th>売買</th><th class="num">数量</th><th class="num">約定値</th><th class="num">実損益</th></tr></thead><tbody>${trades}</tbody></table></div>`
    : '<div class="empty">約定履歴がありません。</div>'
  return `<div class="card">
    <div class="card-head">
      <span class="card-title">直近の約定</span>
      <span class="card-actions"><a href="/dashboard/cron">判定ログ →</a> <a href="/dashboard/trades">すべて見る →</a></span>
    </div>
    ${body}
  </div>`
}

// Each ECharts-using panel embeds its own CDN <script> tag so it works standalone; this
// collapses duplicates when more than one is enabled at once, to skip the redundant parse/exec.
function dedupeEchartsCdnTag(html: string): string {
  const tag = `<script src="${ECHARTS_CDN}" defer></script>`
  const parts = html.split(tag)
  if (parts.length <= 2) return html
  return parts[0] + tag + parts.slice(1).join('')
}

// No area-label section headers (リスクと保有銘柄 / 最近の活動): each card's
// own title already says what it is, and a divider label above a single card
// per section was pure repetition (#ui-redesign polish pass).
export function overviewBody(data: OverviewData): string {
  const open = collectOpenPositions(data)
  const sections: string[] = []
  const showActivity = data.panels.has('activity')
  const showRisk = data.panels.has('risk')

  sections.push(renderRunStateStrip(data))

  // 保有銘柄 sits stacked under 直近30日 in the right column rather than as
  // its own full-width section: at natural (unforced) height the two right-
  // column cards together read about as tall as the equity chart on a quiet
  // day, and simply run longer than it once there are many open positions —
  // both are fine, so neither column is stretched to match the other.
  if (showActivity || showRisk) {
    const left = showActivity
      ? `<div class="card">${renderPortfolioEquityChart(data.snapshots, data.range, '/dashboard')}</div>`
      : ''
    const right = (showActivity ? renderPerformanceCard(data, open) : '') + (showRisk ? renderHoldingsCard(data, open) : '')
    sections.push(
      `<div class="grid cols-12" style="margin:16px 0">
        <div class="span-8">${left}</div>
        <div class="span-4">${right}</div>
      </div>`,
    )
  }

  if (showActivity) {
    sections.push(renderRecentTradesCard(data))
  }

  return dedupeEchartsCdnTag(sections.join(''))
}

// Retained for /dashboard/symbols (Lane D), which still shows its own
// full-width buying-power banner — the compact run-state stat above replaced
// only the home page's use of this component, not the shared function.
export function buyingPowerBadge(): string {
  return `<div id="buying-power-badge" class="card" style="display:flex;align-items:center;gap:8px;font-size:13px;padding:10px 14px">
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
          el.innerHTML = '<strong>買付余力</strong> <span style="color:var(--down);font-weight:600">⚠ 取得不可</span>' +
            ' <span class="muted" style="font-size:11px">' + ((d && d.reason) ? String(d.reason).slice(0, 80) : '') + '</span>';
          return;
        }
        var parts = (d.byCurrency || []).map(function (a) {
          var bp = Number(a.buyingPower);
          var sym = a.currency === 'JPY' ? '¥' : (a.currency === 'USD' ? '$' : '');
          var v = isFinite(bp) ? bp.toLocaleString('ja-JP', { maximumFractionDigits: a.currency === 'JPY' ? 0 : 2 }) : a.buyingPower;
          var zero = isFinite(bp) && bp <= 0;
          return '<span style="' + (zero ? 'color:var(--text-3)' : 'font-weight:600') + '">' + a.currency + ' ' + sym + v + '</span>';
        });
        el.innerHTML = '<strong>買付余力</strong> ' + (parts.join(' &nbsp;/&nbsp; ') || '—') +
          ' <span class="muted" style="font-size:11px">(口座 ' + (d.baseCurrency || '') + ' 総現金 ' + Number(d.totalCash).toLocaleString('ja-JP') + ')</span>';
      })
      .catch(function () {
        el.innerHTML = '<strong>買付余力</strong> <span style="color:var(--down);font-weight:600">⚠ 取得不可</span>';
      });
  })();
  </script>`
}
