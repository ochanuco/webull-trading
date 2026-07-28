import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { SymbolCurrency } from '../../infrastructure/db/symbolConfigRepo'
import type { PortfolioEquitySnapshotRow } from '../../infrastructure/db/schema'
import type { VixRegime } from '../../trading/risk/vixRegimeFilter'
import type { SymbolState } from '../../trading/state/types'
import { formatRealizedPnl } from './cron'
import { ECHARTS_CDN } from './charts/shared'
import { type EquityRange, renderPortfolioEquityChart, renderVixRegimeCell } from './portfolio'
import { pickFreshQuote, positionsBody } from './positions'
import { displaySymbol, esc, fmtJst, fmtNumber, safeJsonScript } from './shared'

/**
 * ホームの表示領域 (#dashboard-ia Phase 3)。
 *
 * 旧実装は 6 パネル (status / kpi / equity / positions / composition / recent)
 * だったが、6 種類の情報ではなく **同じ数字の別表現**が並んでいた (status と
 * kpi で開始 equity と実現損益が重複、positions と composition は同じ建玉の
 * 別表現)。3 領域に畳んで重複を消した。
 *
 * **運転状態は panel ではない** — 常に最上段に出す。実行モード / 取引 ON-OFF /
 * 判定と株価の鮮度は、隠せると事故に直結するため設定対象から外している。
 */
export type OverviewPanel = 'risk' | 'activity'

export const ALL_OVERVIEW_PANELS: readonly OverviewPanel[] = ['risk', 'activity']

export const OVERVIEW_PANEL_LABELS: Record<OverviewPanel, string> = {
  risk: 'リスクと建玉 (保有ポジション + 資産構成 / 含み損益ランキング)',
  activity: '最近の活動 (直近の約定 + 資産推移)',
}

/**
 * 旧 panel key → 新領域。operator が保存済みの CSV をそのまま解釈できるよう
 * 読み替える (設定を作り直させない)。`status` は運転状態へ畳まれ、常時表示に
 * なったので対応先を持たない。
 */
const LEGACY_PANEL_MAP: Record<string, OverviewPanel | null> = {
  status: null,
  kpi: 'risk',
  positions: 'risk',
  composition: 'risk',
  equity: 'activity',
  recent: 'activity',
}

/** CSV を有効領域集合へ。不正値は無視、空 (未設定/全部不正) は全表示。 */
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
  // 旧 CSV が `status` だけ (= 運転状態のみ表示) だった場合、新モデルでは
  // 運転状態が常時表示なので領域ゼロになる。全表示に倒す方が意図に近い。
  if (set.size === 0 && sawLegacy) return new Set(ALL_OVERVIEW_PANELS)
  return set.size === 0 ? new Set(ALL_OVERVIEW_PANELS) : set
}

