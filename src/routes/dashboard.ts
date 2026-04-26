import { Hono } from 'hono'
import type { AppBindings } from '../app'
import type { Env } from '../config/env'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { MAX_TIME_STOP_DAYS, strategyDecisionLog, tradeJournal } from '../infrastructure/db/schema'
import {
  loadRecentAlerts,
  type AlertRow,
  type LoadAlertOptions,
} from '../infrastructure/notification/notificationEmitLog'
import type { NotificationSeverity, NotificationEvent } from '../infrastructure/notification/Notifier'
import { and, asc, desc, eq } from 'drizzle-orm'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import type { SymbolState } from '../trading/state/types'
import { YahooBarClient } from '../infrastructure/quotes/YahooBarClient'

/**
 * Read-only operator dashboard (#121). Server-rendered HTML via Hono — no
 * client JS, no build step. Protected by the same basic-auth middleware as
 * /admin. Every page renders defensively: if a binding (D1 / DO) is missing
 * we surface "unavailable" rather than 500, so a partially-configured env
 * still yields a usable landing.
 */
export const dashboard = new Hono<AppBindings>()
  .get('/', (c) => c.html(layout('ダッシュボード', indexBody())))
  .get('/positions', async (c) => {
    if (!c.env.DB || !c.env.SYMBOL_STATE) {
      return c.html(layout('保有状況', unavailable('DB or SYMBOL_STATE not bound')))
    }
    const universe = await loadSymbolUniverse(c.env)
    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    const [rows, strategyPriceMap] = await Promise.all([
      Promise.all(
        universe.allowedSymbols.map(async (sym) => {
          try {
            return { sym, state: await client.getState(sym), error: null as string | null }
          } catch (err) {
            return { sym, state: null as SymbolState | null, error: messageOf(err) }
          }
        }),
      ),
      loadLatestStrategyPrices(c.env.DB, universe.allowedSymbols),
    ])
    return c.html(layout('保有状況', positionsBody(rows, strategyPriceMap)))
  })
  .get('/portfolio', async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      return c.html(layout('ポートフォリオ', unavailable('PORTFOLIO_STATE not bound')))
    }
    try {
      const portfolio = await new PortfolioStateClient(c.env.PORTFOLIO_STATE).getPortfolio()
      return c.html(layout('ポートフォリオ', portfolioBody(portfolio)))
    } catch (err) {
      return c.html(layout('ポートフォリオ', unavailable(messageOf(err))))
    }
  })
  .get('/trades', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('約定履歴', unavailable('DB not bound')))
    }
    const limit = clampLimit(c.req.query('limit'))
    const db = createDb(c.env.DB)
    const rows = await db.select().from(tradeJournal).orderBy(desc(tradeJournal.id)).limit(limit)
    return c.html(layout('約定履歴', tradesBody(rows, limit)))
  })
  .get('/config', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('設定', unavailable('DB not bound')))
    }
    const [global, universe] = await Promise.all([
      loadGlobalConfigFrom(c.env),
      loadSymbolUniverse(c.env),
    ])
    return c.html(layout('設定', configBody(global, universe)))
  })
  .get('/charts', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('チャート', unavailable('DB not bound')))
    }
    try {
      const tab = parseChartsTab(c.req.query('tab'))
      // 各 tab で必要な D1 query だけ走らせる軽量化:
      // - overview: equity (drawdown は equity から派生)
      // - quality:  pnls (= stats / histogram) + decisions
      // - symbol:   universe + symbolChart
      if (tab === 'overview') {
        const equity = await loadEquityCurve(c.env.DB)
        return c.html(layout('チャート', chartsBody({ tab, equity })))
      }
      if (tab === 'quality') {
        const [decisions, pnls] = await Promise.all([
          loadDecisionBreakdown(c.env.DB),
          loadTradePnls(c.env.DB),
        ])
        return c.html(
          layout(
            'チャート',
            chartsBody({
              tab,
              decisions,
              pnls,
              stats: computeTradeStats(pnls),
              histogram: computePnlHistogram(pnls),
            }),
          ),
        )
      }
      // ?from / ?to (ISO UTC) で chart x-axis のズーム範囲を URL に持つ。
      // grid / symbol 共通: tab 切替・銘柄切替を跨いで zoom range を維持。
      const zoomFrom = parseIsoTimestamp(c.req.query('from'))
      const zoomTo = parseIsoTimestamp(c.req.query('to'))
      if (tab === 'grid') {
        const [universe, global] = await Promise.all([
          loadSymbolUniverse(c.env),
          loadGlobalConfigFrom(c.env),
        ])
        const rules: SymbolChartRules = {
          pullbackMax: global.pullbackDefaultPullbackMax,
          pullbackMin: global.pullbackDefaultPullbackMin,
          stopPct: global.pullbackDefaultStopPct,
          takeProfitPct: global.pullbackDefaultTakeProfitPct,
          timeStopDays: global.pullbackDefaultTimeStopDays,
        }
        const charts = await loadAllSymbolCharts(c.env, universe.allowedSymbols, rules)
        // grid の zoom 基準: 全 panel 共通の dataZoom 同期があるため、最初に
        // load 成功した chart の lastTimestamp を基準に直近 7 日 (default) を
        // 採用する。URL ?from / ?to があればそれを優先 (既存と同挙動)。
        const referenceChart = charts.find((c) => c.chart !== null)?.chart ?? null
        const zoom = computeZoomRange(zoomFrom, zoomTo, referenceChart)
        return c.html(
          layout(
            'チャート',
            chartsBody({
              tab,
              charts,
              zoom,
            }),
          ),
        )
      }
      // tab === 'symbol'
      const symbolParam = c.req.query('symbol')?.toUpperCase().trim() || undefined
      const [universe, global] = await Promise.all([
        loadSymbolUniverse(c.env),
        loadGlobalConfigFrom(c.env),
      ])
      const allowed = new Set(universe.allowedSymbols)
      const defaultSymbol = await pickDefaultSymbol(c.env.DB)
      const focusSymbol =
        symbolParam && allowed.has(symbolParam)
          ? symbolParam
          : defaultSymbol && allowed.has(defaultSymbol)
            ? defaultSymbol
            : universe.allowedSymbols[0] ?? null
      // ルール閾値は global_config から。per-symbol override は POC で未対応
      // (symbol_rules table が無い、env-var 経由なので動的反映困難)。
      const strategyParams: StrategyParamsSnapshot = {
        stopPct: global.pullbackDefaultStopPct,
        takeProfitPct: global.pullbackDefaultTakeProfitPct,
        timeStopDays: global.pullbackDefaultTimeStopDays,
        pullbackMax: global.pullbackDefaultPullbackMax,
        pullbackMin: global.pullbackDefaultPullbackMin,
        minReturn50d: global.pullbackDefaultMinReturn50d,
        requireAboveSma50: global.pullbackDefaultRequireAboveSma50,
        kAtr: global.pullbackDefaultKAtr,
      }
      const rules: SymbolChartRules = {
        pullbackMax: strategyParams.pullbackMax,
        pullbackMin: strategyParams.pullbackMin,
        stopPct: strategyParams.stopPct,
        takeProfitPct: strategyParams.takeProfitPct,
        timeStopDays: strategyParams.timeStopDays,
      }
      // SymbolStateDO の position が ground truth (avgPrice / openedAt が
      // partial fill / position add も反映済)。trade_journal からの derive は
      // 直近 BUY 単体しか拾えないので fallback 専用。
      const symbolChart = focusSymbol
        ? await loadSymbolChart(c.env, focusSymbol, rules)
        : null
      // zoom range: ?from / ?to が valid (from < to) ならそれを使う、なければ
      // chart の最終 point から逆算で「直近 7 日」をデフォルト。理由:
      // - 60 日全体表示は trend / pin / SMA50 が見えづらい (#15 で指摘)
      // - 7 日は cron / 押し目 / 直近 fill 確認に最適な daily-trader の窓
      // - lastTimestamp 基準なので休場や POC 開始直後でも broken にならない
      const zoom = computeZoomRange(zoomFrom, zoomTo, symbolChart)
      return c.html(
        layout(
          'チャート',
          chartsBody({
            tab,
            focusSymbol,
            symbolChart,
            availableSymbols: universe.allowedSymbols,
            strategyParams,
            zoom,
          }),
        ),
      )
    } catch (err) {
      return c.html(layout('チャート', unavailable(messageOf(err))))
    }
  })
  .get('/cron/json', async (c) => {
    if (!c.env.DB) {
      return jsonPretty({ error: 'db_not_bound', message: 'DB binding is not configured' }, 503)
    }
    const db = createDb(c.env.DB)
    const requestedRequestId = c.req.query('requestId')?.trim()
    const requestedDecisionId = c.req.query('decisionId')?.trim()
    try {
      let decisionId: number | undefined
      if (requestedDecisionId && requestedDecisionId.length > 0) {
        if (!/^[1-9]\d*$/.test(requestedDecisionId)) {
          return jsonPretty({ error: 'invalid_decision_id', message: 'decisionId must be a positive integer' }, 400)
        }
        decisionId = Number(requestedDecisionId)
        if (!Number.isSafeInteger(decisionId) || decisionId <= 0) {
          return jsonPretty({ error: 'invalid_decision_id', message: 'decisionId must be a positive integer' }, 400)
        }
      }
      let requestId = requestedRequestId && requestedRequestId.length > 0
        ? requestedRequestId
        : undefined
      if (!requestId && decisionId === undefined) {
        const latest = await db
          .select({ requestId: strategyDecisionLog.requestId })
          .from(strategyDecisionLog)
          .orderBy(desc(strategyDecisionLog.id))
          .limit(50)
        requestId = latest.find((row) => row.requestId !== null)?.requestId ?? undefined
      }
      if (!requestId && decisionId === undefined) {
        return jsonPretty({ error: 'no_cron_logs', message: 'strategy_decision_log has no request_id rows' }, 404)
      }

      const filter = decisionId !== undefined
        ? eq(strategyDecisionLog.id, decisionId)
        : eq(strategyDecisionLog.requestId, requestId as string)
      const rows = await db
        .select({
          id: strategyDecisionLog.id,
          timestamp: strategyDecisionLog.timestamp,
          requestId: strategyDecisionLog.requestId,
          symbol: strategyDecisionLog.symbol,
          decision: strategyDecisionLog.decision,
          reason: strategyDecisionLog.reason,
          price: strategyDecisionLog.price,
          indicatorsJson: strategyDecisionLog.indicatorsJson,
          clientOrderId: strategyDecisionLog.clientOrderId,
          filledPrice: tradeJournal.filledPrice,
          filledQty: tradeJournal.filledQty,
          realizedPnl: tradeJournal.realizedPnl,
          brokerStatus: tradeJournal.brokerStatus,
        })
        .from(strategyDecisionLog)
        .leftJoin(
          tradeJournal,
          and(
            eq(strategyDecisionLog.clientOrderId, tradeJournal.clientOrderId),
            eq(tradeJournal.tradeEventType, 'post_submit'),
          ),
        )
        .where(filter)
        .orderBy(asc(strategyDecisionLog.id))

      return jsonPretty({
        schema: 'dashboard_cron_export.v1',
        exportedAt: new Date().toISOString(),
        ...(decisionId !== undefined ? { decisionId } : { requestId }),
        rowCount: rows.length,
        decisions: rows.map(cronDecisionJson),
      })
    } catch (err) {
      return jsonPretty({ error: 'cron_json_export_failed', message: messageOf(err) }, 500)
    }
  })
  .get('/cron', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('Cron 判定', unavailable('DB not bound')))
    }
    const limit = clampLimit(c.req.query('limit'))
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    const db = createDb(c.env.DB)
    try {
      // trade_journal の post_submit と LEFT JOIN して realized_pnl を引く
      // (#143)。client_order_id が JOIN key — BUY/SELL 成立時のみ strategy
      // 側に記録されているので HOLD/REJECT 行は realized_pnl が NULL に
      // 落ちる (意図通り)。
      const baseQuery = db
        .select({
          id: strategyDecisionLog.id,
          timestamp: strategyDecisionLog.timestamp,
          requestId: strategyDecisionLog.requestId,
          symbol: strategyDecisionLog.symbol,
          decision: strategyDecisionLog.decision,
          reason: strategyDecisionLog.reason,
          price: strategyDecisionLog.price,
          indicatorsJson: strategyDecisionLog.indicatorsJson,
          clientOrderId: strategyDecisionLog.clientOrderId,
          filledPrice: tradeJournal.filledPrice,
          filledQty: tradeJournal.filledQty,
          realizedPnl: tradeJournal.realizedPnl,
          brokerStatus: tradeJournal.brokerStatus,
        })
        .from(strategyDecisionLog)
        .leftJoin(
          tradeJournal,
          and(
            eq(strategyDecisionLog.clientOrderId, tradeJournal.clientOrderId),
            eq(tradeJournal.tradeEventType, 'post_submit'),
          ),
        )
      const rows = symbolFilter
        ? await baseQuery
            .where(eq(strategyDecisionLog.symbol, symbolFilter))
            .orderBy(desc(strategyDecisionLog.id))
            .limit(limit)
        : await baseQuery
            .orderBy(desc(strategyDecisionLog.id))
            .limit(limit)
      return c.html(layout('Cron 判定', cronBody(rows, limit, symbolFilter)))
    } catch (err) {
      // migration 未適用 / 一時的な D1 エラーで 500 にせず unavailable に落とす
      // (CodeRabbit #132)。段階的デプロイ時の自己保護。
      return c.html(layout('Cron 判定', unavailable(messageOf(err))))
    }
  })
  .get('/alerts', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('アラート', unavailable('DB not bound')))
    }
    const limit = clampAlertLimit(c.req.query('limit'))
    const severityFilter = parseSeverityFilter(c.req.query('severity'))
    const eventTypeFilter = parseEventTypeFilter(c.req.query('eventType'))
    const options: LoadAlertOptions = { limit }
    if (eventTypeFilter) {
      options.eventType = eventTypeFilter
    } else if (severityFilter.length > 0) {
      options.severities = severityFilter
    }
    try {
      const rows = await loadRecentAlerts(c.env.DB, options)
      return c.html(
        layout(
          'アラート',
          alertsBody({ rows, limit, severityFilter, eventTypeFilter }),
        ),
      )
    } catch (err) {
      // 0012 migration 未適用 (= notification_emit_log テーブル無し) を
      // 500 にせず unavailable に落とす。段階的デプロイ時の自己保護。
      return c.html(layout('アラート', unavailable(messageOf(err))))
    }
  })

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampLimit(raw: string | undefined): number {
  const n = raw === undefined ? 50 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(n, 200)
}

/**
 * HTML entity escaper. Used on every string derived from D1 / DO payloads
 * (symbol names, error messages, etc.) before interpolating into HTML to
 * defend against injection via crafted config rows.
 */
