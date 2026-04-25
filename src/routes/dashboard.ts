import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { strategyDecisionLog, tradeJournal } from '../infrastructure/db/schema'
import { and, asc, desc, eq } from 'drizzle-orm'
import { PortfolioStateClient } from '../trading/state/PortfolioStateClient'
import { SymbolStateClient } from '../trading/state/SymbolStateClient'
import type { SymbolState } from '../trading/state/types'

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
      const [equity, decisions, pnls] = await Promise.all([
        loadEquityCurve(c.env.DB),
        loadDecisionBreakdown(c.env.DB),
        loadTradePnls(c.env.DB),
      ])
      const stats = computeTradeStats(pnls)
      const histogram = computePnlHistogram(pnls)
      return c.html(layout('チャート', chartsBody({ equity, decisions, pnls, stats, histogram })))
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
  <li><a href="/dashboard/charts">チャート</a> — エクイティカーブ / ドローダウン (Phase 0+1)、以降のチャートは <a href="https://github.com/ochanuco/webull-trading/issues/158">#158</a> で順次追加</li>
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
  updatedAt: string
}): string {
  const drawdownPct =
    p.dailyStartEquity > 0 ? (p.dailyRealizedPnl / p.dailyStartEquity) * 100 : null
  const ddClass = drawdownPct === null ? 'muted' : drawdownPct >= 0 ? 'ok' : 'err'
  const kill = p.tradingDisabledUntil
  return `<table>
    <tbody>
      <tr><th>当日始値資産 (dailyStartEquity)</th><td>${fmtNumber(p.dailyStartEquity, 2)}</td></tr>
      <tr><th>当日実現損益 (dailyRealizedPnl)</th><td class="${ddClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</td></tr>
      <tr><th>ドローダウン (drawdown)</th><td class="${ddClass}">${drawdownPct === null ? '—' : fmtNumber(drawdownPct, 2) + '%'}</td></tr>
      <tr><th>取引停止解除時刻 (tradingDisabledUntil)</th><td>${kill ? `<span class="warn">${esc(fmtJst(kill))}</span>` : '<span class="ok">稼働中</span>'}</td></tr>
      <tr><th>更新時刻 (updatedAt)</th><td class="muted">${esc(fmtJst(p.updatedAt))}</td></tr>
    </tbody>
  </table>`
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
 * `<script>...</script>` 内に埋め込む JSON を XSS 安全にする。
 * ブラウザは `</script>` を「文字列の中でも」script 終端と解釈するので、
 * `<` を unicode escape して中和する。
 */
export function safeJsonScript(varName: string, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script>window.${varName} = ${json};</script>`
}

interface ChartsViewModel {
  equity: EquityPoint[]
  decisions: DecisionBreakdownPoint[]
  pnls: number[]
  stats: TradeStats
  histogram: PnlHistogramBin[]
}

function chartsBody(args: ChartsViewModel): string {
  if (args.equity.length === 0 && args.decisions.length === 0) {
    return `<p class="muted">まだ判定ログも実 fill も無いためチャートを描けません。最初の cron 実行 / SELL 約定後に表示されます。</p>`
  }
  // インライン script の defer 属性は HTML 仕様で無視される (defer は src 必須)。
  // 同期実行されると外部 ECharts (defer 付) より前に走り常に「未読込」になるため、
  // DOMContentLoaded を待つ。defer 付き外部 script は DOMContentLoaded 前に
  // 実行完了するので、このタイミングで echarts は確実に利用可能。
  const initScript = `
    document.addEventListener('DOMContentLoaded', function () {
      if (typeof echarts === 'undefined') {
        var el = document.getElementById('chart-status');
        if (el) el.textContent = 'ECharts CDN を読み込めませんでした (ネットワーク or CSP 確認)';
        return;
      }
      var data = window.__chartData;
      var dates = data.equity.map(function (p) { return p.date; });
      var equity = data.equity.map(function (p) { return p.cumulativePnl; });
      var dd = data.equity.map(function (p) { return p.drawdownPct * 100; });

      // ---- decision breakdown stacked bar (#158 Phase 2) ----
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
            return {
              name: k,
              type: 'bar',
              stack: 'decisions',
              data: data.decisions.map(function (p) { return p.counts[k] || 0; }),
              itemStyle: { color: DECISION_COLORS[k] },
            };
          }),
        });
        window.addEventListener('resize', function () { dbChart.resize(); });
      }

      // ---- PnL 分布 histogram (#158 Phase 3) ----
      var pnlHistEl = document.getElementById('pnl-hist-chart');
      if (pnlHistEl && data.histogram && data.histogram.length > 0) {
        var pnlHist = echarts.init(pnlHistEl);
        pnlHist.setOption({
          title: { text: 'Per-trade realized PnL 分布', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'shadow' },
            formatter: function (params) {
              var p = params[0];
              return p.name + ': ' + p.value + ' trades';
            },
          },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: data.histogram.map(function (b) { return b.label; }) },
          yAxis: { type: 'value', name: 'trades' },
          series: [{
            type: 'bar',
            data: data.histogram.map(function (b) {
              return { value: b.count, itemStyle: { color: b.binCenter >= 0 ? '#057a55' : '#c22' } };
            }),
          }],
        });
        window.addEventListener('resize', function () { pnlHist.resize(); });
      }

      var equityEl = document.getElementById('equity-chart');
      var ddEl = document.getElementById('dd-chart');
      if (equityEl && ddEl && data.equity.length > 0) {
        var equityChart = echarts.init(equityEl);
        equityChart.setOption({
          title: { text: '累積 realized PnL', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2); } },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: dates },
          yAxis: { type: 'value', name: 'PnL', axisLabel: { formatter: '{value}' } },
          series: [{ type: 'line', data: equity, smooth: false, areaStyle: { opacity: 0.1 }, lineStyle: { width: 2 } }],
        });

        var ddChart = echarts.init(ddEl);
        ddChart.setOption({
          title: { text: 'ドローダウン (累積 PnL の peak からの低下率)', left: 'center', textStyle: { fontSize: 14 } },
          tooltip: { trigger: 'axis', valueFormatter: function (v) { return Number(v).toFixed(2) + '%'; } },
          grid: { left: 50, right: 20, top: 40, bottom: 40 },
          xAxis: { type: 'category', data: dates },
          yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
          series: [
            { type: 'line', data: dd, areaStyle: { color: '#c22', opacity: 0.2 }, lineStyle: { color: '#c22', width: 1 } },
          ],
        });

        window.addEventListener('resize', function () {
          equityChart.resize();
          ddChart.resize();
        });
      }
    });
  `
  return `<p class="muted" style="font-size:12px">
    累積 realized PnL と peak からの下落率 (MaxDD)。戦略の長期パフォーマンス指標。
    シード資金額を保持していないため下落率は「累積 PnL の peak からの相対」で計算
    (peak ≤ 0 のときは 0%)。当日 intraday の risk halt 閾値 (drawdown_kill /
    risk_dd_halt) は別概念のため重畳しない。
    残りのチャート (decision breakdown / PnL 分布 / 銘柄チャート) は
    <a href="https://github.com/ochanuco/webull-trading/issues/158">#158</a> で順次追加。
  </p>
  <div id="equity-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  <div id="dd-chart" style="width:100%;height:280px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  <div id="decision-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  <div id="pnl-hist-chart" style="width:100%;height:320px;background:#fff;border:1px solid #d0d0d5;border-radius:6px;margin-top:12px"></div>
  ${renderTradeStatsTable(args.stats)}
  <p id="chart-status" class="warn" style="font-size:12px;margin-top:8px"></p>
  ${safeJsonScript('__chartData', args)}
  <script src="${ECHARTS_CDN}" defer></script>
  <script>${initScript}</script>`
}