export interface OverviewData {
  panels: Set<OverviewPanel>
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

/** 開いている建玉 (qty != 0) を評価額・含み損益% 付きで抽出。 */
export interface OpenPositionView {
  sym: string
  qty: number
  currency: SymbolCurrency
  price: number | null
  marketValue: number | null
  pnlPct: number | null
}

/**
 * overview「最近の約定」用の直近 fill ロード。post_submit 行は side が null
 * (writer は pre_submit にしか入れない) なので client_order_id で pre_submit と
 * self-JOIN して side を引く (loadSymbolChart と同方針)。pre_submit が無い古い fill は
 * realized_pnl の有無から推測 (null=BUY / 非null=SELL)。
 */
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

export function collectOpenPositions(data: OverviewData): OpenPositionView[] {
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

/**
 * セクション見出し (h1 なし方針のまま「詳しく見る」導線を付ける小ヘッダ)。
 * ホームは要約、詳細は各専用ページ (/portfolio /positions /cron /alerts) へ。
 */
export function sectionHead(title: string, moreHref: string): string {
  return `<div class="section-head"><span>${esc(title)}</span><a class="sh-more" href="${moreHref}">詳しく見る →</a></div>`
}

/**
 * 資産サマリ帯 (#dashboard-ia 最上段): /portfolio の要約をカード 1 枚に横並び。
 * PORTFOLIO_STATE DO 不在 (portfolio === null) は帯を省略し、スパークラインも
 * データ無しなら section ごと消える (graceful)。
 */
/**
 * 運転状態 (#dashboard-ia Phase 3): ホーム最上段の固定帯。
 *
 * 「いま安全に動いているか」だけを載せる。実行モード / 取引 ON-OFF /
 * 株価の鮮度は隠せない (設定対象外)。equity 系の数字は下の領域に譲り、ここは
 * 状態表示に徹する。
 */
export function renderRunStatePanel(data: OverviewData): string {
  const modePill = data.dryRun
    ? '<span class="pill off">DRY-RUN</span>'
    : '<span class="pill on">LIVE</span>'
  const tradingPill = data.tradingEnabled
    ? '<span class="pill on">取引 ON</span>'
    : '<span class="pill off">取引 OFF</span>'
  const item = (label: string, value: string) =>
    `<div style="min-width:104px"><div class="kpi-label">${esc(label)}</div><div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums">${value}</div></div>`
  const quote = latestQuoteFreshness(data)
  return `<div class="panel" style="display:flex;flex-wrap:wrap;gap:10px 22px;align-items:flex-end">
    ${item('実行モード', modePill)}
    ${item('取引 (effective)', tradingPill)}
    ${item('株価の鮮度', quote)}
    ${item('VIX レジーム', `<span style="font-size:13px;font-weight:400">${renderVixRegimeCell(data.vixRegime)}</span>`)}
    ${item('USDJPY', data.usdJpy === null ? '<span class="muted">—</span>' : fmtNumber(data.usdJpy, 2))}
    <div style="margin-left:auto;font-size:12px"><a href="/dashboard/alerts">アラート →</a></div>
  </div>`
}

/**
 * 保有・監視銘柄の中で **最も新しい** 株価の取得時刻を相対表示する。
 * quote feed が止まると全銘柄で同時に古くなるので、最新 1 件で足りる。
 */
function latestQuoteFreshness(data: OverviewData): string {
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
  if (latest === null) return '<span class="muted">—</span>'
  const min = Math.floor((Date.now() - latest) / 60000)
  const text = min < 1 ? '1 分未満' : min < 60 ? `${min} 分前` : `${Math.floor(min / 60)} 時間前`
  // 15 分は global_config.stale_quote_ms の既定 (halt 判定と同じ線)。
  const cls = min >= 15 ? 'err' : 'ok'
  return `<span class="${cls}" style="font-size:13px">${esc(text)}</span>`
}

export function renderHomePositionsSection(data: OverviewData): string {
  const head = sectionHead('保有ポジション', '/dashboard/positions')
  if (!data.symbolStateBound) {
    return `${head}<div class="panel"><p class="muted" style="margin:0">SYMBOL_STATE 未配線のため表示できません。<a href="/dashboard/positions">保有ポジションページ</a>を参照してください。</p></div>`
  }
  return `${head}<div style="margin-bottom:16px">${positionsBody(data.positions, data.strategyPriceMap, data.universe)}</div>`
}

export function kpiCard(label: string, value: string, sub?: string, subClass?: string): string {
  const subHtml = sub ? `<div class="kpi-sub ${subClass ?? 'muted'}">${sub}</div>` : ''
  return `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${subHtml}</div>`
}

export function renderKpiPanel(data: OverviewData, open: OpenPositionView[]): string {
  const p = data.portfolio
  const dd = p && p.dailyStartEquity > 0 ? (p.dailyRealizedPnl / p.dailyStartEquity) * 100 : null
  const pnlClass = p == null ? 'muted' : p.dailyRealizedPnl >= 0 ? 'ok' : 'err'
  const cards = [
    kpiCard('当日始値資産', p ? fmtNumber(p.dailyStartEquity, 2) : '—', '口座 dailyStartEquity'),
    kpiCard(
      '当日実現損益',
      p ? `<span class="${pnlClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</span>` : '—',
      dd === null ? undefined : `DD ${fmtNumber(dd, 2)}%`,
      dd === null ? 'muted' : dd >= 0 ? 'ok' : 'err',
    ),
    kpiCard('建玉数', String(open.length), '保有中の銘柄数'),
    kpiCard(
      'Open exposure',
      p ? `${fmtNumber(p.openExposureUsd, 0)}<span class="muted" style="font-size:12px"> USD</span>` : '—',
      p ? `${fmtNumber(p.openExposureJpy, 0)} JPY` : undefined,
    ),
  ].join('')
  return `<div class="kpi-grid">${cards}</div>`
}

export function renderCompositionPanel(open: OpenPositionView[]): string {
  if (open.length === 0) {
    return `<div class="panel"><div class="panel-title">資産構成 / 含み損益ランキング</div><p class="muted">保有中の建玉がありません。</p></div>`
  }
  // 通貨内シェアで構成比 bar を正規化 (USD/JPY を混ぜない)。
  const sumByCcy: Record<string, number> = {}
  for (const o of open) {
    if (o.marketValue !== null) sumByCcy[o.currency] = (sumByCcy[o.currency] ?? 0) + Math.abs(o.marketValue)
  }
  const composition = [...open]
    .sort((a, b) => (Math.abs(b.marketValue ?? 0)) - (Math.abs(a.marketValue ?? 0)))
    .map((o) => {
      const total = sumByCcy[o.currency] ?? 0
      const share = o.marketValue !== null && total > 0 ? (Math.abs(o.marketValue) / total) * 100 : 0
      const valueText = o.marketValue !== null ? `${fmtNumber(o.marketValue, 0)} ${o.currency}` : '—'
      return `<div class="rank-row"><span>${esc(o.sym)} <span class="muted" style="font-size:11px">${fmtNumber(share, 1)}%</span></span><span>${valueText}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${share.toFixed(1)}%"></div></div>`
    })
    .join('')
  // 含み損益% ランキング (up / down)。
  const ranked = open.filter((o) => o.pnlPct !== null) as Array<OpenPositionView & { pnlPct: number }>
  const gainers = [...ranked].filter((o) => o.pnlPct >= 0).sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5)
  const losers = [...ranked].filter((o) => o.pnlPct < 0).sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5)
  const rankRow = (o: OpenPositionView & { pnlPct: number }) =>
    `<div class="rank-row"><span>${esc(o.sym)}</span><span class="${o.pnlPct >= 0 ? 'ok' : 'err'}">${fmtNumber(o.pnlPct, 2)}%</span></div>`
  const rankCol = (title: string, items: Array<OpenPositionView & { pnlPct: number }>) =>
    `<div><div class="muted" style="font-size:12px;margin-bottom:4px">${esc(title)}</div>${items.length ? items.map(rankRow).join('') : '<p class="muted">—</p>'}</div>`
  return `<div class="panel">
    <div class="panel-title">資産構成 / 含み損益ランキング</div>
    <p class="muted" style="font-size:12px;margin-top:0">構成比は通貨内シェア。ランキングは含み損益% (現在値 vs 平均取得単価)。</p>
    <div class="panel-row">
      <div><div class="muted" style="font-size:12px;margin-bottom:4px">構成 (評価額)</div>${composition}</div>
      <div class="panel-row" style="grid-template-columns:1fr 1fr">${rankCol('上昇', gainers)}${rankCol('下落', losers)}</div>
    </div>
  </div>`
}

