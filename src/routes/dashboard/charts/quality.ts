import { kpiCard } from '../overview'
import { esc, safeJsonScript } from '../shared'
import { type ChartsBodyQuality, type QualityPeriod, ECHARTS_CDN, QUALITY_PERIOD_LABELS } from './shared'

/**
 * Per-trade realized PnL 行 (#quality-redesign)。symbol / timestamp を持つのは
 * 銘柄別集計 (`computeSymbolStats`) と期間フィルタ (`filterTradePnlsByPeriod`) の
 * 両方がこの単位で動くため。trade_journal.realized_pnl は SELL fill に確定
 * 損益が記録される (BUY は null)。
 */
export interface TradePnlRow {
  realizedPnl: number
  symbol: string
  /** ISO timestamp (trade_journal.timestamp、UTC 前提)。 */
  timestamp: string
}

export async function loadTradePnls(db: D1Database): Promise<TradePnlRow[]> {
  const result = await db
    .prepare(
      `SELECT realized_pnl AS pnl, symbol, timestamp
       FROM trade_journal
       WHERE realized_pnl IS NOT NULL
         AND trade_event_type = 'post_submit'
       ORDER BY id ASC`,
    )
    .all<{ pnl: number; symbol: string | null; timestamp: string }>()
  const rows: TradePnlRow[] = []
  for (const r of result.results ?? []) {
    const realizedPnl = Number(r.pnl)
    if (!Number.isFinite(realizedPnl) || !r.symbol) continue
    rows.push({ realizedPnl, symbol: r.symbol, timestamp: r.timestamp })
  }
  return rows
}

const PERIOD_DAYS: Record<'30d' | '90d', number> = { '30d': 30, '90d': 90 }

/**
 * `?period=` フィルタを行配列に適用 (#quality-redesign)。カレンダー日境界
 * (JST 日次) ではなく、`now` から遡ったローリングウィンドウ (30日 / 90日) —
 * 期間切替は「直近どれだけ遡るか」の直感に合わせる。`now` は省略可能 (test
 * から固定時刻を注入できるように)。
 */
export function filterTradePnlsByPeriod(
  rows: TradePnlRow[],
  period: QualityPeriod,
  now: Date = new Date(),
): TradePnlRow[] {
  if (period === 'all') return rows
  const cutoffMs = now.getTime() - PERIOD_DAYS[period] * 86_400_000
  return rows.filter((r) => {
    const t = new Date(r.timestamp).getTime()
    return Number.isFinite(t) && t >= cutoffMs
  })
}

export interface TradeStats {
  count: number
  wins: number
  losses: number
  /** 0..1 (勝率) */
  winRate: number
  avgWin: number
  avgLoss: number // 負値
  /** 総利益 / |総損失|。loss=0 のときは Infinity (UI 側で "—" 表示) */
  profitFactor: number
  /** 1 trade あたり期待損益 = total / 全トレード数 (break-even 含む) */
  expectancy: number
  total: number
}

/**
 * 「エッジが本物か」を 1 表で見るためのサマリ統計。break-even (pnl=0) は wins / losses
 * どちらにも入れない (エクスペクタンシ計算で 0 として中立に効く)。
 */
export function computeTradeStats(pnls: number[]): TradeStats {
  if (pnls.length === 0) {
    return { count: 0, wins: 0, losses: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0, total: 0 }
  }
  let wins = 0
  let losses = 0
  let sumWin = 0
  let sumLoss = 0
  let total = 0
  for (const p of pnls) {
    total += p
    if (p > 0) {
      wins += 1
      sumWin += p
    } else if (p < 0) {
      losses += 1
      sumLoss += p
    }
  }
  const decisive = wins + losses
  const winRate = decisive > 0 ? wins / decisive : 0
  const avgWin = wins > 0 ? sumWin / wins : 0
  const avgLoss = losses > 0 ? sumLoss / losses : 0
  const profitFactor = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0
  // break-even (pnl=0) も分母に含めた「全トレード平均」。旧式
  // (winRate*avgWin + (1-winRate)*avgLoss) は分母が decisive のみで、
  // break-even 込みの「トレード毎」表示と不整合だった (CodeRabbit PR #684)。
  const expectancy = total / pnls.length
  return { count: pnls.length, wins, losses, winRate, avgWin, avgLoss, profitFactor, expectancy, total }
}

