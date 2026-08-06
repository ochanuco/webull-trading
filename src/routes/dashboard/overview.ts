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

/**
 * ホームの表示領域 (#dashboard-ia Phase 3)。
 *
 * 旧実装は 6 パネル (status / kpi / equity / positions / composition / recent)
 * だったが、6 種類の情報ではなく **同じ数字の別表現**が並んでいた (status と
 * kpi で開始 equity と実現損益が重複、positions と composition は同じ保有銘柄の
 * 別表現)。3 領域に畳んで重複を消した。
 *
 * **運転状態は panel ではない** — 常に最上段に出す。実行モード / 取引 ON-OFF /
 * 判定と株価の鮮度は、隠せると事故に直結するため設定対象から外している。
 */
export type OverviewPanel = 'risk' | 'activity'

export const ALL_OVERVIEW_PANELS: readonly OverviewPanel[] = ['risk', 'activity']

export const OVERVIEW_PANEL_LABELS: Record<OverviewPanel, string> = {
  risk: 'リスクと保有銘柄 (保有一覧 + 資産構成 / 含み損益ランキング)',
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

/**
 * ISO 時刻 → 相対表示 + 鮮度の色。`staleMin` を超えたら警告色にする。
 * cron は 15 分周期なので既定 20 分、quote は stale_quote_ms 既定に合わせ 15 分。
 */
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

/**
 * 保有・監視銘柄の中で **最も新しい** 株価の取得時刻を相対表示する。
 * quote feed が止まると全銘柄で同時に古くなるので、最新 1 件で足りる。
 */
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
  // 15 分は global_config.stale_quote_ms の既定 (halt 判定と同じ線)。
  return renderRelativeAge(new Date(latest).toISOString(), 15)
}

export function kpiCard(label: string, value: string, sub?: string, subClass?: string): string {
  const subHtml = sub ? `<div class="kpi-sub ${subClass ?? 'muted'}">${sub}</div>` : ''
  return `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${value}</div>${subHtml}</div>`
}

/**
 * リスクと保有銘柄 (#dashboard-ia): 保有銘柄テーブル + エクスポージャー + 買付余力。
 *
 * 旧ホームは KPI カード / 保有ポジション表 / 資産構成の 3 枚に分かれていたが、
 * 保有銘柄 2-3 件の口座では同じデータを 3 回見せているだけだった。1 枚に畳み、
 * **各保有銘柄が実効 stop からどれだけ離れているか**という、表からは読めなかった
 * 情報を状態列として足す。
 */
export function renderRiskPanel(data: OverviewData, open: OpenPositionView[]): string {
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

export function renderRecentPanel(data: OverviewData): string {
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
  // 実行モード / 取引 / VIX は運転状態帯に移したのでここでは繰り返さない。
  return `<div class="panel">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:baseline"><span>直近の約定</span><span style="font-weight:400;font-size:12px"><a href="/dashboard/cron">判定ログ →</a></span></div>
    ${recentTable}
    <div style="margin-top:8px"><a href="/dashboard/trades">約定履歴をすべて見る →</a></div>
    ${activityFooter(data)}
  </div>`
}

/** 直近 30 日の成績サマリ (勝ち / 負け / 発注エラー)。未取得なら空文字。 */
function activityFooter(data: OverviewData): string {
  const st = data.activityStats
  if (st === null) return ''
  return `<p class="muted" style="font-size:12px;margin:10px 0 0">直近 30 日 ・ 勝ち ${st.wins} / 負け ${st.losses} ・ 発注エラー ${st.errors}</p>`
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

  // 2. リスクと保有銘柄 — 保有銘柄テーブル 1 枚に集約 (KPI / 資産構成の重複を排除)。
  if (data.panels.has('risk')) {
    sections.push(areaLabel('リスクと保有銘柄'))
    sections.push(renderRiskPanel(data, open))
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