export function renderRecentPanel(data: OverviewData): string {
  const trades = data.recentTrades
    .map((t) => {
      const sideClass = t.side === 'BUY' ? 'ok' : t.side === 'SELL' ? 'err' : 'muted'
      const pnl = t.realizedPnl !== null ? formatRealizedPnl(t.realizedPnl) : '<span class="muted">—</span>'
      return `<tr>
        <td class="muted" style="font-size:12px">${esc(fmtJst(t.timestamp))}</td>
        <td><strong>${esc(displaySymbol(t.symbol ?? '—', data.universe))}</strong></td>
        <td class="${sideClass}">${esc(t.side ?? '—')}</td>
        <td>${t.filledQty !== null ? esc(t.filledQty) : '—'}</td>
        <td>${t.filledPrice !== null ? fmtNumber(t.filledPrice, 2) : '—'}</td>
        <td>${pnl}</td>
      </tr>`
    })
    .join('')
  const recentTable = data.recentTrades.length
    ? `<table><thead><tr><th>時刻</th><th>銘柄</th><th>売買</th><th>数量</th><th>約定値</th><th>実損益</th></tr></thead><tbody>${trades}</tbody></table>`
    : '<p class="muted">約定履歴がありません。</p>'
  const dryPill = data.dryRun
    ? '<span class="pill dry">DRY-RUN</span>'
    : '<span class="pill live">LIVE</span>'
  const tradingPill = data.tradingEnabled
    ? '<span class="pill on">取引 ON</span>'
    : '<span class="pill off">取引 OFF</span>'
  return `<div class="panel">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:baseline"><span>最近の約定 / リスク状態</span><span style="font-weight:400;font-size:12px"><a href="/dashboard/cron">判定履歴 →</a> <a href="/dashboard/alerts" style="margin-left:8px">アラート →</a></span></div>
    <div class="panel-row">
      <div>${recentTable}<div style="margin-top:8px"><a href="/dashboard/trades">約定履歴をすべて見る →</a></div></div>
      <div>
        <table><tbody>
          <tr><th>実行モード</th><td>${dryPill} <span class="muted" style="font-size:11px">(D1 dry_run)</span></td></tr>
          <tr><th>取引 (effective)</th><td>${tradingPill} <span class="muted" style="font-size:11px">(env override 反映後)</span></td></tr>
          <tr><th>VIX レジーム</th><td>${renderVixRegimeCell(data.vixRegime)}</td></tr>
        </tbody></table>
      </div>
    </div>
  </div>`
}