export interface SymbolStat {
  symbol: string
  count: number
  winRate: number
  totalPnl: number
  profitFactor: number
}

/**
 * 銘柄別成績 (#quality-redesign)。`computeTradeStats` を銘柄ごとに再利用し、
 * 合計 PnL 降順で返す (表・横バー両方がこの順序をそのまま使う)。
 */
export function computeSymbolStats(rows: TradePnlRow[]): SymbolStat[] {
  const bySymbol = new Map<string, number[]>()
  for (const r of rows) {
    const list = bySymbol.get(r.symbol)
    if (list) {
      list.push(r.realizedPnl)
    } else {
      bySymbol.set(r.symbol, [r.realizedPnl])
    }
  }
  const out: SymbolStat[] = []
  for (const [symbol, pnls] of bySymbol) {
    const s = computeTradeStats(pnls)
    out.push({ symbol, count: s.count, winRate: s.winRate, totalPnl: s.total, profitFactor: s.profitFactor })
  }
  return out.sort((a, b) => b.totalPnl - a.totalPnl)
}

/**
 * SKIP reason カテゴリ (#quality-redesign)。`pullbackScheduler.ts` の実際の
 * emitDecision(SKIP) reason は prefix でおおむね分類できる:
 *   - `portfolio_halted:` / `drawdown_kill:` — ポートフォリオ全体の entry 停止
 *   - `role:`             — cash_parking 等、銘柄ロールによる entry 抑止
 *   - `sizing rejected:`  — lot_size 未設定などサイジング不可
 *   - `risk:`             — earnings/macro/per-symbol risk/sanity cooldown/pair_regime
 *                            (`risk: insufficient buying power` / `risk: buying-power
 *                            unavailable` は資金不足として別カテゴリに分ける)
 *   - それ以外の internal invariant guard (bar 不足 / 価格・数量・ロック不正 /
 *     二重発注ガード) — 「システムガード」としてまとめる
 * 色は dataviz skill の検証済みデフォルト categorical palette (light/dark 両対応、
 * adjacent CVD/normal-vision gate 通過) の slot 1-7 を順に割り当てる。
 */
export const SKIP_REASON_CATEGORIES = [
  { key: 'halt', label: '取引停止中', color: '#2a78d6' },
  { key: 'risk_gate', label: 'リスクゲート', color: '#eb6834' },
  { key: 'role', label: '銘柄ロール抑止', color: '#1baf7a' },
  { key: 'funds', label: '資金不足', color: '#eda100' },
  { key: 'sizing', label: 'サイジング不可', color: '#e87ba4' },
  { key: 'system_guard', label: 'システムガード', color: '#008300' },
  { key: 'other', label: 'その他', color: '#4a3aa7' },
] as const

export type SkipReasonCategoryKey = (typeof SKIP_REASON_CATEGORIES)[number]['key']

/**
 * raw SKIP reason 文字列 → カテゴリ key。未知の形式 (将来追加 / 旧形式) は
 * 'other' に落として合計が欠けないようにする (`aggregateDecisionRows` の
 * ERROR フォールバックと同じ考え方)。
 */
export function categorizeSkipReason(reason: string | null | undefined): SkipReasonCategoryKey {
  if (!reason) return 'other'
  if (/^(?:portfolio_halted|drawdown_kill):/.test(reason)) return 'halt'
  if (/^role:/.test(reason)) return 'role'
  if (/^sizing rejected:/.test(reason)) return 'sizing'
  if (/^risk:/.test(reason)) return /buying[- ]power/.test(reason) ? 'funds' : 'risk_gate'
  if (/^pair_regime:/.test(reason)) return 'risk_gate'
  if (
    /^insufficient bars for indicators$/.test(reason) ||
    /^invalid (?:price|notional|position qty|expiresAt)/.test(reason) ||
    /^SELL without position$/.test(reason) ||
    /^pending order already in flight$/.test(reason)
  ) {
    return 'system_guard'
  }
  return 'other'
}

export interface SkipReasonBreakdownPoint {
  date: string
  counts: Record<SkipReasonCategoryKey, number>
}