function esc(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtNumber(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  return n.toFixed(digits)
}

const JST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/**
 * Render an ISO/Date value in JST (YYYY-MM-DD HH:mm:ss JST). Returns the
 * raw string unchanged on parse failure so operators can still grep for the
 * original even if upstream emits a weird format.
 */
function fmtJst(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const d = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(d.getTime())) return typeof value === 'string' ? value : '-'
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} JST`
}

const STYLE = `
  body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:20px;background:#f5f5f7;color:#1d1d1f}
  h1{margin:0 0 16px;font-size:22px}
  nav{margin-bottom:20px;display:flex;gap:12px;flex-wrap:wrap}
  nav a{color:#06c;text-decoration:none;padding:4px 10px;border:1px solid #d0d0d5;border-radius:6px;background:#fff}
  nav a:hover{background:#eef}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #d0d0d5;border-radius:6px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #e5e5ea;font-size:13px;font-variant-numeric:tabular-nums}
  th{background:#fafafa;font-weight:600}
  tr:last-child td{border-bottom:none}
  .muted{color:#86868b}
  .warn{color:#b25000}
  .err{color:#c22}
  .ok{color:#057a55}
  .footer{margin-top:24px;font-size:11px;color:#86868b}
  details{margin-top:16px}
  summary{cursor:pointer;padding:6px 0;font-weight:600}
  .reason-details{margin:0;min-width:260px}
  .reason-details summary{padding:0;color:#06c;font-weight:400}
  .reason-panel{margin-top:8px;padding:10px;border:1px solid #e5e5ea;border-radius:6px;background:#fafafa;color:#1d1d1f;max-width:680px}
  .reason-panel div{margin:0 0 8px}
  .reason-panel div:last-child{margin-bottom:0}
  .reason-panel ul{margin:4px 0 10px;padding-left:20px}
  .reason-panel code{white-space:pre-wrap;word-break:break-word}
  .reason-panel pre{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px}
`

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} — Webull Trading</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Webull Trading — ${esc(title)}</h1>
<nav>
  <a href="/dashboard">ホーム</a>
  <a href="/dashboard/positions">保有状況</a>
  <a href="/dashboard/portfolio">ポートフォリオ</a>
  <a href="/dashboard/trades">約定履歴</a>
  <a href="/dashboard/config">設定</a>
  <a href="/dashboard/cron">Cron</a>
  <a href="/dashboard/charts">チャート</a>
  <a href="/dashboard/alerts">アラート</a>
</nav>
${body}
<div class="footer">画面生成時刻: ${esc(fmtJst(new Date()))}</div>
</body>
</html>`
}

function unavailable(reason: string): string {
  return `<p class="warn">利用不可: ${esc(reason)}</p>`
}

function jsonPretty(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function parseJsonObject(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function indexBody(): string {
  return `<p>運用者向け読み取り専用ダッシュボード。各ページは Basic 認証で保護されています。</p>
<ul>
  <li><a href="/dashboard/positions">保有状況</a> — 全銘柄の Durable Object 状態 (保有 / 平均取得単価 / 未約定注文 / クールダウン)</li>
  <li><a href="/dashboard/portfolio">ポートフォリオ</a> — 当日始値資産 / 当日実現損益 / ドローダウン / 緊急停止 (kill-switch)</li>
  <li><a href="/dashboard/trades">約定履歴</a> — <code>trade_journal</code> 直近 (既定 50件、<code>?limit=N</code> で可変、最大 200)</li>
  <li><a href="/dashboard/config">設定</a> — <code>global_config</code> + 有効な <code>symbol_config</code></li>
  <li><a href="/dashboard/cron">Cron 判定</a> — <code>strategy_decision_log</code> 直近 (<code>?symbol=SOXL</code> で絞り込み可)</li>
  <li><a href="/dashboard/charts">チャート</a> — 概要 (エクイティカーブ + ドローダウン) / 取引品質 (PnL 分布 + 統計 + Decision breakdown) / 個別銘柄 (price + SMA50 + entry/exit) を tab 切替</li>
  <li><a href="/dashboard/alerts">アラート</a> — Slack/Discord に push 通知した critical / warning / info の直近 (#141)。webhook 未設定でも D1 に記録される。</li>
</ul>`
}

/**
 * 各銘柄の「strategy が直近に判定で使った価格」を取得。
 * Yahoo daily bars から計算された `indicators.price` が
 * strategy_decision_log.price に書き出されているので、最新行を引く。
 *
 * Webull bridge が落ちて lastQuote が古い場合、こちらが新しければ
 * dashboard の現在値表示に採用される (pickFreshQuote で比較)。
 *
 * 実装: D1 の `(symbol, id)` 複合 index を活かして symbol 並列で
 * `ORDER BY id DESC LIMIT 1` を打つ。1 銘柄あたり 1 row のみ転送。
 */
async function loadLatestStrategyPrices(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, { price: number; asOf: string }>> {
  if (symbols.length === 0) return new Map()
  const drizzle = createDb(db)
  // 個別 symbol の失敗で全体を 500 にしないよう per-symbol で catch。
  // strategy_decision_log がまだ空の銘柄や DB 一時的エラーは「Yahoo 価格なし」
  // として扱い、Webull lastQuote にフォールバックさせる。
  const entries = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const row = await drizzle
          .select({
            symbol: strategyDecisionLog.symbol,
            price: strategyDecisionLog.price,
            timestamp: strategyDecisionLog.timestamp,
          })
          .from(strategyDecisionLog)
          .where(eq(strategyDecisionLog.symbol, sym))
          .orderBy(desc(strategyDecisionLog.id))
          .limit(1)
        const r = row[0]
        if (!r || r.price === null || r.price === undefined) return null
        return [r.symbol, { price: r.price, asOf: r.timestamp }] as const
      } catch {
        return null
      }
    }),
  )
  return new Map(entries.filter((e): e is readonly [string, { price: number; asOf: string }] => e !== null))
}

/**
 * 表示用「現在値」の決定。dashboard が見せる現在値の source は
 * 2 系統あり、bridge 障害などで Webull snapshot が古くなる場合がある:
 *
 * - webull-snapshot: SymbolStateDO.lastQuote (Webull bridge の 5 分 cron)
 * - yahoo-bars: strategy_decision_log.price (Yahoo daily bars 経由、15 分 cron)
 *
 * 両方あれば asOf が新しい方を採用。strategy が判定に使う価格と表示が
 * 一致するのが UX 上の正なので、片方だけしか無い場合もそちらを採る。
 */
interface ResolvedQuote {
  price: number
  source: string
  asOf: string
}

export function pickFreshQuote(
  webull: { price: number; source: string; asOf: string } | null,
  yahoo: { price: number; asOf: string } | null,
): ResolvedQuote | null {
  if (webull === null && yahoo === null) return null
  if (webull === null) return { price: yahoo!.price, source: 'yahoo-bars', asOf: yahoo!.asOf }
  if (yahoo === null) return { price: webull.price, source: webull.source, asOf: webull.asOf }
  const w = new Date(webull.asOf).getTime()
  const y = new Date(yahoo.asOf).getTime()
  // 不正な ISO は "より古い" 扱い: 有効な側があればそちらを採用、両方
  // 不正なら webull にタイブレーク (既存挙動維持)。`y > w` だけだと
  // w=NaN の時に false 評価で不正な webull を選んでしまう回帰がある。
  const wValid = Number.isFinite(w)
  const yValid = Number.isFinite(y)
  const pickYahoo = yValid && (!wValid || y > w)
  return pickYahoo
    ? { price: yahoo.price, source: 'yahoo-bars', asOf: yahoo.asOf }
    : { price: webull.price, source: webull.source, asOf: webull.asOf }
}

function positionsBody(
  rows: Array<{ sym: string; state: SymbolState | null; error: string | null }>,
  strategyPriceMap: Map<string, { price: number; asOf: string }>,
): string {
  if (rows.length === 0) return `<p class="muted">有効な銘柄がありません。</p>`
  const tbody = rows
    .map((r) => {
      if (r.error !== null || r.state === null) {
        return `<tr><td>${esc(r.sym)}</td><td colspan="7" class="err">${esc(r.error ?? '状態取得不可')}</td></tr>`
      }
      const s = r.state
      const pos = s.position
      const webull = s.lastQuote
        ? { price: s.lastQuote.price, source: s.lastQuote.source, asOf: s.lastQuote.asOf ?? s.lastQuote.fetchedAt }
        : null
      const yahoo = strategyPriceMap.get(s.symbol) ?? null
      const quote = pickFreshQuote(webull, yahoo)
      const pendingSide = s.pendingOrder?.side
      const pnlPct =
        pos !== null && quote !== null && pos.avgPrice > 0
          ? ((quote.price - pos.avgPrice) / pos.avgPrice) * 100
          : null
      const pnlClass = pnlPct === null ? 'muted' : pnlPct >= 0 ? 'ok' : 'err'
      const quoteCell = quote
        ? `${fmtNumber(quote.price, 2)} <span class="muted" style="font-size:11px">(${esc(quote.source)}, ${esc(formatQuoteAsOf(quote.asOf))})</span>`
        : '<span class="muted">—</span>'
      return `<tr>
        <td><strong>${esc(s.symbol)}</strong></td>
        <td>${pos ? esc(pos.qty) : '<span class="muted">—</span>'}</td>
        <td>${pos ? fmtNumber(pos.avgPrice, 2) : '<span class="muted">—</span>'}</td>
        <td>${quoteCell}</td>
        <td class="${pnlClass}">${pnlPct === null ? '—' : fmtNumber(pnlPct, 2) + '%'}</td>
        <td>${pendingSide ? esc(pendingSide) : '<span class="muted">—</span>'}</td>
        <td>${formatCooldown(s.cooldownUntil)}</td>
        <td class="muted">${esc(fmtJst(s.updatedAt))}</td>
      </tr>`
    })
    .join('')
  return `<p class="muted" style="font-size:12px">
    評価損益は未実現 (現在値 vs 平均取得単価)。実約定損益は
    <a href="/dashboard/cron">/dashboard/cron</a> 「実 損益」列を参照。
  </p>
  <table>
    <thead><tr>
      <th>銘柄</th><th>数量</th><th>平均取得単価</th><th>現在値 (source, asOf)</th><th>評価損益</th>
      <th>未約定</th><th>クールダウン</th><th>更新時刻</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function portfolioBody(p: {
  dailyStartEquity: number
  dailyRealizedPnl: number
  tradingDisabledUntil: string | null
  lastRolledAt?: string | null
  updatedAt: string
}): string {
  const drawdownPct =
    p.dailyStartEquity > 0 ? (p.dailyRealizedPnl / p.dailyStartEquity) * 100 : null
  const ddClass = drawdownPct === null ? 'muted' : drawdownPct >= 0 ? 'ok' : 'err'
  const kill = p.tradingDisabledUntil
  const lastRolledCell = renderLastRolledCell(p.lastRolledAt ?? null)
  return `<table>
    <tbody>
      <tr><th>当日始値資産 (dailyStartEquity)</th><td>${fmtNumber(p.dailyStartEquity, 2)}</td></tr>
      <tr><th>当日実現損益 (dailyRealizedPnl)</th><td class="${ddClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</td></tr>
      <tr><th>ドローダウン (drawdown)</th><td class="${ddClass}">${drawdownPct === null ? '—' : fmtNumber(drawdownPct, 2) + '%'}</td></tr>
      <tr><th>取引停止解除時刻 (tradingDisabledUntil)</th><td>${kill ? `<span class="warn">${esc(fmtJst(kill))}</span>` : '<span class="ok">稼働中</span>'}</td></tr>
      <tr><th>EOD ロールオーバー実行時刻 (lastRolledAt)</th><td>${lastRolledCell}</td></tr>
      <tr><th>更新時刻 (updatedAt)</th><td class="muted">${esc(fmtJst(p.updatedAt))}</td></tr>
    </tbody>
  </table>`
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

function tradesBody(
  rows: Array<{
    id: number
    timestamp: string
    tradeEventType: string
    symbol: string | null
    side: string | null
    quantity: number | null
    limitPrice: number | null
    filledQty: number | null
    filledPrice: number | null
    brokerStatus: string | null
    mode: string | null
    errorMessage: string | null
  }>,
  limit: number,
): string {
  if (rows.length === 0) {
    return `<p class="muted">trade_journal にレコードがありません (limit=${limit})。</p>`
  }
  const tbody = rows
    .map((r) => {
      const statusClass =
        r.errorMessage
          ? 'err'
          : r.brokerStatus === 'FILLED'
            ? 'ok'
            : r.brokerStatus
              ? 'warn'
              : 'muted'
      // status セルは enum 値 (FILLED/CANCELED 等) は英字のまま、error は
      // "エラー: " を和訳 prefix。運用者が grep / broker API と突き合わせ
      // しやすい粒度を保つ。
      const statusText =
        r.errorMessage ? `エラー: ${r.errorMessage}` : r.brokerStatus ?? r.tradeEventType
      return `<tr>
        <td>${r.id}</td>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td>${esc(r.tradeEventType)}</td>
        <td><strong>${esc(r.symbol ?? '—')}</strong></td>
        <td>${esc(r.side ?? '—')}</td>
        <td>${r.quantity === null ? '—' : esc(r.quantity)}</td>
        <td>${r.limitPrice === null ? '—' : fmtNumber(r.limitPrice, 2)}</td>
        <td>${r.filledQty === null ? '—' : esc(r.filledQty)}</td>
        <td>${r.filledPrice === null ? '—' : fmtNumber(r.filledPrice, 2)}</td>
        <td class="${statusClass}">${esc(statusText)}</td>
        <td>${esc(r.mode ?? '—')}</td>
      </tr>`
    })
    .join('')
  return `<p class="muted">直近 ${rows.length} 件 (limit=${limit}、最大 200)。</p>
  <table>
    <thead><tr>
      <th>ID</th><th>日時</th><th>イベント</th><th>銘柄</th><th>売買</th>
      <th>数量</th><th>指値</th><th>約定数量</th><th>約定単価</th><th>状態</th><th>モード</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function configBody(
  global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>,
  universe: Awaited<ReturnType<typeof loadSymbolUniverse>>,
): string {
  // 列名 (snake_case) は SQL での copy-paste 互換のため英字のまま残し、
  // 日本語説明は別列に分離。これで `UPDATE global_config SET xxx = ...` が
  // そのまま使える。
  const globalRows = Object.entries(global as unknown as Record<string, unknown>)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => {
      const camelKey = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
      // DB 列名の digit 前 underscore は列ごとに揺れがある
      // (min_return_50d は有 / require_above_sma50 は無)。
      // naive 版 → digit 前 underscore 版の順でフォールバック。
      const camelKeyWithDigitUnderscore = camelKey.replace(/([a-z])(\d)/g, '$1_$2')
      const meta =
        CONFIG_KEY_META[camelKey] ??
        CONFIG_KEY_META[camelKeyWithDigitUnderscore] ??
        CONFIG_KEY_META[k]
      const label = meta?.label ?? '—'
      const detail = meta?.detail ?? '—'
      return `<tr><th>${esc(camelKey)}</th><td>${esc(formatConfigValue(v))}</td><td class="muted">${esc(label)}</td><td class="muted" style="font-size:11px">${esc(detail)}</td></tr>`
    })
    .join('')
  const symRows = universe.allowedSymbols
    .map(
      (sym) =>
        `<tr>
          <td><strong>${esc(sym)}</strong></td>
          <td>${esc(universe.symbolCurrency[sym] ?? '—')}</td>
          <td>${universe.symbolMaxNotional[sym] != null ? esc(universe.symbolMaxNotional[sym]) : '<span class="muted">—</span>'}</td>
          <td>${universe.inversePairs[sym] ? esc(universe.inversePairs[sym]) : '<span class="muted">—</span>'}</td>
        </tr>`,
    )
    .join('')
  return `<details open>
    <summary>グローバル設定 (global_config)</summary>
    <table>
      <thead><tr><th>Key</th><th>値</th><th>説明</th><th>詳細</th></tr></thead>
      <tbody>${globalRows}</tbody>
    </table>
  </details>
  <details open>
    <summary>銘柄別設定 (symbol_config、active=1) — ${universe.allowedSymbols.length} 銘柄</summary>
    <table>
      <thead><tr><th>銘柄</th><th>通貨</th><th>1注文あたり上限 (max_notional)</th><th>インバース対 (inverse)</th></tr></thead>
      <tbody>${symRows}</tbody>
    </table>
  </details>`
}

/**
 * global_config 列のメタ情報 (label + detail)。
 *
 * - `label`: 短い見出し (単位込み)。IT / 汎用英単語 (dry-run / drawdown / spread
 *   等) は英字のまま、日本株固有語 (押し目 / 建玉 / 利食い / 損切り / 騰落率)
 *   のみ日本語化。
 * - `detail`: 株初心者向け advisory。1-3 文、「何をするか」「大小で何が変わるか」
 *   「目安」の順で記述。技術用語を避け具体的な動作で説明。
 *
 * 未登録 key の fallback は em-dash。
 */
interface ConfigKeyMeta {
  label: string
  detail: string
}

const CONFIG_KEY_META: Record<string, ConfigKeyMeta> = {
  dry_run: {
    label: 'dry-run (bool)',
    detail: 'true にすると実際には注文せず動作確認だけ。false で証券会社へ本当に注文します。テスト中は true、本番のみ false に。',
  },
  trading_enabled: {
    label: 'trading enabled (bool)',
    detail: 'false にすると全ての注文を拒否します。緊急停止用のスイッチ。止めたい時だけ false に。',
  },
  market_hours_check: {
    label: '場中チェック (bool)',
    detail: 'true で市場時間外の注文を防ぎます。false は 24 時間発注可 (sandbox 確認用)。',
  },
  max_order_notional: {
    label: '1注文上限 (非推奨)',
    detail: '旧 generic 上限 (通貨別 cap 導入前の互換)。現在は参照されないので触らなくて OK。',
  },
  max_order_notional_usd: {
    label: '1注文上限 (USD)',
    detail: 'US 株 1 回あたりの発注上限額 (ドル)。大きすぎる注文を防ぐ安全装置。$2000 なら 1 銘柄最大 $2000 まで。',
  },
  max_order_notional_jpy: {
    label: '1注文上限 (JPY)',
    detail: '日本株 1 回あたりの発注上限額 (円)。同上の円版。¥100000 なら 1 銘柄最大 10 万円まで。',
  },
  total_capital_usd: {
    label: '運用資本 (USD)',
    detail: 'US 株に割り当てる運用資金 (ドル)。この金額を元に 1 回のリスク額や保有上限を計算します。',
  },
  total_capital_jpy: {
    label: '運用資本 (JPY)',
    detail: '日本株に割り当てる運用資金 (円)。この金額を元に 1 回のリスク額や保有上限を計算します。',
  },
  max_portfolio_exposure_pct: {
    label: 'portfolio exposure 上限率 (比率)',
    detail: '同時保有の合計上限を「資本 × この率」で決めます。0.6 なら 60%。大きくすると分散度↑、損失時の衝撃↑。',
  },
  drawdown_kill_threshold: {
    label: 'drawdown kill 閾値 (比率、負)',
    detail: 'その日の損失がこの割合を超えたら、その日は新規売買を止めます。きつく -2% だと早く止まる、緩く -8% だと下げを我慢して継続。',
  },
  stale_quote_ms: {
    label: '気配値鮮度上限 (ms)',
    detail: '気配値が古すぎる時に判定を止める閾値。900000 = 15 分。短いと厳格、長いと古い気配でも売買。',
  },
  gap_reject_pct: {
    label: 'gap reject 閾値 (比率)',
    detail: '前日終値からの寄付 gap がこの率を超えた銘柄は買わない。0.03 = 3% 以上の gap で見送り。寄付の高値掴みを防ぐ。',
  },
  spread_limit_pct_us: {
    label: 'spread 上限率 (US、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。US は 0.25% 目安。',
  },
  spread_limit_pct_jp: {
    label: 'spread 上限率 (JP、比率)',
    detail: '買値と売値の差 (spread) がこの率を超えた銘柄は流動性不足で見送り。日本株は 0.6% 目安。',
  },
  pullback_default_stop_pct: {
    label: '損切り幅 (比率、負)',
    detail: '損切りライン。買値からこの率下がったら売却。-0.04 = -4%。深いと耐えるが大損失リスク、浅いと早く切るが騙し上げで空振り。',
  },
  pullback_default_take_profit_pct: {
    label: '利食い目標 (比率)',
    detail: '利食い目標。買値からこの率上がったら売却。0.07 = +7%。高いと大きな利益を狙うが取り逃す、低いとコツコツ確定。',
  },
  pullback_default_time_stop_days: {
    label: '最大保有日数 (営業日)',
    detail: '建玉を保有する最大日数。この日数を超えても利食い/損切りに達しなければ強制売却。10 = 約 2 週間。',
  },
  pullback_default_pullback_max: {
    label: '押し目上限 (比率、負)',
    detail: '押し目買いを狙う「浅い側」の下落率閾値。-0.03 なら「-3% 以上下げた銘柄を候補に」。緩めると機会↑、騙し↑。',
  },
  pullback_default_pullback_min: {
    label: '押し目下限 (比率、負)',
    detail: '押し目買いを狙う「深い側」の下落率閾値。-0.06 なら「-6% より深い下げは敬遠」。深すぎる下げは反発せず転換の可能性。',
  },
  pullback_default_min_return_50d: {
    label: '50日最低騰落率 (比率)',
    detail: '過去 50 日の騰落率がこの値以上の銘柄だけ押し目買い対象。0.08 = +8%。上昇トレンド銘柄を絞るフィルター。',
  },
  pullback_default_require_above_sma50: {
    label: 'SMA50 超必須 (bool)',
    detail: 'true で 50 日移動平均線より上の銘柄だけ買い対象。上昇トレンドフィルターを厳しくする。',
  },
  pullback_default_k_atr: {
    label: 'ATR 倍率',
    detail: '損切り幅を ATR (日々の値動き幅) の何倍にするか。2.0 が標準。大きくすると激しい値動き銘柄でも余裕を持って保有、小さいと早めに損切り。',
  },
  risk_base_per_trade_pct: {
    label: '基本リスク率 (比率)',
    detail: '1 回のトレードで失ってよい割合 (対 総資本)。0.004 = 0.4%。大きくすると 1 回あたりの建玉サイズ↑、連敗時の損失↑。',
  },
  risk_dd_half_threshold: {
    label: 'risk half 閾値 (比率、負)',
    detail: '日次損失がこの率を超えたら 1 回のリスクを半分に減らす。-0.05 = -5%。連敗時の傷を浅く保つ自動ブレーキ。',
  },
  risk_dd_halt_threshold: {
    label: 'risk halt 閾値 (比率、負)',
    detail: '日次損失がこの率を超えたら 1 回のリスクを 0 に (新規 entry 停止)。-0.10 = -10%。drawdown_kill より前の緊急ブレーキ。',
  },
  bucket_exposure_pct: {
    label: '同グループ建玉上限率 (比率)',
    detail: '同じグループ (例: 半導体 ETF) の合計をこの率まで保有可。0.30 = 総資本の 30%。大きくすると集中投資↑、小さいと分散↑。',
  },
}

/**
 * cooldownUntil を保有状況テーブル向けに整形。null または past timestamp
 * (admin /clear-cooldown で epoch 0 が書き込まれた状態等) は「解除済」
 * 扱いで em-dash を返す。strategy 側の `cooldownUntil > now` 判定と表示を
 * 整合させ、"1970-01-01 09:00:00 JST" がクールダウン列に残るように見える
 * 不具合を解消する (#145 admin clear-cooldown の副作用)。
 */
function formatCooldown(cooldownUntil: string | null): string {
  if (!cooldownUntil) return '<span class="muted">—</span>'
  const ms = new Date(cooldownUntil).getTime()
  if (!Number.isFinite(ms) || ms <= Date.now()) {
    return '<span class="muted">—</span>'
  }
  return `<span class="warn">${esc(fmtJst(cooldownUntil))}</span>`
}

/**
 * QuoteSnapshot.asOf (ISO) を JST の絶対表記 `MM/DD HH:MM JST` に。
 * 相対表記 (NN日前) は週末・場外で必ず古く見えてしまい「壊れている風」に
 * 誤読されやすいため、絶対時刻を出して「金曜引け」と一目で分かるようにする。
 */
export function formatQuoteAsOf(asOf: string): string {
  const d = new Date(asOf)
  if (!Number.isFinite(d.getTime())) return '?'
  const parts = JST_FORMATTER.formatToParts(d)
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')} ${pick('hour')}:${pick('minute')} JST`
}

function formatConfigValue(v: unknown): string {
  // null placeholder は他ページと同じ em-dash (—) に統一。"null" 文字列は
  // 運用者が誤って "null" という string 値と混同するリスクがあるので避ける。
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/**
 * Numeric string ratio → 符号付き % 表記 (0.0108 → "+1.08%"、-0.04 → "-4.00%")。
 * fallback は原文字列 (数値 parse 失敗時は canonical な reason を見せる方が安全)。
 */
function fmtPct(s: string): string {
  const n = Number(s)
  if (!Number.isFinite(n)) return s
  const pct = n * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

/**
 * Strategy / sizing が出力する英語 reason を **初心者にも分かる日本語** に翻訳
 * する display helper。ログ DB は英語 canonical のまま、表示層でのみ翻訳
 * (tests / journal の契約に影響させない)。
 *
 * 統一テンプレ: `[判定ラベル]: [事実] ([具体値])`
 *
 * 判定ラベル (10 種):
 *   - 保有前の評価系 4 種: 様子見 / 買い / 発注中 / データ不足
 *   - 保有中の exit 系 4 種: 利食い / 損切り / 時間切れ / 保有継続
 *   - 発注拒否系 2 種: 発注スキップ (pre-submit) / 発注エラー (broker 拒否)
 *
 * `発注スキップ` は sizing / 同グループ建玉上限 / 売買単位未満などで
 * **注文送出前** に止めた場合。`発注エラー` は broker に送ったが拒否された
 * 場合 (broker submit error) — 原因が手元か相手方かを区別するため別ラベル。
 *
 * trading-strategist review に基づき、日本株・信用取引の伝統語 (押し目 /
 * 含み損益 / 建玉 / 単元 / 移動平均線割れ / 日柄 / 手仕舞い / 騰落率 / ロスカット
 * 派生の損切りライン) と証券アプリ準拠の英字 (SMA50, ATR) を混在。
 */
export function localizeReason(en: string | null | undefined): string {
  if (!en) return '-'
  let s = en

  // === 発注中 / 取引停止 (entry 前ガード) ===
  s = s.replace(/^pending order in flight$/, '発注中: 直前注文の約定待ち')
  // cooldown の timestamp は UTC ISO で emit されるが operator 向けには JST 表記が
  // 読みやすい。fmtJst は parse 失敗時に原文字列を返すので安全 (CodeRabbit)。
  s = s.replace(
    /^cooldown active until (.+)$/,
    (_m, ts) => `様子見: 取引停止中 (${fmtJst(ts)} まで)`,
  )
  s = s.replace(/^pending order already in flight$/, '発注中: 同銘柄の注文処理中')

  // === 保有中の exit 判定 ===
  // 「含み益/含み損」= 未実現損益の日本株標準語。strategy.ts の pnlPct は
  // (現値 - 取得価格)/取得価格 で未実現なのでこちらを採用。
  s = s.replace(
    /^take-profit hit: pnl (\S+) >= (\S+)$/,
    (_m, p, t) => `利食い: 利確目標到達 (含み損益 ${fmtPct(p)} ≥ 目標 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^stop-loss hit: pnl (\S+) <= (\S+)$/,
    (_m, p, t) => `損切り: 損切りライン到達 (含み損益 ${fmtPct(p)} ≤ ライン ${fmtPct(t)})`,
  )
  s = s.replace(
    /^time-stop hit: held (\S+) >= (\S+)$/,
    '時間切れ: 保有期限到達 (保有 $1 ≥ 上限 $2)',
  )
  s = s.replace(
    /^holding: pnl (\S+) within \(([^,]+),\s*([^)]+)\)$/,
    (_m, p, low, high) =>
      `保有継続: 含み損益 ${fmtPct(p)} (利食い ${fmtPct(high)} / 損切り ${fmtPct(low)} の範囲内)`,
  )

  // === 未保有の entry 判定 (様子見) ===
  // 「移動平均線割れ」は日本株の慣用表現。
  s = s.replace(
    /^50d return (\S+) <= (\S+) trend threshold$/,
    (_m, r, t) =>
      `様子見: 上昇トレンド未成立 (50日騰落率 ${fmtPct(r)} ≤ 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^price (\S+) <= sma50 (\S+)$/,
    '様子見: 50日移動平均線割れ (株価 $1 ≤ 移動平均 $2)',
  )
  s = s.replace(/^invalid 20d high$/, 'データ不足: 直近20日高値を算出できず')
  s = s.replace(
    /^pullback (\S+) > (\S+) \(not deep enough\)$/,
    (_m, p, t) => `様子見: 押し目が浅い (下落率 ${fmtPct(p)} > 条件 ${fmtPct(t)})`,
  )
  s = s.replace(
    /^pullback (\S+) < (\S+) \(too deep\)$/,
    (_m, p, t) =>
      `様子見: 押し目が深すぎる/下落転換懸念 (下落率 ${fmtPct(p)} < 許容 ${fmtPct(t)})`,
  )

  // === BUY signal (押し目買い成立) ===
  s = s.replace(
    /^pullback (\S+) in uptrend \(50d return (\S+)\)$/,
    (_m, p, r) =>
      `買い: 上昇トレンド中の押し目買い (下落率 ${fmtPct(p)}、50日騰落率 ${fmtPct(r)})`,
  )

  // === Sizing 系 reject (発注スキップ) ===
  // 「建玉可」= risk 予算で保有可能な建玉数 (信用取引等での "許容建玉" 用法)
  s = s.replace(
    /^sizing rejected: lot-size-round \(raw qty (\S+) < lot (\S+), stop (\S+), entry (\S+)\)$/,
    '発注スキップ: 売買単位未満 (建玉可 $1 株 < 1単元 $2 株、損切り幅 $3/株、株価 $4)',
  )
  s = s.replace(
    /^sizing rejected: insufficient-risk-budget \(budget (\S+)\)$/,
    '発注スキップ: リスク予算枯渇 (残 $1)',
  )
  s = s.replace(/^sizing rejected: atr-floor$/, '発注スキップ: ボラティリティ低下 (ATR 下限割れ)')
  s = s.replace(/^sizing rejected: symbol-cap$/, '発注スキップ: 銘柄別投資上限超過')
  s = s.replace(
    /^sizing rejected: invalid-stop \(stopDistance (\S+)\)$/,
    '発注スキップ: 損切り幅が算出不能 ($1)',
  )
  s = s.replace(/^sizing rejected: zero qty$/, '発注スキップ: 発注株数が 0')

  // === Scheduler inline ===
  s = s.replace(/^SELL without position$/, '発注スキップ: 手仕舞い対象の建玉なし')
  s = s.replace(/^insufficient bars for indicators$/, 'データ不足: 指標計算に必要な日柄不足')
  s = s.replace(/^invalid price: (\S+)$/, 'データ不足: 株価が無効 ($1)')
  s = s.replace(/^invalid notional:/, 'データ不足: 発注金額が無効:')
  s = s.replace(/^invalid position qty: (\S+)$/, 'データ不足: 建玉数が無効 ($1)')
  s = s.replace(/^invalid expiresAt/, 'データ不足: 注文有効期限が無効')
  s = s.replace(/^bar fetch: /, 'データ不足: 日足取得失敗 — ')
  s = s.replace(/^broker submit error: /, '発注エラー: 証券会社側で拒否 — ')

  // === Bucket cap (同グループ建玉上限) ===
  // "建玉上限" は信用取引で広く使われる正統用語。bucket は運用者が任意に
  // 付けるグループタグ (半導体 3x / JP 自動車 等) で、必ずしも業種ではない
  // ので「同グループ」で表現。
  s = s.replace(
    /^bucket cap: (\S+) projected (\S+) > (\S+)$/,
    '発注スキップ: 同グループ建玉上限超過 ($1 合計 $2 > 上限 $3)',
  )
  // bucketExposureGate.ts は `bucket cap: X invalid cap Y` / `... invalid addNotional Y`
  // の 2 形で emit する (非有限 / ≤0 のとき fail-closed reject)。
  s = s.replace(
    /^bucket cap: (\S+) invalid cap (\S+)$/,
    '発注スキップ: 同グループ建玉上限が無効 ($1 の上限 $2)',
  )
  s = s.replace(
    /^bucket cap: (\S+) invalid addNotional (\S+)$/,
    'データ不足: 同グループ発注金額が無効 ($1 の金額 $2)',
  )
  return s
}

/**
 * `?limit=N` を 1〜500 の範囲に丸める。`/dashboard/alerts` 専用 (cron 系の
 * `clampLimit` は既定 50 / max 200 で別ロール)。
 */
function clampAlertLimit(raw: string | undefined): number {
  const n = raw === undefined ? 100 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(n, 500)
}

const SEVERITY_VALUES: ReadonlyArray<NotificationSeverity> = ['critical', 'warning', 'info']

function parseSeverityFilter(raw: string | undefined): NotificationSeverity[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is NotificationSeverity =>
      (SEVERITY_VALUES as readonly string[]).includes(s),
    )
}

const EVENT_TYPE_VALUES: ReadonlyArray<NotificationEvent['type']> = [
  'TRADE',
  'ERROR',
  'STATE_CHANGE',
]

function parseEventTypeFilter(raw: string | undefined): NotificationEvent['type'] | undefined {
  if (!raw) return undefined
  const upper = raw.trim().toUpperCase() as NotificationEvent['type']
  return (EVENT_TYPE_VALUES as readonly string[]).includes(upper) ? upper : undefined
}

interface AlertsBodyArgs {
  rows: AlertRow[]
  limit: number
  severityFilter: NotificationSeverity[]
  eventTypeFilter: NotificationEvent['type'] | undefined
}

/**
 * `/dashboard/alerts` の HTML 本文 (#141)。
 *
 *   - severity ピル (critical / warning / info / 全件) で絞り込み
 *   - event type ピル (TRADE / ERROR / STATE_CHANGE / 全件) で絞り込み
 *   - 表示は最新 100 件 (`?limit=N` で 1〜500)
 *   - 行クリックで Slack/Discord に出したのと同じ message を JST 時刻と一緒に確認
 */
function alertsBody(args: AlertsBodyArgs): string {
  const { rows, limit, severityFilter, eventTypeFilter } = args
  const filterDescription =
    severityFilter.length === 0 && eventTypeFilter === undefined
      ? '全件'
      : [
          severityFilter.length > 0 ? `severity=${severityFilter.join(',')}` : null,
          eventTypeFilter ? `eventType=${eventTypeFilter}` : null,
        ]
          .filter((s): s is string => s !== null)
          .join(' / ')
  const header = `<p class="muted">直近 ${rows.length} 件のアラート (${esc(filterDescription)}, limit=${limit}, max 500)。Webhook が未設定でも D1 には記録されています。</p>`
  const filterPills = renderAlertFilterPills(severityFilter, eventTypeFilter)
  if (rows.length === 0) {
    return `${header}${filterPills}<p class="muted">該当するアラートは見つかりませんでした。</p>`
  }
  const tbody = rows
    .map((r) => {
      const cls =
        r.severity === 'critical'
          ? 'err'
          : r.severity === 'warning'
            ? 'warn'
            : 'muted'
      const symbolCell = r.symbol
        ? `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}">${esc(r.symbol)}</a>`
        : '<span class="muted">-</span>'
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td class="${cls}"><strong>${esc(r.severity)}</strong></td>
        <td>${esc(r.eventType)}</td>
        <td>${symbolCell}</td>
        <td>${esc(r.cause ?? '-')}</td>
        <td><code style="white-space:pre-wrap">${esc(r.message)}</code></td>
        <td class="muted"><code>${esc(r.requestId ?? '-')}</code></td>
      </tr>`
    })
    .join('')
  return `${header}${filterPills}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>severity</th><th>event</th><th>symbol</th><th>cause / field</th><th>message</th><th>requestId</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function renderAlertFilterPills(
  active: NotificationSeverity[],
  activeEventType: NotificationEvent['type'] | undefined,
): string {
  const sevPill = (label: string, query: string, isActive: boolean): string =>
    `<a href="/dashboard/alerts${query}" style="margin-right:6px;${isActive ? 'background:#1d1d1f;color:#fff;' : ''}">${esc(label)}</a>`
  const sev = [
    sevPill('全 severity', '', active.length === 0),
    sevPill('critical', '?severity=critical', active.length === 1 && active[0] === 'critical'),
    sevPill('warning', '?severity=warning', active.length === 1 && active[0] === 'warning'),
    sevPill('critical+warning', '?severity=critical,warning', active.length === 2 && active.includes('critical') && active.includes('warning')),
    sevPill('info', '?severity=info', active.length === 1 && active[0] === 'info'),
  ].join('')
  const evPill = (label: string, query: string, isActive: boolean): string =>
    `<a href="/dashboard/alerts${query}" style="margin-right:6px;${isActive ? 'background:#1d1d1f;color:#fff;' : ''}">${esc(label)}</a>`
  const ev = [
    evPill('全 type', '', activeEventType === undefined),
    evPill('ERROR', '?eventType=ERROR', activeEventType === 'ERROR'),
    evPill('TRADE', '?eventType=TRADE', activeEventType === 'TRADE'),
    evPill('STATE_CHANGE', '?eventType=STATE_CHANGE', activeEventType === 'STATE_CHANGE'),
  ].join('')
  return `<nav style="margin-bottom:12px">${sev}<span class="muted" style="margin:0 8px">|</span>${ev}</nav>`
}

function cronBody(
  rows: Array<{
    id: number
    timestamp: string
    requestId: string | null
    symbol: string
    decision: string
    reason: string | null
    price: number | null
    indicatorsJson?: string | null
    clientOrderId?: string | null
    filledPrice?: number | null
    filledQty?: number | null
    realizedPnl?: number | null
    brokerStatus?: string | null
  }>,
  limit: number,
  symbolFilter: string | undefined,
): string {
  const header = symbolFilter
    ? `<p class="muted">Showing ${rows.length} decisions for <strong>${esc(symbolFilter)}</strong> (limit=${limit}, max 200)。<a href="/dashboard/cron">全銘柄へ戻る</a> / <a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a></p>`
    : `<p class="muted">Showing ${rows.length} decisions (limit=${limit}, max 200)。<code>?symbol=SOXL</code> で絞り込み可能。<a href="/dashboard/cron/json" target="_blank" rel="noreferrer">最新run JSON</a></p>`
  if (rows.length === 0) {
    return `${header}<p class="muted">判定ログがまだありません。</p>`
  }
  const tbody = rows
    .map((r) => {
      const cls =
        r.decision === 'BUY'
          ? 'ok'
          : r.decision === 'SELL'
            ? 'warn'
            : r.decision === 'ERROR'
              ? 'err'
              : r.decision === 'REJECT'
                ? 'warn'
                : 'muted'
      // 実 fill 結果 (trade_journal post_submit から JOIN、#143)
      // realized_pnl は主に SELL で非 null (利確/損切のドル額)。BUY の realized は null。
      const realizedCell =
        r.realizedPnl === null || r.realizedPnl === undefined
          ? '-'
          : formatRealizedPnl(r.realizedPnl)
      const fillCell =
        r.filledPrice === null || r.filledPrice === undefined
          ? '-'
          : `${fmtNumber(r.filledPrice, 2)} × ${r.filledQty ?? '?'}`
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td><a href="/dashboard/cron?symbol=${encodeURIComponent(r.symbol)}"><strong>${esc(r.symbol)}</strong></a></td>
        <td class="${cls}">${esc(r.decision)}</td>
        <td>${cronReasonCell(r)}</td>
        <td>${r.price === null ? '-' : fmtNumber(r.price, 2)}</td>
        <td class="muted">${esc(fillCell)}</td>
        <td>${realizedCell}</td>
      </tr>`
    })
    .join('')
  return `${header}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>symbol</th><th>decision</th><th>reason (評価時の含み損益など)</th><th>price</th><th>実 fill (価格 × 数量)</th><th>実 損益</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function cronReasonCell(row: {
  id: number
  timestamp: string
  requestId: string | null
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson?: string | null
  clientOrderId?: string | null
  filledPrice?: number | null
  filledQty?: number | null
  realizedPnl?: number | null
  brokerStatus?: string | null
}): string {
  const localized = localizeReason(row.reason)
  const rawReason = row.reason ?? '-'
  const decisionJson = JSON.stringify(cronDecisionJson(row), null, 2)
  const humanDetails = describeCronReason(row.reason)

  return `<details class="reason-details">
    <summary>${esc(localized || '-')}</summary>
    <div class="reason-panel">
      <div><strong>読み方</strong>${humanDetails}</div>
      <div><strong>RUNID</strong><br><code>${esc(row.requestId ?? '-')}</code></div>
      <div><strong>raw reason</strong><br><code>${esc(rawReason)}</code></div>
      <div><strong>decision id / clientOrderId</strong><br><code>${row.id}</code> / <code>${esc(row.clientOrderId ?? '-')}</code></div>
      <div><strong>JSON</strong><br><pre>${esc(decisionJson)}</pre></div>
    </div>
  </details>`
}

function cronDecisionJson(row: {
  id: number
  timestamp: string
  symbol: string
  decision: string
  reason: string | null
  price: number | null
  indicatorsJson?: string | null
  clientOrderId?: string | null
  filledPrice?: number | null
  filledQty?: number | null
  realizedPnl?: number | null
  brokerStatus?: string | null
}) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    symbol: row.symbol,
    decision: row.decision,
    reason: row.reason,
    localizedReason: localizeReason(row.reason),
    price: row.price,
    indicators: parseJsonObject(row.indicatorsJson),
    clientOrderId: row.clientOrderId,
    broker: {
      status: row.brokerStatus,
      filledPrice: row.filledPrice,
      filledQty: row.filledQty,
      realizedPnl: row.realizedPnl,
    },
  }
}

function describeCronReason(reason: string | null | undefined): string {
  if (!reason) return '<p class="muted">詳細理由なし</p>'

  const lotSizeRound = reason.match(
    /^sizing rejected: lot-size-round \(raw qty (\S+) < lot (\S+), stop (\S+), entry (\S+)\)$/,
  )
  if (lotSizeRound) {
    const [, rawQty, lot, stop, entry] = lotSizeRound
    return `<ul>
      <li>計算上は ${esc(rawQty)} 株まで建てられるが、必要な売買単位 ${esc(lot)} 株に届かないため発注しません。</li>
      <li>評価時の株価は ${esc(entry)}、損切り幅は ${esc(stop)} / 株です。</li>
      <li>このままだと単元未満なので、リスク予算・銘柄上限・売買単位のいずれかが変わらない限り発注されません。</li>
    </ul>`
  }

  return `<p>${esc(localizeReason(reason))}</p>`
}

/**
 * realized_pnl ($ / ¥ raw 値) を符号付き小数 2 桁で。loss は赤、profit は緑。
 */
function formatRealizedPnl(value: number): string {
  const sign = value > 0 ? '+' : ''
  const cls = value > 0 ? 'ok' : value < 0 ? 'err' : 'muted'
  return `<span class="${cls}">${sign}${value.toFixed(2)}</span>`
}

/**
 * 戦略妥当性チャート (#158)。
 *
 * 設計方針:
 * - ECharts CDN load (jsdelivr)、build step 導入しない (POC scope 維持)
 * - データは `<script>` で window.__chartData に埋込、`</script>` を escape
 * - CDN 失敗時は chart 部分のみ unavailable 表示で fail-graceful
 *
 * Phase 0+1 では equity curve + drawdown のみ。Phase 2-4 で追加予定。
 */

const ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js'

interface EquityPoint {
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

/**
 * Decision breakdown chart 用の日次集計 (#158 Phase 2)。
 *
 * strategy_decision_log を JST 日次でグルーピングし、各 decision
 * (BUY/SELL/HOLD/REJECT/ERROR) のカウントを返す。トレーダーは
 * 「BUY/SELL が出すぎ・出なさすぎ」「REJECT が偏ってないか」を一目で
 * 見たいので、1 日 1 行 × 5 系列の stacked bar 用のデータ形にする。
 *
 * 直近 90 日のみ (それ以上はチャートが詰まって読めない)。
 */
const DECISION_KEYS = ['BUY', 'SELL', 'HOLD', 'REJECT', 'ERROR'] as const
type DecisionKey = (typeof DECISION_KEYS)[number]

export interface DecisionBreakdownPoint {
  date: string
  counts: Record<DecisionKey, number>
}

export async function loadDecisionBreakdown(db: D1Database): Promise<DecisionBreakdownPoint[]> {
  const result = await db
    .prepare(
      `SELECT date(timestamp, '+9 hours') AS day,
              decision,
              COUNT(*) AS n
       FROM strategy_decision_log
       WHERE timestamp >= date('now', '-90 days')
       GROUP BY day, decision
       ORDER BY day ASC`,
    )
    .all<{ day: string; decision: string; n: number }>()
  return aggregateDecisionRows(result.results ?? [])
}

export function aggregateDecisionRows(
  rows: Array<{ day: string; decision: string; n: number }>,
): DecisionBreakdownPoint[] {
  const map = new Map<string, Record<DecisionKey, number>>()
  for (const r of rows) {
    let bucket = map.get(r.day)
    if (!bucket) {
      bucket = { BUY: 0, SELL: 0, HOLD: 0, REJECT: 0, ERROR: 0 }
      map.set(r.day, bucket)
    }
    // 想定外 decision (将来追加など) は ERROR バケットに寄せて見落とし防止
    const key: DecisionKey = (DECISION_KEYS as readonly string[]).includes(r.decision)
      ? (r.decision as DecisionKey)
      : 'ERROR'
    bucket[key] += Number(r.n)
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, counts]) => ({ date, counts }))
}

/**
 * Per-trade realized PnL を全件取得 (#158 Phase 3)。
 *
 * trade_journal.realized_pnl は SELL fill に確定損益が記録される (BUY は null)。
 * 戦略のエッジが本物か偽物かを見るために、勝率・profit factor・expectancy を
 * 計算 + 分布を histogram で可視化する。
 */
export async function loadTradePnls(db: D1Database): Promise<number[]> {
  const result = await db
    .prepare(
      `SELECT realized_pnl AS pnl
       FROM trade_journal
       WHERE realized_pnl IS NOT NULL
         AND trade_event_type = 'post_submit'
       ORDER BY id ASC`,
    )
    .all<{ pnl: number }>()
  return (result.results ?? []).map((r) => Number(r.pnl)).filter((n) => Number.isFinite(n))
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
  /** 1 trade あたり期待損益 = winRate * avgWin + (1-winRate) * avgLoss */
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
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss
  return { count: pnls.length, wins, losses, winRate, avgWin, avgLoss, profitFactor, expectancy, total }
}

export interface PnlHistogramBin {
  label: string // "(-5, -3]" など
  binStart: number
  binEnd: number
  binCenter: number
  count: number
}

/**
 * pnl 値を最大 12 ビンの histogram に。範囲は対称 (max(|min|, max)) で
 * 0 を境に正/負で色分け可能にする。サンプルが少なすぎるとビン数を減らす。
 */
export function computePnlHistogram(pnls: number[], maxBins = 12): PnlHistogramBin[] {
  if (pnls.length === 0) return []
  const absMax = Math.max(...pnls.map(Math.abs))
  if (absMax === 0) {
    return [{ label: '0', binStart: 0, binEnd: 0, binCenter: 0, count: pnls.length }]
  }
  const bins = Math.min(maxBins, Math.max(3, Math.ceil(Math.sqrt(pnls.length))))
  const range = absMax * 2
  const width = range / bins
  const out: PnlHistogramBin[] = []
  for (let i = 0; i < bins; i += 1) {
    const start = -absMax + width * i
    const end = start + width
    out.push({
      label: `(${start.toFixed(1)}, ${end.toFixed(1)}]`,
      binStart: start,
      binEnd: end,
      binCenter: (start + end) / 2,
      count: 0,
    })
  }
  for (const p of pnls) {
    // 末尾の bin は閉区間 [end, end] を含むよう特別処理
    let idx = Math.floor((p - -absMax) / width)
    if (idx >= bins) idx = bins - 1
    if (idx < 0) idx = 0
    out[idx]!.count += 1
  }
  return out
}

function renderTradeStatsTable(s: TradeStats): string {
  if (s.count === 0) return ''
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—')
  const pct = (n: number) => (Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—')
  const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'
  const expClass = s.expectancy > 0 ? 'ok' : s.expectancy < 0 ? 'err' : 'muted'
  return `<table style="margin-top:12px">
    <thead><tr><th>件数</th><th>勝</th><th>負</th><th>勝率</th><th>平均利益</th><th>平均損失</th><th>profit factor</th><th>expectancy / trade</th><th>合計</th></tr></thead>
    <tbody><tr>
      <td>${s.count}</td>
      <td class="ok">${s.wins}</td>
      <td class="err">${s.losses}</td>
      <td>${pct(s.winRate)}</td>
      <td class="ok">${fmt(s.avgWin)}</td>
      <td class="err">${fmt(s.avgLoss)}</td>
      <td>${pf}</td>
      <td class="${expClass}">${fmt(s.expectancy)}</td>
      <td class="${s.total > 0 ? 'ok' : s.total < 0 ? 'err' : 'muted'}">${fmt(s.total)}</td>
    </tr></tbody>
  </table>`
}

/**
 * 銘柄チャートで focus する銘柄を決める (#158 Phase 4)。
 * クエリ ?symbol=X が universe にあればそれ、無ければ「直近で BUY/SELL
 * fill のあった銘柄」、それも無ければ universe の先頭。
 *
 * 「実際に売買したことがある銘柄」を優先する理由: トレーダーが
 * 「rule の解釈が現実と合ってるか」を最初に見たいのは、エントリーが
 * あった銘柄だから。
 */
export async function pickDefaultSymbol(db: D1Database): Promise<string | null> {
  const result = await db
    .prepare(
      `SELECT symbol FROM trade_journal
       WHERE trade_event_type = 'post_submit' AND filled_qty IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .all<{ symbol: string }>()
  return result.results?.[0]?.symbol ?? null
}

export interface SymbolChartPoint {
  timestamp: string // ISO UTC (time axis 用、client 側 Intl で JST 表示)
  price: number
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

export interface SymbolChartMarker {
  timestamp: string
  side: 'BUY' | 'SELL'
  price: number
  qty: number | null
  realizedPnl: number | null
}

export interface SymbolChartPosition {
  /** 平均取得単価 (= 直近 BUY filled_price、partial fill / add は未対応 POC) */
  avgPrice: number
  /** entry timestamp (JST 表示用文字列) */
  openedAt: string
}

export interface SymbolChartRules {
  /** -0.03 = -3% (押し目浅すぎ閾値) */
  pullbackMax: number
  /** -0.15 = -15% (押し目深すぎ閾値) */
  pullbackMin: number
  /** -0.04 = -4% (損切ライン) */
  stopPct: number
  /** 0.07 = +7% (利食ライン) */
  takeProfitPct: number
  /** 営業日。chart の SQL window 計算に使う (chart logic では非使用) */
  timeStopDays: number
}

/**
 * Chart window の上限日数。schema の MAX_TIME_STOP_DAYS (365) から計算。
 * timeStopDays が大きくても肥大化を防ぐ。
 * MAX_TIME_STOP_DAYS=365 → 2*365+4 = 734 カレンダー日。
 */
const MAX_WINDOW_DAYS = Math.ceil(MAX_TIME_STOP_DAYS * 2 + 4)

/**
 * Chart SQL の window 日数を timeStopDays から動的に決める。
 * 営業日 N → カレンダー N×7/5 + 祝日バッファ + 安全マージン ≈ 2N+4。
 * timeStopDays=10 → 24 日。年末年始 / 大型連休跨ぎでも entry 取りこぼさない。
 * floor=14, ceiling=MAX_WINDOW_DAYS で clamp してカレンダー window の肥大化を防ぐ。
 */
export function computeChartWindowDays(timeStopDays: number): number {
  const dynamic = Math.ceil(timeStopDays * 2 + 4)
  return Math.min(Math.max(dynamic, 14), MAX_WINDOW_DAYS)
}

export interface PivotPoint {
  /** ISO UTC timestamp of the daily bar */
  timestamp: string
  price: number
  type: 'high' | 'low'
}

/**
 * 直線セグメント。
 *
 * 旧仕様 (pivot ベース) では `pivots` は「採用した 2 swing pivot」だったが、
 * 現仕様 (linear regression) では `pivots[0]` = 線の左端、`pivots[1]` = 同じ
 * slope 上の参照点 (densify では未使用) を入れる。`end` は線の右端 (= chart
 * 最新 timestamp 上の外挿点)。`densifyTrendLine` は `pivots[0]` と `end` の
 * 2 点だけを使うため、両用途で同じ型が再利用できる。
 */
export interface TrendLineSegment {
  pivots: [PivotPoint, PivotPoint]
  end: { timestamp: string; price: number }
}

/** 15 分足 OHLC (Yahoo intraday bars 由来)、candlestick 描画用 */
export interface OhlcBar {
  /** ISO UTC (Yahoo intraday は秒精度の bar 開始時刻) */
  timestamp: string
  open: number
  high: number
  low: number
  close: number
}

export interface SymbolChartData {
  symbol: string
  points: SymbolChartPoint[]
  markers: SymbolChartMarker[]
  /** 現保有 (BUY → SELL がまだない) ならその情報、なければ null */
  position: SymbolChartPosition | null
  rules: SymbolChartRules
  /**
   * 直近 30 日 daily close の最小二乗 (linear regression) で fit した
   * 「価格の中心トレンド線」。データ点が 2 未満なら null。
   *
   * 旧仕様 (resistanceLine / supportLine の上下 2 本) は、ローソク足の上下を
   * flat に走る形で「価格の中心を辿る」という user の期待と乖離していた。
   * regression で価格中央を best-fit する形に変更。
   */
  trendLine: TrendLineSegment | null
  /** Yahoo 日次 OHLC、candlestick 描画用 (空配列 = Yahoo fetch 失敗) */
  intradayBars: OhlcBar[]
}

/**
 * 直近 200 件の strategy_decision_log と全 fill markers + 現保有 + ルール閾値を返す。
 * - sma50 / high20d は indicators_json から抜く (JSON.parse 失敗は null fallback)
 * - timestamp は DB 上の UTC ISO をそのまま保持し、ECharts time axis に渡す。
 *   JST 表示は client 側 Intl.DateTimeFormat (Asia/Tokyo) でやる
 * - position は SymbolStateDO の値を最優先 (partial fill / position add 対応)、
 *   binding 無し or 失敗時は trade_journal からの derive にフォールバック
 */
export async function loadSymbolChart(
  env: Env,
  symbol: string,
  rules: SymbolChartRules,
): Promise<SymbolChartData> {
  const db = env.DB
  if (!db) throw new Error('DB binding not available')
  const windowDays = computeChartWindowDays(rules.timeStopDays)
  const [logsResult, fillsResult, doPosition] = await Promise.all([
    db
      // 動的 window: timeStopDays から computeChartWindowDays(N) で計算
      // (default 10 営業日 → 24 カレンダー日)。祝日 / 連休跨ぎでも entry を
      // 取りこぼさない。strftime で右辺を ISO UTC 形式 ("...T...:...Z") に
      // 揃える (default datetime() の空白区切りでは stored ISO と境界がぶれる)。
      .prepare(
        `SELECT timestamp, price, indicators_json
         FROM strategy_decision_log
         WHERE symbol = ?
           AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
         ORDER BY id ASC`,
      )
      .bind(symbol, `-${windowDays} days`)
      .all<{ timestamp: string; price: number | null; indicators_json: string | null }>(),
    db
      // post_submit 行は side が null (writer は pre_submit にしか side を入れない)。
      // client_order_id で pre_submit と self-JOIN して side を引く。古い fill で
      // pre_submit が無い場合は realized_pnl の有無から推測 (null=BUY, 非 null=SELL)。
      .prepare(
        `SELECT
           ps.timestamp AS timestamp,
           pre.side AS pre_side,
           ps.filled_price AS filled_price,
           ps.filled_qty AS filled_qty,
           ps.realized_pnl AS realized_pnl
         FROM trade_journal AS ps
         LEFT JOIN trade_journal AS pre
           ON pre.client_order_id = ps.client_order_id
           AND pre.trade_event_type = 'pre_submit'
         WHERE ps.symbol = ?
           AND ps.trade_event_type = 'post_submit'
           AND ps.filled_price IS NOT NULL
         ORDER BY ps.id ASC`,
      )
      .bind(symbol)
      .all<{
        timestamp: string
        pre_side: string | null
        filled_price: number | null
        filled_qty: number | null
        realized_pnl: number | null
      }>(),
    fetchDoPosition(env, symbol),
  ])
  const logs = logsResult.results ?? [] // SQL は既に ASC で返している
  const points: SymbolChartPoint[] = logs
    .filter((r) => r.price !== null && Number.isFinite(Number(r.price)))
    .map((r) => {
      const indicators = parseIndicators(r.indicators_json)
      return {
        timestamp: r.timestamp,
        price: Number(r.price),
        sma50: indicators.sma50,
        high20d: indicators.high20d,
        low20d: indicators.low20d,
      }
    })
  const markers: SymbolChartMarker[] = (fillsResult.results ?? [])
    .filter((r) => r.filled_price !== null)
    .map((r) => ({
      timestamp: r.timestamp,
      side: resolveFillSide(r.pre_side, r.realized_pnl),
      price: Number(r.filled_price),
      qty: r.filled_qty === null ? null : Number(r.filled_qty),
      realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
    }))
  // DO query の結果が undefined = binding 無し or fetch 失敗 → derive にフォールバック
  const position = doPosition !== undefined ? doPosition : deriveOpenPosition(markers)

  // Yahoo daily bars 60 日: chart 全体の price line + pivot 検出に使う。
  // Yahoo fetch 失敗時は cron-eval points のみで描画 (短い price line になるが
  // 致命的ではない)。lastTimestamp が無い (chart 自体空) なら filtering 不要。
  const yahooBarsRaw = await fetchYahooBarsForChart(symbol, 60)
  const cronLastTs = points.length > 0 ? points[points.length - 1]!.timestamp : null
  const yahooBars =
    cronLastTs == null ? yahooBarsRaw : yahooBarsRaw.filter((b) => b.timestamp <= cronLastTs)

  // Yahoo bar を points にマージして全期間 price line を実現。同 timestamp で
  // 既に cron-eval point があればそちらを優先 (indicators が乗っているため)。
  // Yahoo bar 由来の point は indicators フィールド全 null。
  const mergedPoints = mergeYahooAndCronPoints(yahooBars, points)
  const lastTimestamp =
    mergedPoints.length > 0 ? mergedPoints[mergedPoints.length - 1]!.timestamp : null

  // 価格トレンド: 直近 30 暦日 (regime shift を跨がない短期) の daily close
  // を最小二乗で fit した linear regression line。pivot ベース (上値抵抗 /
  // 下値支持) は candle の「上下を flat に走る bound 線」になりやすく、user
  // 期待である「ローソク足の中心を辿る trend」を表現できなかったため、close
  // の重心を通る best-fit 1 本に置き換えた (#190 系の見直し)。
  //
  // データ source: Yahoo daily が ≥5 本あればそれ、不足なら cron-eval 由来の
  // 日次 close fallback。30 日に満たないデータでも残っている分すべて使う
  // (< 2 なら null 返却 → 描画スキップ)。
  const TREND_WINDOW_DAYS = 30
  const trendCutoffMs = lastTimestamp
    ? new Date(lastTimestamp).getTime() - TREND_WINDOW_DAYS * 24 * 3600 * 1000
    : 0
  const trendDailySource: Array<{ jstDate: string; close: number; timestamp: string }> = (() => {
    if (!lastTimestamp) return []
    const fromYahoo = yahooBars.filter((b) => new Date(b.timestamp).getTime() >= trendCutoffMs)
    if (fromYahoo.length >= 5) return fromYahoo
    return aggregateDailyCloses(points).filter(
      (p) => new Date(p.timestamp).getTime() >= trendCutoffMs,
    )
  })()
  const trendLine = lastTimestamp
    ? computeLinearRegressionLine(
        trendDailySource.map((d) => ({ timestamp: d.timestamp, close: d.close })),
        lastTimestamp,
      )
    : null
  // candlestick: 1 時間足 (intraday) を Yahoo から fetch。15m は overnight gap
  // 後の clustering と barWidth 調整がシビアだったため、daily-trader 向けに
  // 1h を default 採用 (Pullback Uptrend のような multi-day 戦略では十分な
  // granularity)。Yahoo intraday range 制限 60d で chart 全期間カバー可能。
  // 失敗 (network 等) なら空配列で fallback (candle 自体スキップ)。
  let intradayBars: OhlcBar[] = []
  try {
    const intraday = await new YahooBarClient().getIntradayBars(symbol, '60m')
    // lastTimestamp フィルタ: chart x 軸範囲を超える bar (将来に出るはずの bar)
    // を除外。lastTimestamp が無いときは全件採用。
    intradayBars = (cronLastTs == null
      ? intraday
      : intraday.filter((b) => b.timestamp <= cronLastTs)
    ).map((b) => ({
      timestamp: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }))
  } catch (err) {
    if (err instanceof RangeError) throw err
    // network / parse error → 空 fallback
  }
  return {
    symbol,
    points: mergedPoints,
    markers,
    position,
    rules,
    trendLine,
    intradayBars: intradayBars,
  }
}

/**
 * 銘柄グリッドビュー用: ALLOWED_SYMBOLS 全銘柄の SymbolChartData を並列取得。
 *
 * 個別 symbol の `loadSymbolChart` 失敗 (Yahoo fetch error / D1 一時的エラー /
 * DO unbound 等) は per-symbol で catch して `{ chart: null, error }` に落とす。
 * 1 銘柄の失敗で grid 全画面が 500 にならないよう、grid view では panel 単位で
 * 「データ取得失敗」を可視化する fallback に倒す (POC 段階で trader が生産に
 * 戻れない事故を避ける)。
 *
 * 注意: Cloudflare Workers の subrequest 制限 (50 / request) を考慮。
 * `loadSymbolChart` は 銘柄あたり ~5 subrequest (Yahoo daily + intraday + D1
 * query + DO query) なので 9 銘柄で ~45 subrequest。ALLOWED_SYMBOLS が増えた
 * 場合は paging or 段階表示が必要だが、POC 規模では十分に余裕がある前提。
 *
 * 並列度は `Promise.all` でフル並列。Workers の I/O concurrency 上限に当たる
 * ようなら `p-limit` 等で絞ることになるが、現状 9 並列なら問題ない。
 */
export async function loadAllSymbolCharts(
  env: Env,
  symbols: string[],
  rules: SymbolChartRules,
): Promise<Array<{ symbol: string; chart: SymbolChartData | null; error: string | null }>> {
  if (symbols.length === 0) return []
  return await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const chart = await loadSymbolChart(env, symbol, rules)
        return { symbol, chart, error: null as string | null }
      } catch (err) {
        // 個別失敗は audit log のため console.warn (Workers logs に流れる)。
        // panel 側は error 文字列を表示して trader に「この 1 銘柄だけ取得失敗」
        // を分からせる。
        // eslint-disable-next-line no-console
        console.warn('[dashboard] loadAllSymbolCharts symbol failed', { symbol, err: messageOf(err) })
        return { symbol, chart: null, error: messageOf(err) }
      }
    }),
  )
}

/**
 * Yahoo daily bars と cron-eval points をマージ。同 JST 日では cron-eval を
 * 優先 (indicators が乗っているため)、それ以外の日は Yahoo bar を price-only
 * の point として追加。timestamp 昇順で返す。
 */
export function mergeYahooAndCronPoints(
  yahooBars: Array<{ jstDate: string; close: number; sma50?: number | null; timestamp: string }>,
  cronPoints: SymbolChartPoint[],
): SymbolChartPoint[] {
  // 不正 timestamp の cron point は最初に除外。残すと ECharts time 軸 / chart
  // 末尾判定 (lastTimestamp = mergedPoints[-1]) が壊れる。
  const validCronPoints = cronPoints.filter((p) =>
    Number.isFinite(new Date(p.timestamp).getTime()),
  )
  // cron eval は同 JST 日の sma50 が null になりうる (古い row)。Yahoo 側で
  // 算出した sma50 を JST 日キーで参照できるよう Map にしておく。同 JST 日
  // 内の cron eval が複数あっても全部に同じ Yahoo SMA50 が振られる。
  const yahooSmaByJstDate = new Map<string, number | null>(
    yahooBars.map((b) => [b.jstDate, b.sma50 ?? null]),
  )
  const cronJstDates = new Set(
    validCronPoints.map((p) =>
      new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    ),
  )
  // Yahoo bar の SMA50 を cron point にも反映 (cron 側 indicators_json の sma50
  // が null の古い row でも線が途切れない)。cron 側が既に sma50 を持っていれば
  // それを優先 (より最新かつ rules と整合する)。
  const enrichedCronPoints: SymbolChartPoint[] = validCronPoints.map((p) => {
    if (p.sma50 != null) return p
    const jstDate = new Date(new Date(p.timestamp).getTime() + 9 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
    const fallback = yahooSmaByJstDate.get(jstDate) ?? null
    return fallback == null ? p : { ...p, sma50: fallback }
  })
  const yahooFiller: SymbolChartPoint[] = yahooBars
    .filter((b) => !cronJstDates.has(b.jstDate))
    .map((b) => ({
      timestamp: b.timestamp,
      price: b.close,
      sma50: b.sma50 ?? null,
      high20d: null,
      low20d: null,
    }))
  return [...yahooFiller, ...enrichedCronPoints].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  )
}

/**
 * Yahoo daily bars を chart 用に fetch (lookback 営業日)。timestamp は date
 * 部分 + 16:00 UTC (≈ 1:00 JST 翌日 ≈ "evening of date") で擬似生成、
 * trend line の傾き計算には相対精度として十分。
 *
 * エラー方針: caller contract 違反 (RangeError = lookback 不正) は呼出元の
 * 実装バグなので throw 再送出する。それ以外 (network / parse / 一時的
 * fetch 失敗) のみ空配列で fallback を呼出元に伝える。
 */
export async function fetchYahooBarsForChart(
  symbol: string,
  lookback: number,
): Promise<Array<{ jstDate: string; open: number; high: number; low: number; close: number; sma50: number | null; timestamp: string }>> {
  // warmup を足してから getDailyBars に渡す方式だと lookback=0 / 小さな負値で
  // も内側の lookback (lookback+warmup) が正の整数になり validation を素通り
  // してしまう (slice(-0)=slice(0) で warmup 区間が全部返る等)。caller contract
  // を維持するためここで先に弾く。整数性は getDailyBars 側の `Number.isInteger`
  // と整合させる。
  if (!Number.isInteger(lookback) || lookback <= 0) {
    throw new RangeError(
      `fetchYahooBarsForChart: lookback must be a positive integer, got ${lookback}`,
    )
  }
  const client = new YahooBarClient()
  try {
    // SMA50 を「先頭の chart 表示日」から埋めたいので、表示 lookback に加えて
    // SMA50 warmup の 50 日を上乗せして fetch する。表示時に lookback 件分を
    // 末尾から切り出す。
    const warmup = 50
    const bars = await client.getDailyBars(symbol, lookback + warmup)
    const closes = bars.map((b) => b.close)
    const smaSeries = computeRollingSma(closes, 50)
    const enriched = bars.map((b, i) => ({
      jstDate: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      sma50: smaSeries[i] ?? null,
      // JST 00:00 anchor: ECharts time axis (UTC) で JST formatter にかけると
      // b.date と同じ JST カレンダー日に column が配置される。
      // 旧実装 `${b.date}T16:00Z` だと JST 翌 01:00 に shift し、
      // 例えば US bar "04/25" が JST 04/26 列に表示される回帰があった。
      timestamp: anchorJstMidnight(b.date),
    }))
    // 表示は lookback 件分のみ (warmup 区間は SMA50 算出に使い切ったので破棄)。
    // bars が要求件数より少ない (上場初日近辺など) ケースもそのまま素通し。
    return enriched.length > lookback ? enriched.slice(-lookback) : enriched
  } catch (err) {
    // RangeError は呼出元コード側の lookback 不正 (実装ミス)。silent fallback で
    // 隠さず再送出して dashboard handler の try/catch まで伝える。
    if (err instanceof RangeError) throw err
    return []
  }
}

/**
 * `values[i]` を window 期間の単純移動平均に変換。i < window-1 は null。
 * SMA50 に流用するが任意 window で使える素朴実装。NaN/Infinity が混じった
 * 場合 sum が壊れるので入力側で予め弾く前提。
 */
export function computeRollingSma(values: number[], window: number): Array<number | null> {
  if (window <= 0) return values.map(() => null)
  const out: Array<number | null> = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!
    if (i >= window) sum -= values[i - window]!
    if (i >= window - 1) out[i] = sum / window
  }
  return out
}

/**
 * "YYYY-MM-DD" を「その日の JST 00:00 = UTC -9h 前日 15:00」の ISO Z 文字列に。
 * 例: "2026-04-25" → "2026-04-24T15:00:00.000Z" (JST 04/25 00:00)。
 * Yahoo bar / 他のロジックとの timestamp 比較を Z 形式で揃えるため。
 */
export function anchorJstMidnight(date: string): string {
  return new Date(`${date}T00:00:00+09:00`).toISOString()
}

/**
 * cron-eval price (Yahoo daily close を 15 分毎に複製したもの) を JST 日次で
 * dedupe して、その日の最終 cron eval を「日次 close」として採用。
 * trend line / pivot 検出は日足ベースで行うのが標準。
 */
export function aggregateDailyCloses(
  points: SymbolChartPoint[],
): Array<{ jstDate: string; close: number; timestamp: string }> {
  const byDay = new Map<string, { jstDate: string; close: number; timestamp: string }>()
  for (const p of points) {
    if (p.price == null || !Number.isFinite(p.price)) continue
    const ms = new Date(p.timestamp).getTime()
    if (!Number.isFinite(ms)) continue
    // JST date = UTC + 9h、ISO の前 10 文字
    const jstDate = new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10)
    // last write wins → その日の最終 cron eval
    byDay.set(jstDate, { jstDate, close: p.price, timestamp: p.timestamp })
  }
  return [...byDay.values()].sort((a, b) => (a.jstDate < b.jstDate ? -1 : 1))
}

/**
 * Daily close の最小二乗 (ordinary least squares) で価格中央を best-fit する
 * linear regression line を返す。「ローソク足の中心を辿るトレンド」を出すた
 * めの実装で、pivot ベースの上下 bound 線とは目的が違う。
 *
 * 戻り値の形は既存 `TrendLineSegment` を再利用 (densifyTrendLine が `pivots[0]`
 * と `end` の 2 点を読むだけ):
 * - `pivots[0]`: regression line 上の最古 sample timestamp 上の点 (= 線の左端)
 * - `pivots[1]`: 同じ slope を持つ参照点として `end` と同じ点を入れている
 *               (densify では未使用、互換のため形を保つ)
 * - `end`: `endTimestamp` (通常は chart の最新 timestamp) 上の外挿点
 *
 * 入力は `{ timestamp, close }` の配列 (順序不問、内部で時系列に並べる)。
 * 以下のケースで null:
 * - 有効な data point (Number.isFinite な timestamp / close) が 2 未満
 * - 全 sample が同 timestamp (slope 不定)
 * - `endTimestamp` が解釈不能
 * - 計算結果が NaN / Infinity
 *
 * regime filter は意図的に持たない: regression は close 全体の重心を取るので
 * 「別 regime の pivot」概念がそもそも存在しない。窓を 30 日程度に絞ること
 * が regime 跨ぎ対策を兼ねる。
 */
export function computeLinearRegressionLine(
  samples: ReadonlyArray<{ timestamp: string; close: number }>,
  endTimestamp: string,
): TrendLineSegment | null {
  // 有効値のみ抽出 (NaN / Infinity / 不正 timestamp は除外)
  const points: Array<{ t: number; y: number; timestamp: string }> = []
  for (const s of samples) {
    const t = new Date(s.timestamp).getTime()
    const y = s.close
    if (!Number.isFinite(t)) continue
    if (typeof y !== 'number' || !Number.isFinite(y)) continue
    points.push({ t, y, timestamp: s.timestamp })
  }
  if (points.length < 2) return null
  // 時系列で安定 sort (同 t は input 順を維持)
  points.sort((a, b) => a.t - b.t)
  // 全 sample が同 timestamp なら slope 不定
  if (points[0]!.t === points[points.length - 1]!.t) return null

  const tEnd = new Date(endTimestamp).getTime()
  if (!Number.isFinite(tEnd)) return null

  // OLS: y = a*t + b。t を「最古 sample 基準のオフセット」に正規化して
  // epoch ms (~1.7e12) 由来の桁あふれを抑える (slope は同じ)。
  const t0 = points[0]!.t
  let sumT = 0
  let sumY = 0
  for (const p of points) {
    sumT += p.t - t0
    sumY += p.y
  }
  const n = points.length
  const meanT = sumT / n
  const meanY = sumY / n
  let num = 0
  let den = 0
  for (const p of points) {
    const dt = p.t - t0 - meanT
    num += dt * (p.y - meanY)
    den += dt * dt
  }
  if (den === 0) return null
  const slope = num / den
  const intercept = meanY - slope * meanT
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null

  // 線の左端 = 最古 sample timestamp 上の regression y
  const startT = points[0]!.t
  const startY = intercept + slope * (startT - t0)
  // 右端 = endTimestamp 上の regression y (将来 / 既知点いずれでも線形外挿)
  const endY = intercept + slope * (tEnd - t0)
  if (!Number.isFinite(startY) || !Number.isFinite(endY)) return null

  const startPoint: PivotPoint = {
    timestamp: points[0]!.timestamp,
    price: startY,
    // type は描画上未使用。互換のため 'low' を入れておく (意味はない)
    type: 'low',
  }
  const endPoint: PivotPoint = {
    timestamp: endTimestamp,
    price: endY,
    type: 'low',
  }
  return {
    pivots: [startPoint, endPoint],
    end: { timestamp: endTimestamp, price: endY },
  }
}

/**
 * Trend line を「描画用の密点列」に展開する。
 *
 * 背景: ECharts の dataZoom + 2 点 line series は「片方の点が zoom 範囲外
 * になると線が引かれない」既知挙動が widely 報告されている (issue #3637 系)。
 * #189 で `filterMode: 'weakFilter'` に変更したが、それでもユーザ環境で
 * trend line が描画されないケースが残った。
 *
 * 最も robust な解決策は line の data 自体を「常に zoom 範囲内に複数点が
 * 入る粒度」にすること。ここでは intradayBars (1h candle、60 日で ~720 点)
 * の各 timestamp で trend line の y 値を線形補間して、`[[t, y], ...]` の
 * dense path に展開する。これで 5D (~120 点) や 1D zoom でも常に複数点が
 * visible になり filterMode 不問で確実に描画される。
 *
 * 線形外挿: trend line は本来両側に伸びる概念線なので、p1 より過去側 / end
 * より未来側の sample timestamp も同じ slope で外挿する (chart の見た目で
 * 線が早期に「途切れる」のを避ける)。
 *
 * Fallback: sampleTimestamps が空 (Yahoo intraday fetch 失敗時 = 0 件) の
 * とき、または line の 2 点が degenerate (t1 == t2) のときは 2 点
 * endpoint をそのまま返す (旧挙動 = 描画は zoom 不安定だが少なくとも
 * 全期間表示では出る)。
 */
export function densifyTrendLine(
  line: TrendLineSegment | null,
  sampleTimestamps: ReadonlyArray<string | number>,
): Array<[number, number]> | null {
  if (!line) return null
  const t1 = new Date(line.pivots[0].timestamp).getTime()
  const t2 = new Date(line.end.timestamp).getTime()
  const y1 = line.pivots[0].price
  const y2 = line.end.price
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null
  // degenerate: 2 点が同 timestamp → 線の slope 不定。fallback で 2 点返し。
  if (t1 === t2) return [[t1, y1], [t2, y2]]
  const slope = (y2 - y1) / (t2 - t1)
  // sample timestamps を epoch ms に正規化、無効値は除外、unique + 昇順
  const tsSet = new Set<number>()
  for (const s of sampleTimestamps) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (Number.isFinite(t)) tsSet.add(t)
  }
  // line の 2 点も常に含めて「pivot / end ちょうどでの y」を保証
  tsSet.add(t1)
  tsSet.add(t2)
  const sorted = Array.from(tsSet).sort((a, b) => a - b)
  // sample 0 件 (intradayBars 空) のときは 2 点 fallback
  if (sorted.length < 2) return [[t1, y1], [t2, y2]]
  const out: Array<[number, number]> = []
  for (const t of sorted) {
    const y = y1 + slope * (t - t1)
    if (Number.isFinite(y)) out.push([t, y])
  }
  // out が空になることは tsSet に t1/t2 を入れているのでまず無いが、
  // 安全のため最終 fallback。
  if (out.length < 2) return [[t1, y1], [t2, y2]]
  return out
}

/**
 * 保有中の avg / stop / take-profit のような「水平線分」を「描画用の密点列」
 * に展開する (`densifyTrendLine` と同じ目的の slope=0 特殊化)。
 *
 * 背景: 旧実装では candlestick の `markLine` に [{coord:[fromTs,y]}, {coord:[toTs,y]}]
 * の 2 点だけを渡していたが、ECharts の dataZoom + markLine は trend line と
 * 同様に「片端が zoom 範囲外になると markLine 全体が描画されない」回帰が
 * 起きる (#190 / #191 の trend line と同根、issue #3637 系)。1D zoom in で
 * `openedAt` が範囲外になり avg / stop / TP が一斉に消えるユーザ報告に
 * 対応するため、本関数で fromTs〜toTs を intradayBars timestamps で密化した
 * `[[t, y], ...]` に展開し、独立 `type: 'line'` series として描画する。
 *
 * 仕様:
 * - 戻り値は ascending order の `[t, y]` 配列。`fromTs` と `toTs` は端点として
 *   常に含む (sample に存在しなくても)。`samples` のうち `[fromTs, toTs]`
 *   範囲内のものを併合してユニーク化 + 昇順 sort。
 * - 水平線なので y は常に `yValue` (一定)。
 * - `fromTs > toTs` の degenerate ケース (openedAt > 最新 timestamp、cron が
 *   未だ走っていない直後) は 2 点 fallback `[[fromTs, y], [toTs, y]]`。
 *   呼び元側で既に `endTs = max(latestTs, openedAt)` の clamp をかけている
 *   ため通常は通らないが防御。
 * - `yValue` / `fromTs` / `toTs` が NaN / Infinity / 不正 ISO string なら null
 *   (描画 skip)。
 * - `samples` の不正値 (NaN / non-ISO string) は除外。
 */
export function densifyHorizontalLine(
  yValue: number,
  fromTs: string | number,
  toTs: string | number,
  samples: ReadonlyArray<string | number>,
): Array<[number, number]> | null {
  if (!Number.isFinite(yValue)) return null
  const a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime()
  const b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  // degenerate: fromTs >= toTs。端点 2 点だけ返す (描画は実質 1 点と同等
  // だが series.data が空にならないようにする)。
  if (a >= b) return [[a, yValue], [b, yValue]]
  const tsSet = new Set<number>()
  // 端点を必ず含める
  tsSet.add(a)
  tsSet.add(b)
  for (const s of samples) {
    const t = typeof s === 'number' ? s : new Date(s).getTime()
    if (!Number.isFinite(t)) continue
    if (t < a || t > b) continue
    tsSet.add(t)
  }
  const sorted = Array.from(tsSet).sort((x, y) => x - y)
  return sorted.map((t) => [t, yValue] as [number, number])
}

/**
 * fill 行の BUY/SELL を決定する。
 * - 1st: pre_submit 行から JOIN で取得した side ('BUY'/'SELL') を採用
 * - 2nd: それも無い場合は realized_pnl の有無で推測
 *   - realized_pnl が null = entry trade (= BUY)
 *   - realized_pnl が非 null = exit trade (= SELL、reconcileFills が
 *     `(filled_price - prior avg) * filled_qty` で計算する)
 * - 3rd (defensive): どちらでも判断できなければ BUY (entry が圧倒的多数)
 */
export function resolveFillSide(
  preSide: string | null,
  realizedPnl: number | null,
): 'BUY' | 'SELL' {
  if (preSide === 'BUY' || preSide === 'SELL') return preSide
  if (realizedPnl !== null && Number.isFinite(realizedPnl)) return 'SELL'
  return 'BUY'
}

/**
 * SymbolStateDO から現保有を引く。binding 無し / 失敗時は undefined を返して
 * 呼び元に「derive にフォールバックすべき」と伝える (null は「DO 上明示的に無保有」)。
 */
async function fetchDoPosition(
  env: Env,
  symbol: string,
): Promise<SymbolChartPosition | null | undefined> {
  if (!env.SYMBOL_STATE) return undefined
  try {
    const state = await new SymbolStateClient(env.SYMBOL_STATE).getState(symbol)
    if (!state.position) return null
    return { avgPrice: state.position.avgPrice, openedAt: state.position.openedAt }
  } catch {
    return undefined
  }
}

/**
 * 直近 fills を時系列で巻き戻し、最後に「BUY → SELL」で閉じていなければ
 * 現保有とみなす。partial fill / position add は POC 未対応 (直近 BUY だけ採用)。
 */
export function deriveOpenPosition(markers: SymbolChartMarker[]): SymbolChartPosition | null {
  let latestBuy: SymbolChartMarker | null = null
  for (const m of markers) {
    if (m.side === 'BUY') latestBuy = m
    else if (m.side === 'SELL') latestBuy = null
  }
  return latestBuy ? { avgPrice: latestBuy.price, openedAt: latestBuy.timestamp } : null
}

export function extractSma50(indicatorsJson: string | null): number | null {
  return parseIndicators(indicatorsJson).sma50
}

interface ExtractedIndicators {
  sma50: number | null
  high20d: number | null
  low20d: number | null
}

/**
 * indicators_json から chart で使う数値を一括抽出。JSON.parse 失敗 / 数値外は null。
 * low20d は #158 follow-up で追加されたため、既存の indicators_json には未収録 →
 * 古い行は null fallback で grace 化。新しい cron 実行から徐々に出揃う。
 */
function parseIndicators(indicatorsJson: string | null): ExtractedIndicators {
  if (!indicatorsJson) return { sma50: null, high20d: null, low20d: null }
  try {
    const obj = JSON.parse(indicatorsJson) as {
      sma50?: unknown
      high20d?: unknown
      low20d?: unknown
    }
    return {
      sma50:
        typeof obj.sma50 === 'number' && Number.isFinite(obj.sma50) ? obj.sma50 : null,
      high20d:
        typeof obj.high20d === 'number' && Number.isFinite(obj.high20d) ? obj.high20d : null,
      low20d:
        typeof obj.low20d === 'number' && Number.isFinite(obj.low20d) ? obj.low20d : null,
    }
  } catch {
    return { sma50: null, high20d: null, low20d: null }
  }
}

/**
 * `<script>...</script>` 内に埋め込む JSON を XSS 安全にする。
 * ブラウザは `</script>` を「文字列の中でも」script 終端と解釈するので、
 * `<` を unicode escape して中和する。
 */
export function safeJsonScript(varName: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script>window.${varName} = ${json};</script>`
}

export type ChartsTab = 'overview' | 'quality' | 'symbol' | 'grid'

export function parseChartsTab(value: string | undefined): ChartsTab {
  if (value === 'quality' || value === 'symbol' || value === 'grid') return value
  return 'overview'
}

const CHART_TABS: Array<{ id: ChartsTab; label: string; hint: string }> = [
  { id: 'overview', label: '概要', hint: 'エクイティカーブ + ドローダウン (戦略を続けるか止めるかの判断)' },
  { id: 'quality', label: '取引品質', hint: 'PnL 分布 + 統計 + Decision breakdown (エッジ / rule の機能性)' },
  { id: 'symbol', label: '個別銘柄', hint: '価格 + SMA50 + entry/exit (rule と現実の整合)' },
  { id: 'grid', label: '銘柄グリッド', hint: 'ALLOWED_SYMBOLS を 4 列 grid で並列表示。dataZoom は全 panel 同期 (Datadog 風)' },
]

interface ChartsBodyOverview {
  tab: 'overview'
  equity: EquityPoint[]
}

interface ChartsBodyQuality {
  tab: 'quality'
  decisions: DecisionBreakdownPoint[]
  pnls: number[]
  stats: TradeStats
  histogram: PnlHistogramBin[]
}

/**
 * 戦略パラメータの現在値スナップショット (PullbackUptrendStrategy)。
 * チャート併置パネルで「今どのルールで動いているか」を見せるための
 * read-only view (#168)。default 値からの変更はパネル側で ⚠ flag。
 */
export interface StrategyParamsSnapshot {
  stopPct: number
  takeProfitPct: number
  timeStopDays: number
  pullbackMax: number
  pullbackMin: number
  minReturn50d: number
  requireAboveSma50: boolean
  kAtr: number
}

/**
 * ISO UTC timestamp (例: "2026-04-15T00:00:00Z") をパースして Date を返す。
 * timezone marker (末尾 Z または ±HH:MM offset) が無い datetime 文字列は
 * `new Date` だと local time 扱いになり (JST runner で意図しないシフト)、
 * JSDoc の "UTC timestamp" 約束に違反する。`T` を含むのに tz が無ければ
 * `Z` を補って UTC と解釈させる。date-only ("2026-04-15") は ECMAScript
 * 仕様で既に UTC 解釈なので変更不要。
 */
export function parseIsoTimestamp(raw: string | undefined): Date | null {
  if (!raw || raw.trim() === '') return null
  let s = raw.trim()
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)
  if (s.includes('T') && !hasTz) {
    s = `${s}Z`
  }
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return null
  return d
}

/** chart の zoom 初期 window 既定: 直近 7 日 (UI で zoom 操作可能) */
export const DEFAULT_ZOOM_WINDOW_MS = 7 * 24 * 3600 * 1000

/**
 * chart x-axis の zoom 範囲を決める:
 * 1. URL params (zoomFrom / zoomTo) が valid (from < to) → それを採用
 * 2. URL に無い + chart に points がある → 直近 7 日 (lastTimestamp - 7d ～ lastTimestamp)
 * 3. それ以外 (chart 自体空) → null (= 全体表示 / no zoom)
 *
 * lastTimestamp 基準なので、休場日や POC 開始直後で `now()` 基準が data
 * 範囲外になるケースでも broken にならない。
 */
export function computeZoomRange(
  zoomFrom: Date | null,
  zoomTo: Date | null,
  chart: SymbolChartData | null,
): { from: Date; to: Date } | null {
  if (zoomFrom !== null && zoomTo !== null && zoomFrom < zoomTo) {
    return { from: zoomFrom, to: zoomTo }
  }
  if (!chart || chart.points.length === 0) return null
  const lastPoint = chart.points[chart.points.length - 1]!
  const lastMs = new Date(lastPoint.timestamp).getTime()
  if (!Number.isFinite(lastMs)) return null
  return {
    from: new Date(lastMs - DEFAULT_ZOOM_WINDOW_MS),
    to: new Date(lastMs),
  }
}

interface ChartsBodySymbol {
  tab: 'symbol'
  focusSymbol: string | null
  symbolChart: SymbolChartData | null
  availableSymbols: string[]
  strategyParams: StrategyParamsSnapshot
  /** dataZoom 初期範囲。null なら全期間 (full data) */
  zoom: { from: Date; to: Date } | null
}

/**
 * 銘柄グリッドビュー: ALLOWED_SYMBOLS を 4 列 (responsive) grid で並列表示。
 * 各 panel は個別 mini chart で、Datadog dashboard 風に dataZoom と tooltip が
 * `echarts.connect` 経由で全 panel 間で同期する。preset zoom (1D/5D/1M/All)
 * は grid 全体共通の toolbar から発火し、全 chart へ dispatchAction される。
 */
interface ChartsBodyGrid {
  tab: 'grid'
  /** 全銘柄の SymbolChartData (load 失敗銘柄は値 null。1 銘柄失敗で全 grid を 500 にしない) */
  charts: Array<{ symbol: string; chart: SymbolChartData | null; error: string | null }>
  /** dataZoom 初期範囲。null なら全期間 */
  zoom: { from: Date; to: Date } | null
}

type ChartsBodyArgs =
  | ChartsBodyOverview
  | ChartsBodyQuality
  | ChartsBodySymbol
  | ChartsBodyGrid

/**
 * Chart 上部に出す tab strip。現在 tab には active 装飾、他は通常リンク。
 */
function renderTabStrip(active: ChartsTab, focusSymbol?: string): string {
  const tabs = CHART_TABS.map((t) => {
    const style =
      t.id === active
        ? 'font-weight:600;text-decoration:underline;background:#fff;border-color:#06c;color:#06c'
        : ''
    const baseStyle = 'display:inline-block;padding:4px 12px;margin-right:6px;border:1px solid #d0d0d5;border-radius:6px;background:#fafafa;color:#1d1d1f;text-decoration:none;'

    if (t.id === active) {
      return `<span title="${esc(t.hint)}" style="${baseStyle}${style}">${esc(t.label)}</span>`
    }

    let href = `/dashboard/charts?tab=${t.id}`
    if (t.id === 'symbol' && focusSymbol) {
      href += `&symbol=${encodeURIComponent(focusSymbol)}`
    }

    return `<a href="${href}" title="${esc(t.hint)}" style="${baseStyle}${style}">${esc(t.label)}</a>`
  }).join('')
  return `<nav style="margin:0 0 12px 0">${tabs}</nav>`
}

function chartsBody(args: ChartsBodyArgs): string {
  const focusSymbol = args.tab === 'symbol' ? args.focusSymbol ?? undefined : undefined
  const tabStrip = renderTabStrip(args.tab, focusSymbol)
  if (args.tab === 'overview') return tabStrip + renderOverviewTab(args)
  if (args.tab === 'quality') return tabStrip + renderQualityTab(args)
  if (args.tab === 'grid') return tabStrip + renderGridTab(args)
  return tabStrip + renderSymbolTab(args)
}

function renderOverviewTab(args: ChartsBodyOverview): string {
  if (args.equity.length === 0) {
    return `<p class="muted">まだ実 fill (realized_pnl) が無いためエクイティカーブを描けません。最初の SELL が約定すると表示されます。</p>`
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var dates = data.equity.map(function (p) { return p.date; });
      var equity = data.equity.map(function (p) { return p.cumulativePnl; });
      var dd = data.equity.map(function (p) { return p.drawdownPct * 100; });
      var equityChart = echarts.init(document.getElementById('equity-chart'));
      equityChart.setOption({
        title: { text: '累積 realized PnL', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2); } },
        grid: { left: 50, right: 20, top: 40, bottom: 40 },
        xAxis: { type: 'category', data: dates },
        yAxis: { type: 'value', name: 'PnL', axisLabel: { formatter: '{value}' } },
        series: [{ type: 'line', data: equity, smooth: false, areaStyle: { opacity: 0.1 }, lineStyle: { width: 2 } }],
      });
      var ddChart = echarts.init(document.getElementById('dd-chart'));
      ddChart.setOption({
        title: { text: 'ドローダウン (累積 PnL の peak からの低下率)', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2) + '%'; } },
        grid: { left: 50, right: 20, top: 40, bottom: 40 },
        xAxis: { type: 'category', data: dates },
        yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
        series: [{ type: 'line', data: dd, areaStyle: { color: '#c22', opacity: 0.2 }, lineStyle: { color: '#c22', width: 1 } }],
      });
      window.addEventListener('resize', function () { equityChart.resize(); ddChart.resize(); });
    });
  `
  return `<p class="muted" style="font-size:12px">
    累積 realized PnL と peak からの下落率 (MaxDD)。戦略の長期パフォーマンス指標。
    シード資金額を保持していないため下落率は「累積 PnL の peak からの相対」で計算
    (peak ≤ 0 のときは 0%)。当日 intraday の risk halt 閾値 (drawdown_kill /
    risk_dd_halt) は別概念のため重畳しない。
  </p>
  <div id="equity-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  <div id="dd-chart" style="width:100%;height:280px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${safeJsonScript('__chartData', { equity: args.equity })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

function renderQualityTab(args: ChartsBodyQuality): string {
  if (args.pnls.length === 0 && args.decisions.length === 0) {
    return `<p class="muted">まだ判定ログも実 fill も無いため取引品質を描けません。cron が動き出すと judgement breakdown、SELL が約定すると PnL 分布が出ます。</p>`
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var DECISION_KEYS = ['BUY', 'SELL', 'HOLD', 'REJECT', 'ERROR'];
      var DECISION_COLORS = { BUY: '#057a55', SELL: '#1471a8', HOLD: '#aaa', REJECT: '#b25000', ERROR: '#c22' };
      var dbDates = data.decisions.map(function (p) { return p.date; });
      var dbEl = document.getElementById('decision-chart');
      if (dbEl && dbDates.length > 0) {
        var dbChart = echarts.init(dbEl);
        dbChart.setOption({
          title: { text: '日次 Decision breakdown (BUY / SELL / HOLD / REJECT / ERROR)', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
          legend: { top: 22 },
          grid: { left: 50, right: 20, top: 60, bottom: 40 },
          xAxis: { type: 'category', data: dbDates },
          yAxis: { type: 'value', name: '判定数' },
          series: DECISION_KEYS.map(function (k) {
            return { name: k, type: 'bar', stack: 'decisions',
              data: data.decisions.map(function (p) { return p.counts[k] || 0; }),
              itemStyle: { color: DECISION_COLORS[k] } };
          }),
        });
        window.addEventListener('resize', function () { dbChart.resize(); });
      }
      var pnlHistEl = document.getElementById('pnl-hist-chart');
      if (pnlHistEl && data.histogram && data.histogram.length > 0) {
        var pnlHist = echarts.init(pnlHistEl);
        pnlHist.setOption({
          title: { text: 'Per-trade realized PnL 分布', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: function (params) { var p = params[0]; return p.name + ': ' + p.value + ' trades'; } },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: data.histogram.map(function (b) { return b.label; }) },
          yAxis: { type: 'value', name: 'trades' },
          series: [{ type: 'bar',
            data: data.histogram.map(function (b) {
              return { value: b.count, itemStyle: { color: b.binCenter >= 0 ? '#057a55' : '#c22' } };
            }) }],
        });
        window.addEventListener('resize', function () { pnlHist.resize(); });
      }
    });
  `
  return `<div id="pnl-hist-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${renderTradeStatsTable(args.stats)}
  <div id="decision-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${safeJsonScript('__chartData', { decisions: args.decisions, histogram: args.histogram })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

function renderSymbolTab(args: ChartsBodySymbol): string {
  const noData =
    args.symbolChart === null ||
    args.symbolChart.points.length === 0
  if (noData) {
    return (
      renderSymbolPickerForTab(args) +
      `<p class="muted">この銘柄にはまだ判定ログ / fill がありません。</p>` +
      renderStrategyParamsPanel(args.strategyParams)
    )
  }
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      var sc = data.symbolChart;
      if (!sc || sc.points.length === 0) return;

      // xAxis 戦略:
      //   intradayBars が揃っているとき → category axis (categories = 各 bar の
      //     ISO timestamp)。overnight / 週末 / 米国祝日の空白を「詰めて」表示する
      //     (TradingView 等と同様の挙動)。ECharts の time axis では非取引時間を
      //     skip する native 機能が無いため、category 化が standard 解。
      //   intradayBars が空 (Yahoo intraday fetch 失敗) → time axis fallback。
      //     candle が無いので gap も発生せず、line / markPoint だけ実時刻で描画。
      // category mode では「category index」を全 series の x として揃える。
      // markPoint も coord に [categoryIndex, price] を渡す。
      var ohlcBars = sc.intradayBars || [];
      var useCategoryAxis = ohlcBars.length > 0;
      var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
      var categories = ohlcBars.map(function (b) { return b.timestamp; });

      // セッション境界 (休場 → 開場) 検出:
      // category axis 化で休場 gap が詰まった結果 (#193)、視覚的に
      // 「どこから新セッションか」が分かりにくくなった。1h interval なので
      // 隣接 bar は通常 60 分差。週末 / 夜間 closed 後の最初の bar は数時間〜
      // 数十時間ぶんの差が空く。閾値 90 分 (= 1.5h) で safe に検出し、後ろ側
      // category index を「新セッションの開場点」として markLine 描画する。
      // useCategoryAxis === false (intradayBars 空) の場合は描画 skip。
      var sessionOpenIndices = [];
      if (useCategoryAxis) {
        var SESSION_GAP_MS = 90 * 60 * 1000;
        for (var si = 1; si < ohlcMs.length; si++) {
          if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
        }
      }

      // Map a millisecond timestamp to the nearest category index.
      // ohlcMs は intradayBars の順序 (= Yahoo の昇順) を保つ前提。binary search
      // で近接 index を返す。ohlcMs 空 (= time axis fallback) なら -1。
      function nearestIndex(ms) {
        if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
        var lo = 0, hi = ohlcMs.length - 1;
        if (ms <= ohlcMs[0]) return 0;
        if (ms >= ohlcMs[hi]) return hi;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
        }
        // lo は ms 以上の最初の index。一つ前と比べて近い方を採用。
        if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
        return lo;
      }

      // category mode では x = category index、time mode では x = ISO timestamp
      // (= category 値そのもの)。両 mode を同じ shape (x, y) で扱えるよう抽象化。
      function xForTimestamp(ts) {
        if (useCategoryAxis) {
          var idx = nearestIndex(new Date(ts).getTime());
          return idx;
        }
        return ts;
      }
      function xForMs(ms) {
        if (useCategoryAxis) return nearestIndex(ms);
        return ms;
      }

      var jstFmt = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      function jstLabel(value) {
        return jstFmt.format(new Date(value)).replace(/\\//g, '/');
      }
      // fill 時刻は秒精度で表示 (同分内 fills を区別するため)。axisLabel は
      // 分単位で密度を保つ (秒まで出すと x 軸ラベルが詰まる)。
      var jstFmtSec = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });
      function jstLabelSec(value) {
        return jstFmtSec.format(new Date(value)).replace(/\\//g, '/');
      }
      // category index → 表示 label。category 値は ISO timestamp なのでそのまま JST 化。
      function jstLabelForX(value) {
        if (useCategoryAxis) {
          // value は category 値 (ISO string) または index。axisLabel formatter に
          // 来るのは index/value (params.value=ISO)、dataZoom labelFormatter は
          // value=ISO string が来る (slider 端点の category 値)。
          if (typeof value === 'number') {
            // index として渡される場合 (recomputeYAxis 由来等)
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }
        return jstLabel(value);
      }

      // candlestick の data shape: [open, close, low, high]。category mode では
      // index ベースなので 4 値だけ並べれば ECharts が categories 配列と対応付ける。
      // time mode では [timestamp, open, close, low, high] の 5 値タプル。
      var ohlcXY = useCategoryAxis
        ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
        : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });
      // SMA50 line: cron-eval points から取得 (daily で計算された値の推移)。
      // category mode では point の timestamp を最近接 ohlc index に snap して
      // [index, value] で渡す。時間軸の連続性は category 上で保たれる。
      var smasXY = sc.points.map(function (p) {
        if (p.sma50 == null) return [xForTimestamp(p.timestamp), null];
        return [xForTimestamp(p.timestamp), p.sma50];
      });
      // (close line は削除: candle が close を含むので冗長、overnight gap で
      //  斜めに横断する視覚ノイズが発生していたため #176 → #177 で除去)

      // 押し目買いゾーン:
      // - 上端 = high20d × (1 + pullbackMax)  ≒ 教科書の「上値抵抗線 (resistance)」
      // - 下端 = high20d × (1 + pullbackMin)  = 押し目買いの下限 (-15% 以下は深すぎ)
      var pullbackMaxMul = 1 + sc.rules.pullbackMax;
      var pullbackMinMul = 1 + sc.rules.pullbackMin;
      var bandUpperXY = sc.points.map(function (p) {
        var x = xForTimestamp(p.timestamp);
        return [x, p.high20d == null ? null : p.high20d * pullbackMaxMul];
      });
      var bandLowerXY = sc.points.map(function (p) {
        var x = xForTimestamp(p.timestamp);
        return [x, p.high20d == null ? null : p.high20d * pullbackMinMul];
      });

      // 価格トレンド線 (server-side で daily close の linear regression fit)。
      // 旧仕様の「上値抵抗線 / 下値支持線」上下 2 本は、ローソク足の上下を
      // flat に走り「価格の中心を辿る trend」という user 期待と乖離していた
      // ため、close の重心を通る best-fit 1 本に統一した。
      //
      // 検出失敗 (sample < 2 / 同時刻のみ) なら null → 描画スキップ。
      //
      // 過去 #185 / #187 / #188 / #189 で「描画されない」回帰があったが、
      // 根因は ECharts の dataZoom + 2 点 line series が「片方の点が zoom
      // 範囲外になると線が引かれない」既知挙動 (issue #3637 系)。#189 で
      // dataZoom の filterMode を 'weakFilter' に変えて改善したが、それでも
      // ユーザ環境で残ケースがあった。本質的に robust にするため、line の
      // data 自体を「常に zoom 範囲内に複数点が入る粒度」に展開する。
      //
      // 具体的には intradayBars (1h candle、60 日で ~720 点) の各 timestamp
      // で trend line の y 値を線形補間し、[[t, y], ...] の dense path にす
      // る。これで 5D (~120 点) や 1D zoom でも複数点が必ず visible になり
      // filterMode 不問で線分が描画される。intradayBars が空 (Yahoo fetch
      // 失敗) のときは 2 点 endpoint fallback (旧挙動)。
      //
      // 線形外挿: trend line は概念上両側に伸びる線なので、p1 より過去側 /
      // end より未来側の sample も同じ slope で外挿する。
      //
      // ※ Server-side densifyTrendLine (export) と同じアルゴリズム。
      //    unit test はそちらで担保する。client 側に inline するのは sc.*
      //    オブジェクトを HTML script に埋めて echarts.init で消費するため。
      // category mode では sample を「各 ohlc bar の ms」として展開した後、
      // 結果の [t, y] 配列を index ベース [i, y] に変換する (ohlcMs[i] === t を
      // 満たすので 1:1 対応)。time mode では従来通り [t, y] のまま渡す。
      var ohlcTimestamps = ohlcMs.slice();
      function densifyTrendLine(line, sampleTimestamps) {
        if (!line) return null;
        var t1 = new Date(line.pivots[0].timestamp).getTime();
        var t2 = new Date(line.end.timestamp).getTime();
        var y1 = line.pivots[0].price;
        var y2 = line.end.price;
        if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
        if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
        if (t1 === t2) return [[t1, y1], [t2, y2]];
        var slope = (y2 - y1) / (t2 - t1);
        var seen = Object.create(null);
        var arr = [];
        for (var i = 0; i < sampleTimestamps.length; i += 1) {
          var t = sampleTimestamps[i];
          if (!Number.isFinite(t)) continue;
          if (seen[t]) continue;
          seen[t] = true;
          arr.push(t);
        }
        if (!seen[t1]) { seen[t1] = true; arr.push(t1); }
        if (!seen[t2]) { seen[t2] = true; arr.push(t2); }
        arr.sort(function (a, b) { return a - b; });
        if (arr.length < 2) return [[t1, y1], [t2, y2]];
        var out = [];
        for (var j = 0; j < arr.length; j += 1) {
          var tj = arr[j];
          var yj = y1 + slope * (tj - t1);
          if (Number.isFinite(yj)) out.push([tj, yj]);
        }
        if (out.length < 2) return [[t1, y1], [t2, y2]];
        return out;
      }
      // category mode 用: [t, y] 配列を [index, y] に変換。t が ohlcMs に
      // 一致しない (= line endpoint が intradayBars の外) なら最近接 index に
      // snap される。line の中で同じ index に複数 y が落ちる場合は最初の y
      // のみ採用 (理論上 slope=0 の degenerate / endpoint クランプ時のみ発生)。
      function toCategoryXY(tyArr) {
        if (!tyArr) return null;
        if (!useCategoryAxis) return tyArr;
        var seenIdx = Object.create(null);
        var out = [];
        for (var i = 0; i < tyArr.length; i += 1) {
          var t = tyArr[i][0];
          var y = tyArr[i][1];
          var idx = nearestIndex(t);
          if (idx < 0) continue;
          if (seenIdx[idx]) continue;
          seenIdx[idx] = true;
          out.push([idx, y]);
        }
        // sort by index (nearest snap might reorder when endpoints clamp to same idx)
        out.sort(function (a, b) { return a[0] - b[0]; });
        return out.length > 0 ? out : null;
      }
      var trendLineXY = toCategoryXY(densifyTrendLine(sc.trendLine, ohlcTimestamps));

      // markPoint は xAxis: ISO timestamp (time axis 上の実時刻位置)。category 不一致問題なし。
      // pin label を短縮: BUY/SELL は色 (緑/赤) で識別、price だけ表示。
      // close-time fill (15 分以内) で label 重なりが起きにくい。pnl は SELL のみ
      // 末尾に小数 1 桁で付与 (例: "120.19 +0.4")。詳細 (full-precision PnL /
      // qty / timestamp) は markPoint hover tooltip で表示。
      // realizedPnl と filledQty を data に保持し tooltip.formatter から
      // full-precision で読む (label の toFixed(1) で丸めた値とは独立)。
      // pin label は「全 fill 中で最新」の 1 個だけ表示。それより古いのは
      // 全部 marker のみで label.show: false。BUY と SELL を別々に最新採用
      // していた旧仕様だと近接する BUY→SELL pair で label が重なる回帰が
      // あったため、現保有 status を表す「最後のアクション」だけ強調。
      // 過去の fill 詳細は hover tooltip (full-precision PnL / qty / 時刻) で。
      var buys = sc.markers.filter(function (m) { return m.side === 'BUY'; });
      var sells = sc.markers.filter(function (m) { return m.side === 'SELL'; });
      var latestFillTs = sc.markers.length > 0
        ? sc.markers[sc.markers.length - 1].timestamp
        : null;
      // category mode では markPoint coord に [categoryIndex, price] を渡す。
      // fill 時刻を最近接 ohlc bar (= 1h 粒度) の index に snap するため、同 1h
      // 内の複数 fill は同じ index に重なる。pin label は側 (top/bottom) と色で
      // 区別するため重なっても 1 件は読める。fillTimestamp は秒精度を保持して
      // hover tooltip で full-precision 時刻として表示される (情報損失なし)。
      var entries = buys.map(function (m) {
        var showLabel = m.timestamp === latestFillTs;
        return {
          name: 'BUY', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
          realizedPnl: null, qty: m.qty, fillTimestamp: m.timestamp,
          label: { show: showLabel, formatter: m.price.toFixed(2), color: '#057a55', position: 'top', distance: 6, fontSize: 11 },
          itemStyle: { color: '#057a55' },
        };
      });
      var exits = sells.map(function (m) {
        var showLabel = m.timestamp === latestFillTs;
        var pnlLabel = m.realizedPnl == null ? '' : ' ' + (m.realizedPnl >= 0 ? '+' : '') + m.realizedPnl.toFixed(1);
        return {
          name: 'SELL', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
          realizedPnl: m.realizedPnl, qty: m.qty, fillTimestamp: m.timestamp,
          label: { show: showLabel, formatter: m.price.toFixed(2) + pnlLabel, color: '#c22', position: 'bottom', distance: 6, fontSize: 11 },
          itemStyle: { color: '#c22' },
        };
      });

      // 保有中なら avg / stop / take-profit を「dense path の独立 line series」
      // として描画。openedAt から最新までのみ描画 (chart 全幅に伸ばすと
      // 「ずっと前から avg だった」と誤読される) のは旧仕様 (markLine 方式) と
      // 同じだが、ECharts dataZoom + 2 点 markLine は trend line と同様
      // 「片端が zoom 範囲外になると線が消える」回帰があるため (#190 / #191
      // と同根、issue #3637 系)、densifyHorizontalLine で intradayBars
      // 各 timestamp に y を割り当てた dense path に展開する。これで 1D zoom
      // でも複数点が必ず visible になり filterMode 不問で線が描画される。
      // ※ Server-side densifyHorizontalLine (export) と同じアルゴリズム。
      //    unit test はそちらで担保する。
      function densifyHorizontalLine(yValue, fromTs, toTs, samples) {
        if (!Number.isFinite(yValue)) return null;
        var a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime();
        var b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime();
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        if (a >= b) return [[a, yValue], [b, yValue]];
        var seen = Object.create(null);
        var arr = [];
        function push(t) {
          if (seen[t]) return;
          seen[t] = true;
          arr.push(t);
        }
        push(a);
        push(b);
        for (var i = 0; i < samples.length; i += 1) {
          var t = samples[i];
          if (!Number.isFinite(t)) continue;
          if (t < a || t > b) continue;
          push(t);
        }
        arr.sort(function (x, y) { return x - y; });
        var out = [];
        for (var j = 0; j < arr.length; j += 1) {
          out.push([arr[j], yValue]);
        }
        return out;
      }
      var avgLineXY = null;
      var stopLineXY = null;
      var tpLineXY = null;
      var avgLabel = '';
      var stopLabel = '';
      var tpLabel = '';
      var extraYValues = [];
      if (sc.position) {
        var avg = sc.position.avgPrice;
        var stopPrice = avg * (1 + sc.rules.stopPct);
        var tpPrice = avg * (1 + sc.rules.takeProfitPct);
        extraYValues.push(avg, stopPrice, tpPrice);
        var openedAt = sc.position.openedAt;
        // openedAt > 最新 point (chart データが古い / position 直後でまだ
        // strategy_decision_log に記録されていない) のとき、endTs が openedAt
        // より過去に出ると線が逆向き (左側) に伸びる。max で clamp。
        var latestTs = sc.points.length > 0 ? sc.points[sc.points.length - 1].timestamp : openedAt;
        var endTs = new Date(latestTs).getTime() >= new Date(openedAt).getTime()
          ? latestTs
          : openedAt;
        var fromMs = new Date(openedAt).getTime();
        var toMs = new Date(endTs).getTime();
        avgLineXY = toCategoryXY(densifyHorizontalLine(avg, fromMs, toMs, ohlcTimestamps));
        stopLineXY = toCategoryXY(densifyHorizontalLine(stopPrice, fromMs, toMs, ohlcTimestamps));
        tpLineXY = toCategoryXY(densifyHorizontalLine(tpPrice, fromMs, toMs, ohlcTimestamps));
        avgLabel = 'avg ' + avg.toFixed(2);
        stopLabel = 'stop ' + stopPrice.toFixed(2) + ' (' + (sc.rules.stopPct * 100).toFixed(0) + '%)';
        tpLabel = 'TP ' + tpPrice.toFixed(2) + ' (+' + (sc.rules.takeProfitPct * 100).toFixed(0) + '%)';
      }

      // ECharts の scale:true は markLine を yAxis range に含めないため、
      // TP / stop が data 範囲外だと枠の外で見えなくなる。data 全体 +
      // position lines + markers を考慮した explicit min/max + padding。
      // NaN / Infinity が混入すると Math.min/max が NaN を返し、
      // 結果 yAxis が壊れる (axis label に巨大数が出る回帰例あり) ので
      // pushIfFinite で防御。
      var allY = [];
      function pushIfFinite(v) {
        if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
      }
      // y軸は candle の高低 + markers + position 線だけで decide。
      // SMA50 (long-term、現在価格と乖離大) / band / low20d / trend line を
      // 入れると軸 range が必要以上に広がり candle が縦圧縮される
      // (trader-strategist 助言)。これらは line として描画はする
      // (auto-clip で軸外は切れる) が、軸 range には影響させない。
      (sc.intradayBars || []).forEach(function (b) {
        pushIfFinite(b.high);
        pushIfFinite(b.low);
      });
      sc.markers.forEach(function (m) { pushIfFinite(m.price); });
      extraYValues.forEach(function (v) { pushIfFinite(v); });
      var yMin, yMax;
      if (allY.length > 0) {
        var rawMin = Math.min.apply(null, allY);
        var rawMax = Math.max.apply(null, allY);
        if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
          var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
          yMin = rawMin - pad;
          yMax = rawMax + pad;
        }
      }

      // dataZoom: 下部 slider + inside (wheel/pinch zoom)。初期 zoom 範囲は
      // ?from / ?to URL params (data.zoomFromMs / zoomToMs)。zoom 操作時に
      // history.replaceState で URL を更新 → 銘柄切替を跨いでも range を維持。
      // category mode では startValue/endValue が「category index」を指す。
      // URL 由来の ms 範囲は最近接 index に snap して dataZoom に渡す。
      // time mode (intradayBars 空) では従来通り ms をそのまま startValue に。
      var dzInitial = (function () {
        if (data.zoomFromMs == null || data.zoomToMs == null) return {};
        if (useCategoryAxis) {
          var fromIdx = nearestIndex(data.zoomFromMs);
          var toIdx = nearestIndex(data.zoomToMs);
          if (fromIdx < 0 || toIdx < 0) return {};
          if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
          return { startValue: fromIdx, endValue: toIdx };
        }
        return { startValue: data.zoomFromMs, endValue: data.zoomToMs };
      })();
      // dataZoom slider 両端ラベルも JST で表示 (default だと UTC date string)。
      // category mode では labelFormatter に category 値 (= ISO timestamp 文字列)
      // が渡されるので jstLabel に直接通せばよい (内部で Date(value) parse)。
      // filterMode: 'weakFilter' は line / markLine など複数点で 1 figure を
      // 構成する series 用。default の 'filter' は data item 単位で評価し、
      // 1 dimension でも zoom 外なら点ごと除外する → 直近 2 pivot を chart 末
      // まで延長する trend line ([oldPivot(~30d 前), chartEnd] の 2 点) は 5D
      // zoom で oldPivot が範囲外 → 1 点だけ残り「線が引けない」回帰になる。
      // 'weakFilter' は同 group 内の全点が同じ側に外れた時のみ filter する
      // ため、片端が範囲内なら線分は描画される (公式 issue #3637 / official
      // PR で line chart が zoom 中に消える問題の対策として実装された挙動)。
      // candle / line / scatter / markLine / markPoint / markArea すべてで
      // 「1 点が範囲外でも視覚的に切れて表示される」のが期待動作なので
      // wide chart (1 銘柄 / 数千点) でも問題ない。
      var dzCommon = {
        labelFormatter: function (value) { return jstLabelForX(value); },
        filterMode: 'weakFilter',
      };
      var dzInside = { filterMode: 'weakFilter' };
      var dataZoomCfg = [
        Object.assign({ type: 'inside', xAxisIndex: 0 }, dzInside, dzInitial),
        Object.assign({ type: 'slider', xAxisIndex: 0, height: 24, bottom: 8 }, dzCommon, dzInitial),
      ];

      var symChart = echarts.init(document.getElementById('symbol-chart'));
      symChart.setOption({
        title: { text: sc.symbol + ' price + トレンドライン + 押し目ゾーン + entry/exit', left: 'center', textStyle: { fontSize: 14 } },
        tooltip: {
          trigger: 'axis',
          axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
          // 既定の trigger:'axis' tooltip は header に axis value (時刻) を
          // UTC 文字列で出すため、JST formatter を当てた custom formatter で上書き。
          // candlestick 値は [open, close, low, high]、line は scalar として処理。
          // category mode では axisValue は category 値 (= ISO timestamp string)。
          formatter: function (params) {
            if (!Array.isArray(params) || params.length === 0) return '';
            var ts = params[0].axisValue;
            var lines = ['<div style="font-weight:600;font-size:11px">' + jstLabelForX(ts) + '</div>'];
            for (var i = 0; i < params.length; i += 1) {
              var p = params[i];
              if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                // ECharts は candlestick の p.value 先頭に系列の x (timestamp/index)
                // を入れて返すことがあるため、長さで分岐。length===4 の場合は
                // [O, C, L, H]、5 以上は [x, O, C, L, H]。
                var off = p.value.length >= 5 ? 1 : 0;
                lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName +
                  '  O ' + Number(p.value[off]).toFixed(2) +
                  '  H ' + Number(p.value[off + 3]).toFixed(2) +
                  '  L ' + Number(p.value[off + 2]).toFixed(2) +
                  '  C ' + Number(p.value[off + 1]).toFixed(2) + '</div>');
              } else {
                var v = Array.isArray(p.value) ? p.value[1] : p.value;
                if (v == null) continue;
                lines.push('<div style="font-size:11px">' + p.marker + ' ' + p.seriesName +
                  ': ' + Number(v).toFixed(2) + '</div>');
              }
            }
            return lines.join('');
          },
        },
        legend: { top: 22, type: 'scroll' },
        // plot 面積最大化: grid 余白を絞り、splitLine 淡く、axisLine 非表示で
        // candle が映える背景に (trader-strategist 助言)。bottom は slider 用 64px キープ。
        grid: { left: 50, right: 20, top: 56, bottom: 64 },
        dataZoom: dataZoomCfg,
        // category mode: categories = intradayBars 各 bar の ISO timestamp。
        // overnight / 週末 / 米国祝日の空白を「詰めて」表示するため (TradingView
        // 同等)、time axis ではなく category axis を採用。category 間隔は等間隔
        // なので「金曜 16:00 ET 引け」と「月曜 09:30 ET 寄り」が隣接する。これは
        // 「同じ 1 hour 進んだように見える」が、休場で値が動いていない gap を
        // 詰める方が視認性で勝る (user 要望)。
        // time mode (intradayBars 空) では従来の time axis にフォールバック。
        xAxis: useCategoryAxis ? {
          type: 'category',
          data: categories,
          // 連続する category を密に並べた候補の中から ECharts が省略間引きする
          // ので、明示的な intervals 不要。formatter で個々の category 値 (ISO
          // timestamp) を JST に整形。
          axisLabel: { formatter: function (value) { return jstLabel(value); }, hideOverlap: true },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        } : {
          type: 'time',
          axisLabel: { formatter: function (value) { return jstLabel(value); } },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        },
        yAxis: {
          type: 'value', min: yMin, max: yMax,
          axisLabel: { showMinLabel: false, showMaxLabel: false },
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { opacity: 0.15 } },
        },
        series: [
          // 保有時は押し目バンド非表示 (avg/stop/TP に集中)、非保有時は淡く表示
          // (戦略 rule の参考、トレンドラインが主役なので opacity 0.4)。
          ...(sc.position ? [] : [
            { name: '押し目ゾーン上端 (high20d × ' + (pullbackMaxMul).toFixed(2) + ')', type: 'line', data: bandUpperXY, lineStyle: { width: 0.6, color: '#057a55', type: 'dashed', opacity: 0.4 }, symbol: 'none', connectNulls: false, z: 1 },
            { name: '押し目ゾーン下端 (high20d × ' + (pullbackMinMul).toFixed(2) + ')', type: 'line', data: bandLowerXY, lineStyle: { width: 0.6, color: '#b25000', type: 'dashed', opacity: 0.4 }, symbol: 'none', connectNulls: false, z: 1 },
          ]),
          // 価格トレンド (linear regression, 直近 30 日 daily close fit)。
          // 1 本だけ。中間色 (紫 #9333ea) で「上値 / 下値どちらでもない、価格
          // の重心」を表す。dense path (intradayBars 各 timestamp で y 補間)
          // で zoom にかかわらず確実に描画される (2 点 line series で zoom
          // 縮めると seg-droppable な ECharts 既知挙動 #3637 系への根本対処)。
          // z:7 で candle (z:5) / SMA50 (z:6) より上に置き、線本体を最前面に。
          // symbol:'none' で点 marker は出さない。itemStyle.color は legend
          // dot 色を lineStyle.color と揃えるため明示。
          ...(trendLineXY ? [{
            name: '価格トレンド (linear regression, 30日)', type: 'line', data: trendLineXY,
            lineStyle: { width: 1.8, color: '#9333ea', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#9333ea' }, z: 7,
          }] : []),
          // candlestick: 15 分足 OHLC を表示。Western 規約 (close >= open = 緑、
          // candle: 主役。Western 規約 (close >= open = 緑、< = 赤)。
          // markPoint / markLine もここに anchor。barWidth 明示で overnight
          // gap 後の細い candle を視認可能に。borderWidth 強めて
          // body と wick の対比を確保。
          ...(ohlcXY.length > 0 ? [{
            name: 'price (1h OHLC)', type: 'candlestick', data: ohlcXY,
            // 1h は 15m より時間軸の間隔が 4 倍広いので、barWidth も少し
            // 広めに (相対的に gap 比率を一定に保つ)。
            barWidth: 10,
            itemStyle: {
              color: '#057a55',     // bullish (close >= open)
              color0: '#c22',       // bearish (close < open)
              borderColor: '#057a55',
              borderColor0: '#c22',
              borderWidth: 1.5,
            },
            z: 5,
            // position lines (avg/stop/TP) は dense path の独立 line series
            // として描画する (下方参照、densifyHorizontalLine 適用)。
            // candlestick の markLine は trend line / position line いずれも
            // dataZoom + 2 点だと「片端外で線が消える」回帰があるため使わない。
            //
            // ただしセッション境界の縦点線は xAxis: <category index> 指定で
            // y 軸全幅にまたがる「真の vertical markLine」となり、ECharts の
            // 描画 path が trend line (slanted 2-point markLine) とは別系統。
            // 縦線方向は zoom 範囲外でも描画ロバスト (#193 follow-up)。
            // category 軸モード時のみ data を積む (time axis fallback では空)。
            markLine: sessionOpenIndices.length > 0 ? {
              symbol: 'none',
              silent: true,
              label: { show: false },
              lineStyle: { color: '#bbb', width: 1, type: 'dashed' },
              z: 1,
              data: sessionOpenIndices.map(function (idx) {
                return { xAxis: idx };
              }),
            } : undefined,
            markPoint: entries.length + exits.length > 0 ? {
              symbol: 'pin', symbolSize: 24, data: entries.concat(exits),
              tooltip: {
                trigger: 'item',
                formatter: function (p) {
                  var d = p.data;
                  var pnl = d.realizedPnl == null
                    ? ''
                    : '<br/>realized PnL: ' + (d.realizedPnl >= 0 ? '+' : '') + d.realizedPnl.toFixed(2);
                  var qty = d.qty == null ? '' : '<br/>qty: ' + d.qty;
                  var ts = d.fillTimestamp == null ? '' : '<br/>fill: ' + jstLabelSec(d.fillTimestamp);
                  return d.name + ' @ ' + d.value.toFixed(2) + pnl + qty + ts;
                },
              },
            } : undefined,
          }] : []),
          // SMA50 line: Yahoo daily bars から server-side で連続計算 (cron eval
          // 行間も Yahoo 日次で線が繋がる)。candle (z:5) より上に置いて細い
          // candle 帯に重なっても見えるようにする。色は TradingView 系で
          // SMA に多用される orange (#f59e0b)、solid 1.4px。
          // trend line は独立 series で描画する (上方参照)。markLine 方式は
          // legend に出ないため legend と series の対応が崩れる。
          {
            name: 'SMA50', type: 'line', data: smasXY,
            lineStyle: { width: 1.4, color: '#f59e0b', type: 'solid' },
            symbol: 'none', connectNulls: true, z: 6,
          },
          // 保有時の avg / stop / TP 水平線。densifyHorizontalLine で
          // openedAt〜最新の dense path に展開済み (上方参照)。endLabel で
          // 右端に「avg 124.95」等のラベルを出す (zoom in しても右端は常に
          // 描画範囲内なので consistently 見える)。z:8 で candle / SMA50 /
          // trend line のすべてより上に置き、保有 status を最優先で可視化。
          // tooltip / hover には介入させたくないので silent + emphasis disabled。
          ...(avgLineXY ? [{
            name: avgLabel, type: 'line', data: avgLineXY,
            lineStyle: { width: 1, color: '#444', type: 'solid' }, symbol: 'none',
            itemStyle: { color: '#444' },
            endLabel: { show: true, formatter: avgLabel, color: '#444', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          ...(stopLineXY ? [{
            name: stopLabel, type: 'line', data: stopLineXY,
            lineStyle: { width: 1, color: '#c22', type: 'dashed' }, symbol: 'none',
            itemStyle: { color: '#c22' },
            endLabel: { show: true, formatter: stopLabel, color: '#c22', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
          ...(tpLineXY ? [{
            name: tpLabel, type: 'line', data: tpLineXY,
            lineStyle: { width: 1, color: '#057a55', type: 'dashed' }, symbol: 'none',
            itemStyle: { color: '#057a55' },
            endLabel: { show: true, formatter: tpLabel, color: '#057a55', fontSize: 11 },
            silent: true, emphasis: { disabled: true }, z: 8,
          }] : []),
        ],
      });
      window.addEventListener('resize', function () { symChart.resize(); });

      // visible 範囲 (zoom 後の x 軸) 内の candle high/low / markers / position
      // 線を集めて y 軸 range を再計算。zoom out / preset 切替で「縦に空白が
      // 広がる」現象を防ぎプロ chart 風のタイト fit に。
      // category mode では dataZoom.startValue/endValue は category index、
      // time mode では ms。各 bar / marker / point について
      // 「visible 範囲内か」を判定する関数を mode で切り替える。
      function recomputeYAxis() {
        var opt = symChart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return;
        var startVal = dz.startValue;
        var endVal = dz.endValue;
        if (startVal == null || endVal == null) return;
        // mode 共通: 「ts (ISO string) または ms が visible か」を返す。
        // category mode では nearestIndex で snap した index を range と比較。
        // time mode では ms を range と比較。
        function inRangeMs(ms) {
          if (!Number.isFinite(ms)) return false;
          if (useCategoryAxis) {
            var idx = nearestIndex(ms);
            return idx >= startVal && idx <= endVal;
          }
          return ms >= startVal && ms <= endVal;
        }
        // category index ベースの直接判定 (intradayBars iterate 用)
        function inRangeIdx(idx) {
          if (useCategoryAxis) return idx >= startVal && idx <= endVal;
          return true; // time mode では使わない (intradayBars iterate 側で ms 判定)
        }
        var visibleY = [];
        function pushIfFinite(v) {
          if (v != null && typeof v === 'number' && Number.isFinite(v)) visibleY.push(v);
        }
        (sc.intradayBars || []).forEach(function (b, i) {
          if (useCategoryAxis ? inRangeIdx(i) : inRangeMs(new Date(b.timestamp).getTime())) {
            pushIfFinite(b.high);
            pushIfFinite(b.low);
          }
        });
        sc.markers.forEach(function (m) {
          if (inRangeMs(new Date(m.timestamp).getTime())) pushIfFinite(m.price);
        });
        // visible 範囲内の SMA50 値も含める。SMA50 が candle と離れた水準
        // (例: SOXL は 3x rally で SMA50=65 / 価格=128) の銘柄では candle が
        // 縦方向に圧縮されるが、SMA50 line が常時可視になる方を優先する
        // (#181 後の user request)。zoom out すれば candle にとって過剰な
        // 引き伸ばしも緩和される。
        sc.points.forEach(function (p) {
          if (inRangeMs(new Date(p.timestamp).getTime())) pushIfFinite(p.sma50);
        });
        // trend line: regression で fit した 1 本。pivots[0]→end の 2 点で
        // 直線が定義される。visible 範囲内に endpoint または時間軸の交点が
        // 乗るときに y 値を取り込んで axis 外にはみ出さないようにする。両
        // endpoint が範囲外でも線分が visible 帯を横断するなら sample して
        // その y を採用 (= 単純な 2 点線形補間)。
        // category mode では index 基準の visible range を ms に変換して
        // 既存の ms 補間ロジックをそのまま再利用する。
        function sampleTrendY(line) {
          if (!line) return;
          var p1 = line.pivots[0];
          var p2 = line.end;
          var t1 = new Date(p1.timestamp).getTime();
          var t2 = new Date(p2.timestamp).getTime();
          if (!Number.isFinite(t1) || !Number.isFinite(t2) || t1 === t2) return;
          var slope = (p2.price - p1.price) / (t2 - t1);
          var startMs, endMs;
          if (useCategoryAxis) {
            var sIdx = Math.max(0, Math.min(categories.length - 1, Math.round(startVal)));
            var eIdx = Math.max(0, Math.min(categories.length - 1, Math.round(endVal)));
            startMs = ohlcMs[sIdx];
            endMs = ohlcMs[eIdx];
          } else {
            startMs = startVal;
            endMs = endVal;
          }
          // visible 範囲と線分の交差区間を [a, b] にクリップして両端を採用
          var a = Math.max(startMs, Math.min(t1, t2));
          var b = Math.min(endMs, Math.max(t1, t2));
          if (a > b) return; // 重なりなし
          pushIfFinite(p1.price + slope * (a - t1));
          pushIfFinite(p1.price + slope * (b - t1));
        }
        sampleTrendY(sc.trendLine);
        // 保有期間が visible 範囲と重なっていれば position 線を含める。
        // category mode では openedAt の最近接 index と endVal を比較。
        if (sc.position) {
          var openedAtMs = new Date(sc.position.openedAt).getTime();
          var openedVisible = false;
          if (Number.isFinite(openedAtMs)) {
            if (useCategoryAxis) {
              var oIdx = nearestIndex(openedAtMs);
              openedVisible = oIdx <= endVal;
            } else {
              openedVisible = openedAtMs <= endVal;
            }
          }
          if (openedVisible) {
            var avg = sc.position.avgPrice;
            pushIfFinite(avg);
            pushIfFinite(avg * (1 + sc.rules.stopPct));
            pushIfFinite(avg * (1 + sc.rules.takeProfitPct));
          }
        }
        if (visibleY.length === 0) return;
        var rawMin = Math.min.apply(null, visibleY);
        var rawMax = Math.max.apply(null, visibleY);
        if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return;
        var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
        symChart.setOption({ yAxis: { min: rawMin - pad, max: rawMax + pad } });
      }
      // 初回 render 後に一度実行 (default zoom 範囲に y を tight fit)
      recomputeYAxis();

      // dataZoom 変更で URL の ?from / ?to を更新 (replaceState なので history
      // 汚染なし)。debounce 200ms で連続操作中の URL flicker を抑制。
      // 同時に symbol picker / tab strip の '?tab=symbol' リンクの href も
      // 上書き → 銘柄切替で zoom が古い range に reset されない。
      // y 軸も visible 範囲に再 fit (recomputeYAxis、debounce 内で)。
      var dzTimer = null;
      symChart.on('dataZoom', function () {
        if (dzTimer) clearTimeout(dzTimer);
        dzTimer = setTimeout(function () {
          recomputeYAxis();
          var opt = symChart.getOption();
          var dz = opt.dataZoom && opt.dataZoom[0];
          if (!dz) return;
          var sv = dz.startValue;
          var ev = dz.endValue;
          if (sv == null || ev == null) return;
          try {
            // category mode: sv/ev は category index → categories[i] (ISO string)
            // を取り出して ms に変換。time mode: sv/ev は ms (number)。
            var fromMsLocal, toMsLocal;
            if (useCategoryAxis) {
              var sIdx = Math.max(0, Math.min(categories.length - 1, Math.round(sv)));
              var eIdx = Math.max(0, Math.min(categories.length - 1, Math.round(ev)));
              fromMsLocal = new Date(categories[sIdx]).getTime();
              toMsLocal = new Date(categories[eIdx]).getTime();
            } else {
              fromMsLocal = sv;
              toMsLocal = ev;
            }
            var fromIso = new Date(fromMsLocal).toISOString();
            var toIso = new Date(toMsLocal).toISOString();
            var url = new URL(window.location.href);
            url.searchParams.set('from', fromIso);
            url.searchParams.set('to', toIso);
            window.history.replaceState({}, '', url.toString());
            // server-render 時の picker / tab strip リンクは古い from/to を
            // 持っているので、ここで href を新値に書き換える。
            var symbolLinks = document.querySelectorAll('a[href*="tab=symbol"]');
            for (var i = 0; i < symbolLinks.length; i += 1) {
              try {
                var linkUrl = new URL(symbolLinks[i].href);
                linkUrl.searchParams.set('from', fromIso);
                linkUrl.searchParams.set('to', toIso);
                symbolLinks[i].href = linkUrl.toString();
              } catch (e) { /* noop per-link */ }
            }
          } catch (e) { /* noop */ }
        }, 200);
      });

      // preset zoom buttons (1D / 5D / 1M / All) の click handler。
      // dispatchAction で dataZoom を更新 → 既存の dataZoom listener が
      // URL ?from / ?to も連動更新する。
      // category mode では ms 範囲を最近接 index に snap してから dispatch。
      var presetButtons = document.querySelectorAll('.zoom-preset');
      for (var pi = 0; pi < presetButtons.length; pi += 1) {
        presetButtons[pi].addEventListener('click', function (ev) {
          var fromMs = Number(ev.currentTarget.getAttribute('data-from-ms'));
          var toMs = Number(ev.currentTarget.getAttribute('data-to-ms'));
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
          var sv, eV;
          if (useCategoryAxis) {
            sv = nearestIndex(fromMs);
            eV = nearestIndex(toMs);
            if (sv < 0 || eV < 0) return;
            if (sv > eV) { var tmp = sv; sv = eV; eV = tmp; }
          } else {
            sv = fromMs;
            eV = toMs;
          }
          // inside / slider 両方を同期更新
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
          symChart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: sv, endValue: eV });
        });
      }
    });
  `
  return `${renderSymbolPickerForTab(args)}
  ${renderCurrentIndicatorsBadge(args.symbolChart)}
  <div id="symbol-chart" style="width:100%;height:460px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${renderZoomPresetButtons(args.symbolChart)}
  ${renderStrategyParamsPanel(args.strategyParams)}
  ${safeJsonScript('__chartData', {
    symbolChart: args.symbolChart,
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  })}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

/**
 * 銘柄グリッドビュー (Datadog dashboard 風)。ALLOWED_SYMBOLS を 4 列 grid で
 * 並列表示し、`echarts.connect('symbols-grid')` で全 panel の dataZoom と
 * tooltip を同期させる。preset zoom (1D/5D/1M/All) は grid 共通 toolbar から
 * 全 chart へ dispatchAction で broadcast。
 *
 * mini chart の構成 (個別銘柄タブの簡素版):
 * - candle (1h OHLC)
 * - 価格トレンド (linear regression)
 * - 保有時の avg / stop / TP 水平線
 * - BUY/SELL pin (markPoint)
 * - session divider (vertical lines)
 * - SMA50 / band / 詳細パネルは省略 (panel size に合わせて視認性を優先)
 */
export function renderGridTab(args: ChartsBodyGrid): string {
  if (args.charts.length === 0) {
    return `<p class="muted">ALLOWED_SYMBOLS が空です。<code>symbol_config</code> に少なくとも 1 銘柄登録してください。</p>`
  }
  // grid 共通 toolbar の preset zoom buttons。reference chart (最初に load 成功)
  // の lastTimestamp を基準に from/to を計算。各 panel が個別に同 timestamp 軸
  // を持つため、共通の ms 範囲で全 chart を dispatchAction で同期する。
  const referenceChart = args.charts.find((c) => c.chart !== null)?.chart ?? null
  const presetButtonsHtml = renderZoomPresetButtons(referenceChart)

  // 各 panel の HTML container。chart 本体は client side で echarts.init される。
  // panel header に symbol 名 (詳細タブへの link) と最新 indicators (price /
  // SMA50 / high20d / low20d) を出して「市場全体ビュー」で trader が銘柄を
  // 一目で識別できるようにする。
  const panelsHtml = args.charts
    .map((entry, idx) => {
      const symbolLink = `/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(entry.symbol)}`
      const headerLink = `<a href="${symbolLink}" style="font-weight:600;font-size:14px;color:#06c;text-decoration:none">${esc(entry.symbol)}</a>`
      if (entry.chart === null) {
        const errMsg = entry.error ?? 'チャートデータ取得失敗'
        return `<div class="grid-panel" style="border:1px solid #d0d0d5;border-radius:6px;padding:8px;background:#fff">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            ${headerLink}
            <span class="warn" style="font-size:11px">取得失敗</span>
          </div>
          <div class="muted" style="font-size:12px;padding:24px 8px;text-align:center">${esc(errMsg)}</div>
        </div>`
      }
      const badge = renderGridPanelBadge(entry.chart)
      return `<div class="grid-panel" style="border:1px solid #d0d0d5;border-radius:6px;padding:8px;background:#fff">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px">
          ${headerLink}
          ${badge}
        </div>
        <div id="grid-chart-${idx}" style="width:100%;height:280px"></div>
      </div>`
    })
    .join('')

  // client 側に渡す全銘柄分の chart payload。各 panel が個別 echarts.init で
  // 消費する。__chartData.charts は array of { symbol, chart } (chart は load
  // 失敗で null)。zoomFromMs / zoomToMs は preset toolbar・初期 dataZoom で共有。
  const payload = {
    charts: args.charts.map((c) => ({ symbol: c.symbol, chart: c.chart, error: c.error })),
    zoomFromMs: args.zoom ? args.zoom.from.getTime() : null,
    zoomToMs: args.zoom ? args.zoom.to.getTime() : null,
  }

  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') return;
      var data = window.__chartData;
      if (!data || !Array.isArray(data.charts)) return;

      // mini chart factory: 1 panel 分の echarts instance を build して返す。
      // 単一銘柄タブの主要要素 (candle / 価格トレンド / position lines /
      // session divider / BUY-SELL pin) を引き継ぎつつ、SMA50 / band /
      // legend / chart 内 title は panel size のため省略する。
      function buildPanel(elId, sc) {
        if (!sc || !Array.isArray(sc.points) || sc.points.length === 0) return null;
        var el = document.getElementById(elId);
        if (!el) return null;
        var ohlcBars = sc.intradayBars || [];
        var useCategoryAxis = ohlcBars.length > 0;
        var ohlcMs = ohlcBars.map(function (b) { return new Date(b.timestamp).getTime(); });
        var categories = ohlcBars.map(function (b) { return b.timestamp; });

        var sessionOpenIndices = [];
        if (useCategoryAxis) {
          var SESSION_GAP_MS = 90 * 60 * 1000;
          for (var si = 1; si < ohlcMs.length; si++) {
            if (ohlcMs[si] - ohlcMs[si - 1] >= SESSION_GAP_MS) sessionOpenIndices.push(si);
          }
        }

        function nearestIndex(ms) {
          if (!Number.isFinite(ms) || ohlcMs.length === 0) return -1;
          var lo = 0, hi = ohlcMs.length - 1;
          if (ms <= ohlcMs[0]) return 0;
          if (ms >= ohlcMs[hi]) return hi;
          while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (ohlcMs[mid] < ms) lo = mid + 1; else hi = mid;
          }
          if (lo > 0 && (ms - ohlcMs[lo - 1]) <= (ohlcMs[lo] - ms)) return lo - 1;
          return lo;
        }
        function xForTimestamp(ts) {
          if (useCategoryAxis) return nearestIndex(new Date(ts).getTime());
          return ts;
        }

        var jstFmt = new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        function jstLabel(value) {
          return jstFmt.format(new Date(value)).replace(/\\//g, '/');
        }
        function jstLabelForX(value) {
          if (useCategoryAxis && typeof value === 'number') {
            var i = Math.round(value);
            if (i < 0 || i >= categories.length) return '';
            return jstLabel(categories[i]);
          }
          return jstLabel(value);
        }

        var ohlcXY = useCategoryAxis
          ? ohlcBars.map(function (b) { return [b.open, b.close, b.low, b.high]; })
          : ohlcBars.map(function (b) { return [b.timestamp, b.open, b.close, b.low, b.high]; });

        // dense trend line (個別銘柄タブと同アルゴリズム)
        var ohlcTimestamps = ohlcMs.slice();
        function densifyTrendLine(line, sampleTimestamps) {
          if (!line) return null;
          var t1 = new Date(line.pivots[0].timestamp).getTime();
          var t2 = new Date(line.end.timestamp).getTime();
          var y1 = line.pivots[0].price;
          var y2 = line.end.price;
          if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
          if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
          if (t1 === t2) return [[t1, y1], [t2, y2]];
          var slope = (y2 - y1) / (t2 - t1);
          var seen = Object.create(null);
          var arr = [];
          for (var i = 0; i < sampleTimestamps.length; i += 1) {
            var t = sampleTimestamps[i];
            if (!Number.isFinite(t)) continue;
            if (seen[t]) continue;
            seen[t] = true;
            arr.push(t);
          }
          if (!seen[t1]) { seen[t1] = true; arr.push(t1); }
          if (!seen[t2]) { seen[t2] = true; arr.push(t2); }
          arr.sort(function (a, b) { return a - b; });
          if (arr.length < 2) return [[t1, y1], [t2, y2]];
          var out = [];
          for (var j = 0; j < arr.length; j += 1) {
            var tj = arr[j];
            var yj = y1 + slope * (tj - t1);
            if (Number.isFinite(yj)) out.push([tj, yj]);
          }
          if (out.length < 2) return [[t1, y1], [t2, y2]];
          return out;
        }
        function toCategoryXY(tyArr) {
          if (!tyArr) return null;
          if (!useCategoryAxis) return tyArr;
          var seenIdx = Object.create(null);
          var out = [];
          for (var i = 0; i < tyArr.length; i += 1) {
            var t = tyArr[i][0];
            var y = tyArr[i][1];
            var idx = nearestIndex(t);
            if (idx < 0) continue;
            if (seenIdx[idx]) continue;
            seenIdx[idx] = true;
            out.push([idx, y]);
          }
          out.sort(function (a, b) { return a[0] - b[0]; });
          return out.length > 0 ? out : null;
        }
        var trendLineXY = toCategoryXY(densifyTrendLine(sc.trendLine, ohlcTimestamps));

        // BUY/SELL pin: 個別銘柄タブと同形 (label は最新の fill 1 件のみ表示)
        var buys = (sc.markers || []).filter(function (m) { return m.side === 'BUY'; });
        var sells = (sc.markers || []).filter(function (m) { return m.side === 'SELL'; });
        var latestFillTs = sc.markers && sc.markers.length > 0
          ? sc.markers[sc.markers.length - 1].timestamp
          : null;
        var entries = buys.map(function (m) {
          var showLabel = m.timestamp === latestFillTs;
          return {
            name: 'BUY', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
            label: { show: showLabel, formatter: m.price.toFixed(2), color: '#057a55', position: 'top', distance: 4, fontSize: 10 },
            itemStyle: { color: '#057a55' },
          };
        });
        var exits = sells.map(function (m) {
          var showLabel = m.timestamp === latestFillTs;
          var pnlLabel = m.realizedPnl == null ? '' : ' ' + (m.realizedPnl >= 0 ? '+' : '') + m.realizedPnl.toFixed(1);
          return {
            name: 'SELL', coord: [xForTimestamp(m.timestamp), m.price], value: m.price,
            label: { show: showLabel, formatter: m.price.toFixed(2) + pnlLabel, color: '#c22', position: 'bottom', distance: 4, fontSize: 10 },
            itemStyle: { color: '#c22' },
          };
        });

        // 保有時の avg / stop / TP 水平線 (個別銘柄タブと同 dense path 方式)
        function densifyHorizontalLine(yValue, fromTs, toTs, samples) {
          if (!Number.isFinite(yValue)) return null;
          var a = typeof fromTs === 'number' ? fromTs : new Date(fromTs).getTime();
          var b = typeof toTs === 'number' ? toTs : new Date(toTs).getTime();
          if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
          if (a >= b) return [[a, yValue], [b, yValue]];
          var seen = Object.create(null);
          var arr = [];
          function push(t) { if (seen[t]) return; seen[t] = true; arr.push(t); }
          push(a); push(b);
          for (var i = 0; i < samples.length; i += 1) {
            var t = samples[i];
            if (!Number.isFinite(t)) continue;
            if (t < a || t > b) continue;
            push(t);
          }
          arr.sort(function (x, y) { return x - y; });
          var out = [];
          for (var j = 0; j < arr.length; j += 1) out.push([arr[j], yValue]);
          return out;
        }
        var avgLineXY = null, stopLineXY = null, tpLineXY = null;
        var extraYValues = [];
        if (sc.position) {
          var avg = sc.position.avgPrice;
          var stopPrice = avg * (1 + sc.rules.stopPct);
          var tpPrice = avg * (1 + sc.rules.takeProfitPct);
          extraYValues.push(avg, stopPrice, tpPrice);
          var openedAt = sc.position.openedAt;
          var latestTs = sc.points.length > 0 ? sc.points[sc.points.length - 1].timestamp : openedAt;
          var endTs = new Date(latestTs).getTime() >= new Date(openedAt).getTime() ? latestTs : openedAt;
          var fromMs = new Date(openedAt).getTime();
          var toMs = new Date(endTs).getTime();
          avgLineXY = toCategoryXY(densifyHorizontalLine(avg, fromMs, toMs, ohlcTimestamps));
          stopLineXY = toCategoryXY(densifyHorizontalLine(stopPrice, fromMs, toMs, ohlcTimestamps));
          tpLineXY = toCategoryXY(densifyHorizontalLine(tpPrice, fromMs, toMs, ohlcTimestamps));
        }

        // y 軸 range (candle + markers + position lines のみ。SMA50/band は除外)
        var allY = [];
        function pushIfFinite(v) {
          if (v != null && typeof v === 'number' && Number.isFinite(v)) allY.push(v);
        }
        ohlcBars.forEach(function (b) { pushIfFinite(b.high); pushIfFinite(b.low); });
        (sc.markers || []).forEach(function (m) { pushIfFinite(m.price); });
        extraYValues.forEach(function (v) { pushIfFinite(v); });
        var yMin, yMax;
        if (allY.length > 0) {
          var rawMin = Math.min.apply(null, allY);
          var rawMax = Math.max.apply(null, allY);
          if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
            var pad = Math.max((rawMax - rawMin) * 0.05, 0.5);
            yMin = rawMin - pad;
            yMax = rawMax + pad;
          }
        }

        // dataZoom 初期範囲。connect 経由で他 panel と同期するため、最初の
        // setOption 直後に echarts.connect('symbols-grid') を呼ぶ (panel 構築
        // ループの末尾)。filterMode は trend / position line の dropping 防止
        // 目的で 'weakFilter' (個別銘柄タブと同方針)。
        var dzInitial = (function () {
          if (data.zoomFromMs == null || data.zoomToMs == null) return {};
          if (useCategoryAxis) {
            var fromIdx = nearestIndex(data.zoomFromMs);
            var toIdx = nearestIndex(data.zoomToMs);
            if (fromIdx < 0 || toIdx < 0) return {};
            if (fromIdx > toIdx) { var tmp = fromIdx; fromIdx = toIdx; toIdx = tmp; }
            return { startValue: fromIdx, endValue: toIdx };
          }
          return { startValue: data.zoomFromMs, endValue: data.zoomToMs };
        })();
        var dzCommon = {
          labelFormatter: function (value) { return jstLabelForX(value); },
          filterMode: 'weakFilter',
        };
        var dzInside = { filterMode: 'weakFilter' };
        var dataZoomCfg = [
          Object.assign({ type: 'inside', xAxisIndex: 0 }, dzInside, dzInitial),
          Object.assign({ type: 'slider', xAxisIndex: 0, height: 18, bottom: 4, showDetail: false }, dzCommon, dzInitial),
        ];

        var chart = echarts.init(el);
        chart.setOption({
          animation: false,
          tooltip: {
            trigger: 'axis',
            axisPointer: { label: { formatter: function (p) { return jstLabelForX(p.value); } } },
            formatter: function (params) {
              if (!Array.isArray(params) || params.length === 0) return '';
              var ts = params[0].axisValue;
              var lines = ['<div style="font-weight:600;font-size:11px">' + sc.symbol + ' ' + jstLabelForX(ts) + '</div>'];
              for (var i = 0; i < params.length; i += 1) {
                var p = params[i];
                if (p.seriesType === 'candlestick' && Array.isArray(p.value)) {
                  var off = p.value.length >= 5 ? 1 : 0;
                  lines.push('<div style="font-size:11px">' + p.marker + ' OHLC ' +
                    Number(p.value[off]).toFixed(2) + ' / ' +
                    Number(p.value[off + 3]).toFixed(2) + ' / ' +
                    Number(p.value[off + 2]).toFixed(2) + ' / ' +
                    Number(p.value[off + 1]).toFixed(2) + '</div>');
                }
              }
              return lines.join('');
            },
          },
          legend: { show: false },
          grid: { left: 40, right: 8, top: 8, bottom: 28 },
          dataZoom: dataZoomCfg,
          xAxis: useCategoryAxis ? {
            type: 'category', data: categories,
            axisLabel: { formatter: function (value) { return jstLabel(value); }, hideOverlap: true, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: false },
          } : {
            type: 'time',
            axisLabel: { formatter: function (value) { return jstLabel(value); }, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value', min: yMin, max: yMax,
            axisLabel: { showMinLabel: false, showMaxLabel: false, fontSize: 10 },
            axisLine: { show: false },
            splitLine: { show: true, lineStyle: { opacity: 0.1 } },
          },
          series: [
            ...(trendLineXY ? [{
              name: 'trend', type: 'line', data: trendLineXY,
              lineStyle: { width: 1.2, color: '#9333ea' }, symbol: 'none',
              itemStyle: { color: '#9333ea' }, z: 7,
            }] : []),
            ...(ohlcXY.length > 0 ? [{
              name: 'price', type: 'candlestick', data: ohlcXY,
              barWidth: 6,
              itemStyle: {
                color: '#057a55', color0: '#c22',
                borderColor: '#057a55', borderColor0: '#c22', borderWidth: 1,
              },
              z: 5,
              markLine: sessionOpenIndices.length > 0 ? {
                symbol: 'none', silent: true, label: { show: false },
                lineStyle: { color: '#bbb', width: 1, type: 'dashed' }, z: 1,
                data: sessionOpenIndices.map(function (idx) { return { xAxis: idx }; }),
              } : undefined,
              markPoint: entries.length + exits.length > 0 ? {
                symbol: 'pin', symbolSize: 18, data: entries.concat(exits),
              } : undefined,
            }] : []),
            ...(avgLineXY ? [{
              name: 'avg', type: 'line', data: avgLineXY,
              lineStyle: { width: 1, color: '#444' }, symbol: 'none',
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            ...(stopLineXY ? [{
              name: 'stop', type: 'line', data: stopLineXY,
              lineStyle: { width: 1, color: '#c22', type: 'dashed' }, symbol: 'none',
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
            ...(tpLineXY ? [{
              name: 'tp', type: 'line', data: tpLineXY,
              lineStyle: { width: 1, color: '#057a55', type: 'dashed' }, symbol: 'none',
              silent: true, emphasis: { disabled: true }, z: 8,
            }] : []),
          ],
        });
        return { chart: chart, useCategoryAxis: useCategoryAxis, nearestIndex: nearestIndex, categories: categories, ohlcMs: ohlcMs };
      }

      // 各 panel を build。null (load 失敗) は skip。
      var panels = [];
      for (var i = 0; i < data.charts.length; i += 1) {
        var entry = data.charts[i];
        var built = buildPanel('grid-chart-' + i, entry.chart);
        if (built) panels.push(built);
      }
      // echarts.connect で全 panel の dataZoom / tooltip / legend を同期。
      // Datadog dashboard と同様、1 panel で zoom/pan するだけで他 panel が
      // 連動して同じ時間帯にスクロール。
      var instances = panels.map(function (p) { return p.chart; });
      if (instances.length > 0) echarts.connect(instances);

      // resize 時は全 panel を resize (responsive)
      window.addEventListener('resize', function () {
        for (var i = 0; i < instances.length; i += 1) instances[i].resize();
      });

      // 1 panel の dataZoom event を listen して URL ?from / ?to を更新
      // (個別銘柄タブと同方針)。connect 越しに他 panel の dataZoom も同期し
      // 全 panel が同じイベントを発火しうるが、debounce 200ms でまとめる。
      // 起点 panel は category mode / time mode のどちらでも構わない (同一
      // ms 範囲を URL に書き戻す)。
      function panelDataZoomToMs(panel) {
        var opt = panel.chart.getOption();
        var dz = opt.dataZoom && opt.dataZoom[0];
        if (!dz) return null;
        var sv = dz.startValue, ev = dz.endValue;
        if (sv == null || ev == null) return null;
        if (panel.useCategoryAxis) {
          var sIdx = Math.max(0, Math.min(panel.categories.length - 1, Math.round(sv)));
          var eIdx = Math.max(0, Math.min(panel.categories.length - 1, Math.round(ev)));
          var fromMs = new Date(panel.categories[sIdx]).getTime();
          var toMs = new Date(panel.categories[eIdx]).getTime();
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
          return { fromMs: fromMs, toMs: toMs };
        }
        return { fromMs: sv, toMs: ev };
      }
      var dzTimer = null;
      function onDz() {
        if (dzTimer) clearTimeout(dzTimer);
        dzTimer = setTimeout(function () {
          if (panels.length === 0) return;
          var range = panelDataZoomToMs(panels[0]);
          if (!range) return;
          try {
            var fromIso = new Date(range.fromMs).toISOString();
            var toIso = new Date(range.toMs).toISOString();
            var url = new URL(window.location.href);
            url.searchParams.set('from', fromIso);
            url.searchParams.set('to', toIso);
            window.history.replaceState({}, '', url.toString());
          } catch (e) { /* noop */ }
        }, 200);
      }
      for (var pi2 = 0; pi2 < panels.length; pi2 += 1) {
        panels[pi2].chart.on('dataZoom', onDz);
      }

      // preset zoom buttons (1D/5D/1M/All): 全 panel に dispatchAction で
      // 共通 ms 範囲を broadcast。category mode panel では nearestIndex で
      // index に snap してから dispatch (panel 個別)。connect でも同期するが、
      // panel 毎に category 軸の index が異なるので明示 dispatch が確実。
      var presetButtons = document.querySelectorAll('.zoom-preset');
      for (var pj = 0; pj < presetButtons.length; pj += 1) {
        presetButtons[pj].addEventListener('click', function (ev) {
          var fromMs = Number(ev.currentTarget.getAttribute('data-from-ms'));
          var toMs = Number(ev.currentTarget.getAttribute('data-to-ms'));
          if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return;
          for (var pk = 0; pk < panels.length; pk += 1) {
            var p = panels[pk];
            var sv, eV;
            if (p.useCategoryAxis) {
              sv = p.nearestIndex(fromMs);
              eV = p.nearestIndex(toMs);
              if (sv < 0 || eV < 0) continue;
              if (sv > eV) { var tmp = sv; sv = eV; eV = tmp; }
            } else {
              sv = fromMs; eV = toMs;
            }
            p.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: sv, endValue: eV });
            p.chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: sv, endValue: eV });
          }
        });
      }
    });
  `

  return `<p class="muted" style="font-size:12px">
    ALLOWED_SYMBOLS の全銘柄を 4 列 grid で並列表示 (Datadog dashboard 風)。
    ズーム / パン (slider drag, wheel) と tooltip は全 panel 間で同期します。
    panel 左上の銘柄名をクリックすると個別銘柄タブの詳細表示に遷移。
  </p>
  ${presetButtonsHtml}
  <div class="symbols-grid" style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:8px;margin-top:12px">
    ${panelsHtml}
  </div>
  <style>
    @media (max-width: 1280px) {
      .symbols-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
    }
    @media (max-width: 768px) {
      .symbols-grid { grid-template-columns: 1fr !important; }
    }
  </style>
  ${safeJsonScript('__chartData', payload)}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}

/**
 * grid panel header の右肩に出す軽量 indicators badge (price / SMA50)。
 * 個別銘柄タブの `renderCurrentIndicatorsBadge` の縮小版。
 * 「市場全体ビュー」で trader が「現在価格と SMA50 の位置関係」を一目で
 * 判断するための最小限情報。high20d / low20d / atr は省略 (panel 幅優先)。
 */
function renderGridPanelBadge(chart: SymbolChartData): string {
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  if (!latest) return ''
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  return `<span style="font-size:11px;white-space:nowrap">
    <span class="muted">px:</span> <strong>${esc(fmt(latest.price))}</strong>
    <span class="muted" style="margin-left:6px">SMA50:</span> ${esc(fmt(latest.sma50))}
  </span>`
}

/**
 * PullbackUptrendStrategy の TEST_DEFAULT_RULE と一致 (=コード上の default)。
 * チャートパネルで「default 値から変更されている項目」を ⚠ で flag するための
 * 比較対象。schema 側の default も同値 (pullback_default_*)。
 */
const STRATEGY_DEFAULTS: StrategyParamsSnapshot = {
  stopPct: -0.04,
  takeProfitPct: 0.07,
  timeStopDays: 10,
  pullbackMax: -0.03,
  pullbackMin: -0.06,
  minReturn50d: 0.08,
  requireAboveSma50: true,
  kAtr: 2.0,
}

/**
 * チャート併置の戦略パラメータパネル (#168)。チャート上のラベル
 * (押し目 ×N、stop -4% 等) はオーバーレイ 4 本制限のため限定的なので、
 * 補助情報として全パラメータを一覧表示。default からの変更を ⚠ で強調し
 * 「設定の意図しない残存」(例: pullback_max=0 のデバッグ残骸) に運用者が
 * 気づきやすくする。
 */
export function renderStrategyParamsPanel(p: StrategyParamsSnapshot): string {
  const flag = (current: number | boolean, def: number | boolean): string =>
    current === def ? '' : ' <span class="warn" title="default 値から変更">⚠</span>'
  const pct = (n: number): string =>
    (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
  const rows: Array<{ label: string; current: string; def: string; flag: string }> = [
    {
      label: '損切ライン (stopPct)',
      current: pct(p.stopPct),
      def: pct(STRATEGY_DEFAULTS.stopPct),
      flag: flag(p.stopPct, STRATEGY_DEFAULTS.stopPct),
    },
    {
      label: '利食ライン (takeProfitPct)',
      current: pct(p.takeProfitPct),
      def: pct(STRATEGY_DEFAULTS.takeProfitPct),
      flag: flag(p.takeProfitPct, STRATEGY_DEFAULTS.takeProfitPct),
    },
    {
      label: '時間切れ (timeStopDays)',
      current: `${p.timeStopDays} 営業日`,
      def: `${STRATEGY_DEFAULTS.timeStopDays} 営業日`,
      flag: flag(p.timeStopDays, STRATEGY_DEFAULTS.timeStopDays),
    },
    {
      label: '押し目 上限 (pullbackMax)',
      current: pct(p.pullbackMax),
      def: pct(STRATEGY_DEFAULTS.pullbackMax),
      flag: flag(p.pullbackMax, STRATEGY_DEFAULTS.pullbackMax),
    },
    {
      label: '押し目 下限 (pullbackMin)',
      current: pct(p.pullbackMin),
      def: pct(STRATEGY_DEFAULTS.pullbackMin),
      flag: flag(p.pullbackMin, STRATEGY_DEFAULTS.pullbackMin),
    },
    {
      label: '50日騰落率 閾値 (minReturn50d)',
      current: pct(p.minReturn50d),
      def: pct(STRATEGY_DEFAULTS.minReturn50d),
      flag: flag(p.minReturn50d, STRATEGY_DEFAULTS.minReturn50d),
    },
    {
      label: 'SMA50 上 必須 (requireAboveSma50)',
      current: p.requireAboveSma50 ? 'true' : 'false',
      def: STRATEGY_DEFAULTS.requireAboveSma50 ? 'true' : 'false',
      flag: flag(p.requireAboveSma50, STRATEGY_DEFAULTS.requireAboveSma50),
    },
    {
      label: 'ATR 倍率 (kAtr、サイジング用)',
      current: p.kAtr.toFixed(2),
      def: STRATEGY_DEFAULTS.kAtr.toFixed(2),
      flag: flag(p.kAtr, STRATEGY_DEFAULTS.kAtr),
    },
  ]
  const tbody = rows
    .map(
      (r) =>
        `<tr><th>${esc(r.label)}</th><td>${esc(r.current)}${r.flag}</td><td class="muted">${esc(r.def)}</td></tr>`,
    )
    .join('')
  return `<details open style="margin-top:12px">
    <summary style="cursor:pointer;font-size:13px">戦略パラメータ (PullbackUptrendStrategy) — <span class="muted">⚠ は default から変更されている項目</span></summary>
    <table style="margin-top:8px">
      <thead><tr><th>項目</th><th>現在値</th><th>default</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="muted" style="font-size:11px;margin-top:6px">
      設定変更は <code>UPDATE global_config SET pullback_default_* = ... WHERE id = 'default'</code> で。
      per-symbol override は POC scope では未対応。
    </p>
  </details>`
}

/**
 * dataZoom プリセット (1D / 5D / 1M / All)。TradingView ライクの 1 click ズーム。
 * lastTimestamp 基準で from/to を data-attr に焼き、client 側 click handler で
 * symChart.dispatchAction({ type: 'dataZoom', startValue, endValue }) を発火する。
 * 既存の dataZoom listener が URL を replaceState で更新するので、preset でも
 * URL ?from / ?to が同期される。
 */
export function renderZoomPresetButtons(chart: SymbolChartData | null): string {
  if (!chart || chart.points.length === 0) return ''
  const lastPoint = chart.points[chart.points.length - 1]!
  const lastMs = new Date(lastPoint.timestamp).getTime()
  if (!Number.isFinite(lastMs)) return ''
  const earliestMs = (() => {
    const first = chart.points[0]
    if (!first) return lastMs
    const ms = new Date(first.timestamp).getTime()
    return Number.isFinite(ms) ? ms : lastMs
  })()
  const day = 24 * 3600 * 1000
  const presets: Array<{ label: string; fromMs: number; toMs: number }> = [
    { label: '1D', fromMs: lastMs - 1 * day, toMs: lastMs },
    { label: '5D', fromMs: lastMs - 5 * day, toMs: lastMs },
    { label: '1M', fromMs: lastMs - 30 * day, toMs: lastMs },
    { label: 'All', fromMs: earliestMs, toMs: lastMs },
  ]
  const buttons = presets
    .map(
      (p) =>
        `<button class="zoom-preset" data-from-ms="${p.fromMs}" data-to-ms="${p.toMs}" style="margin-right:6px;padding:3px 10px;font-size:12px;background:#fafafa;border:1px solid #d0d0d5;border-radius:4px;cursor:pointer;color:#1d1d1f">${esc(p.label)}</button>`,
    )
    .join('')
  return `<p style="margin:8px 0 0">${buttons}</p>`
}

/**
 * チャート上に「現在の主要 indicator (price / SMA50 / high20d / low20d / atr20)」
 * を inline badge で表示。trader-strategist 助言で SMA50 を chart line から
 * 撤去 (15m chart の y軸を引き伸ばさないため) した代替表示。最新の cron-eval
 * point から取得し、null は em-dash (—) で fallback。
 */
export function renderCurrentIndicatorsBadge(chart: SymbolChartData | null): string {
  if (!chart) return ''
  // 最新の indicator 付き point を末尾から探す (Yahoo filler は indicators null)
  let latest: SymbolChartPoint | null = null
  for (let i = chart.points.length - 1; i >= 0; i -= 1) {
    const p = chart.points[i]!
    if (p.sma50 !== null || p.high20d !== null || p.low20d !== null) {
      latest = p
      break
    }
  }
  if (!latest) return ''
  const fmt = (v: number | null): string => (v == null ? '—' : v.toFixed(2))
  const items: Array<[string, string]> = [
    ['price', fmt(latest.price)],
    ['SMA50', fmt(latest.sma50)],
    ['high20d', fmt(latest.high20d)],
    ['low20d', fmt(latest.low20d)],
  ]
  const badges = items
    .map(
      ([k, v]) =>
        `<span style="display:inline-block;margin-right:10px;font-size:12px"><span class="muted">${esc(k)}:</span> <strong>${esc(v)}</strong></span>`,
    )
    .join('')
  return `<p style="margin:6px 0 0">${badges}</p>`
}

function renderSymbolPickerForTab(args: ChartsBodySymbol): string {
  if (args.availableSymbols.length === 0) return ''
  // 銘柄切替時にズーム範囲を維持するため、現在の from/to を picker URL に伝搬
  const zoomQs = args.zoom
    ? `&from=${encodeURIComponent(args.zoom.from.toISOString())}&to=${encodeURIComponent(args.zoom.to.toISOString())}`
    : ''
  const opts = args.availableSymbols
    .map(
      (s) =>
        `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(s)}${zoomQs}" style="margin-right:6px;${
          s === args.focusSymbol ? 'font-weight:600;text-decoration:underline' : ''
        }">${esc(s)}</a>`,
    )
    .join('')
  const focusLabel = args.focusSymbol ?? '—'
  return `<p class="muted" style="font-size:12px">
    銘柄: <strong>${esc(focusLabel)}</strong> | 切替: ${opts}
  </p>`
}