/**
 * 口座買付余力バッジ (#415)。SSR はブロックせず、client-side で `/admin/buying-power`
 * を fetch して通貨別 buying_power を描画する (broker-probe と同じく CF Access cookie
 * 流用)。取得失敗は ⚠ 表示でページは壊さない。ホーム / 銘柄設定の両方で使う。
 */
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

/**
 * ECharts CDN の `<script src>` タグ重複除去 (CodeRabbit #559)。status
 * (スパークライン) と equity (資産推移チャート) はどちらも単独 ON で成立する
 * 必要があるため各自 CDN タグを持つ — 両方 ON のときだけここで 2 個目以降を
 * 落とす (同一 src の二重ロードはキャッシュされるが parse/execute が無駄)。
 */
export function dedupeEchartsCdnTag(html: string): string {
  const tag = `<script src="${ECHARTS_CDN}" defer></script>`
  const parts = html.split(tag)
  if (parts.length <= 2) return html
  return parts[0] + tag + parts.slice(1).join('')
}

/** 領域の区切り見出し (#dashboard-ia Phase 3)。 */
function areaLabel(text: string): string {
  return `<div class="area-label">${esc(text)}</div>`
}

export function overviewBody(data: OverviewData): string {
  const open = collectOpenPositions(data)
  const sections: string[] = []

  // 1. 運転状態 — 常時表示。設定で隠せない。
  sections.push(renderRunStatePanel(data))

  // 2. リスクと建玉
  if (data.panels.has('risk')) {
    sections.push(areaLabel('リスクと建玉'))
    sections.push(renderKpiPanel(data, open))
    sections.push(renderHomePositionsSection(data))
    sections.push(renderCompositionPanel(open))
  }

  // 3. 最近の活動
  if (data.panels.has('activity')) {
    sections.push(areaLabel('最近の活動'))
    sections.push(renderRecentPanel(data))
    sections.push(
      `<div class="panel">${renderPortfolioEquityChart(data.snapshots, data.range, '/dashboard')}</div>`,
    )
  }

  return dedupeEchartsCdnTag(buyingPowerBadge() + sections.join(''))
}