function emptySkipCounts(): Record<SkipReasonCategoryKey, number> {
  const counts = {} as Record<SkipReasonCategoryKey, number>
  for (const c of SKIP_REASON_CATEGORIES) counts[c.key] = 0
  return counts
}

export function aggregateSkipReasonRows(
  rows: Array<{ day: string; reason: string | null; n: number }>,
): SkipReasonBreakdownPoint[] {
  const map = new Map<string, Record<SkipReasonCategoryKey, number>>()
  for (const r of rows) {
    let bucket = map.get(r.day)
    if (!bucket) {
      bucket = emptySkipCounts()
      map.set(r.day, bucket)
    }
    bucket[categorizeSkipReason(r.reason)] += Number(r.n)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, counts]) => ({ date, counts }))
}

/**
 * 日次 SKIP 理由カテゴリ breakdown (#quality-redesign、旧 `loadDecisionBreakdown`
 * の置き換え)。直近 90 日固定 (`?period=` の対象外 — この chart は「最近の
 * ゲート傾向」を見る用途なので、成績カード/表/バーの期間切替とは独立)。
 */
export async function loadSkipReasonBreakdown(db: D1Database): Promise<SkipReasonBreakdownPoint[]> {
  const result = await db
    .prepare(
      `SELECT date(timestamp, '+9 hours') AS day,
              reason,
              COUNT(*) AS n
       FROM strategy_decision_log
       WHERE decision = 'SKIP'
         AND timestamp >= date('now', '-90 days')
       GROUP BY day, reason
       ORDER BY day ASC`,
    )
    .all<{ day: string; reason: string | null; n: number }>()
  return aggregateSkipReasonRows(result.results ?? [])
}

const NUM_FMT = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—')
const PCT_FMT = (n: number) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—')
const PF_FMT = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '∞')
/** 正/負の色分けは既存サイト慣習 (`.ok` = 緑 #057a55 / `.err` = 赤 #c22) に揃える。 */
const signClass = (n: number) => (n > 0 ? 'ok' : n < 0 ? 'err' : 'muted')

function renderPeriodPills(period: QualityPeriod): string {
  const periods: QualityPeriod[] = ['30d', '90d', 'all']
  const links = periods
    .map((p) => {
      const active = p === period ? ' active' : ''
      return `<a class="zoom-preset${active}" style="text-decoration:none" href="/dashboard/charts?tab=quality&period=${p}">${esc(QUALITY_PERIOD_LABELS[p])}</a>`
    })
    .join('')
  return `<div style="margin-bottom:10px">${links}</div>`
}

/**
 * X スクショ用の成績サマリカード (#quality-redesign)。固定幅 ~640px、3×3 の
 * stat タイル。既存 `.kpi-card` (`kpiCard()`、overview タブと同じ部品) を
 * 敷き詰めて再利用し、値だけ 18px に上書きする (overview の KPI 帯より密な
 * 3 列グリッドなので既定 22px だと詰まりすぎる)。
 */
export function renderStatsCard(stats: TradeStats, period: QualityPeriod, asOfJst: string): string {
  const tile = (label: string, text: string, cls?: string) =>
    kpiCard(label, `<span style="font-size:18px" class="${cls ?? ''}">${esc(text)}</span>`)
  const tiles = [
    tile('件数', String(stats.count)),
    tile('勝率', PCT_FMT(stats.winRate)),
    tile('profit factor', PF_FMT(stats.profitFactor)),
    tile('勝', String(stats.wins), 'ok'),
    tile('負', String(stats.losses), 'err'),
    tile('合計 PnL', NUM_FMT(stats.total), signClass(stats.total)),
    tile('平均利益', NUM_FMT(stats.avgWin), 'ok'),
    tile('平均損失', NUM_FMT(stats.avgLoss), 'err'),
    tile('期待値 (トレード毎)', NUM_FMT(stats.expectancy), signClass(stats.expectancy)),
  ].join('')
  return `<div class="panel" style="max-width:640px">
    <div class="panel-title">運用成績 (${esc(QUALITY_PERIOD_LABELS[period])})</div>
    <p class="muted" style="font-size:11px;margin:-8px 0 12px">as of ${esc(asOfJst)}</p>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${tiles}</div>
  </div>`
}

export function renderSymbolTable(symbolStats: SymbolStat[]): string {
  if (symbolStats.length === 0) return ''
  const rows = symbolStats
    .map(
      (s) => `<tr>
        <td>${esc(s.symbol)}</td>
        <td class="num">${s.count}</td>
        <td class="num">${PCT_FMT(s.winRate)}</td>
        <td class="num ${signClass(s.totalPnl)}">${NUM_FMT(s.totalPnl)}</td>
        <td class="num">${PF_FMT(s.profitFactor)}</td>
      </tr>`,
    )
    .join('')
  return `<table style="margin-top:16px;max-width:640px">
    <thead><tr><th>銘柄</th><th class="num">件数</th><th class="num">勝率</th><th class="num">合計PnL</th><th class="num">PF</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

export function renderQualityTab(args: ChartsBodyQuality): string {
  if (!args.hasTradeData && args.skipBreakdown.length === 0) {
    return `<p class="muted">まだ判定ログも実 fill も無いため成績を描けません。cron が動き出すと SKIP 理由の内訳、SELL が約定すると成績サマリが出ます。</p>`
  }
  const symbolBarChart =
    args.symbolStats.length > 0
      ? `<div id="symbol-pnl-chart" style="width:100%;max-width:640px;height:${Math.max(200, args.symbolStats.length * 34 + 60)}px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:16px"></div>`
      : ''
  const tradeSection = args.hasTradeData
    ? `${renderPeriodPills(args.period)}
      ${renderStatsCard(args.stats, args.period, args.asOfJst)}
      ${renderSymbolTable(args.symbolStats)}
      ${symbolBarChart}`
    : ''
  const skipSection =
    args.skipBreakdown.length > 0
      ? `<div id="skip-reason-chart" style="width:100%;height:340px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:20px"></div>`
      : ''
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var barEl = document.getElementById('symbol-pnl-chart');
      if (barEl && data.symbolStats && data.symbolStats.length > 0) {
        var barChart = echarts.init(barEl);
        var symbols = data.symbolStats.map(function (s) { return s.symbol; });
        barChart.setOption({
          title: { text: '銘柄別 合計PnL', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          grid: { left: 70, right: 60, top: 40, bottom: 20 },
          xAxis: { type: 'value', splitLine: { lineStyle: { color: '#eee' } } },
          yAxis: { type: 'category', data: symbols, inverse: true },
          series: [{
            type: 'bar',
            barWidth: 14,
            data: data.symbolStats.map(function (s) {
              var positive = s.totalPnl >= 0;
              return {
                value: s.totalPnl,
                itemStyle: { color: positive ? '#057a55' : '#c22', borderRadius: 3 },
                label: {
                  show: true,
                  position: positive ? 'right' : 'left',
                  formatter: function () { return s.totalPnl.toFixed(2); },
                  fontSize: 11,
                },
              };
            }),
          }],
        });
        window.addEventListener('resize', function () { barChart.resize(); });
      }
      var skipEl = document.getElementById('skip-reason-chart');
      if (skipEl && data.skipBreakdown && data.skipBreakdown.length > 0) {
        var skipChart = echarts.init(skipEl);
        var dates = data.skipBreakdown.map(function (p) { return p.date; });
        var categories = data.skipCategories;
        skipChart.setOption({
          title: { text: '日次 SKIP 理由内訳', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 22, data: categories.map(function (c) { return c.label; }) },
          grid: { left: 50, right: 20, top: 60, bottom: 40 },
          xAxis: { type: 'category', data: dates },
          yAxis: { type: 'value', name: '件数' },
          series: categories.map(function (c) {
            return {
              name: c.label,
              type: 'bar',
              stack: 'skip',
              itemStyle: { color: c.color, borderWidth: 2, borderColor: '#fff' },
              data: data.skipBreakdown.map(function (p) { return p.counts[c.key] || 0; }),
            };
          }),
        });
        window.addEventListener('resize', function () { skipChart.resize(); });
      }
    });
  `
  return `${tradeSection}
  ${skipSection}
  ${safeJsonScript('__chartData', {
    symbolStats: args.symbolStats,
    skipBreakdown: args.skipBreakdown,
    skipCategories: SKIP_REASON_CATEGORIES,
  })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}
