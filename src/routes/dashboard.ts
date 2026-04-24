import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { strategyDecisionLog, tradeJournal } from '../infrastructure/db/schema'
import { desc, eq } from 'drizzle-orm'
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
  .get('/', (c) => c.html(layout('Dashboard', indexBody())))
  .get('/positions', async (c) => {
    if (!c.env.DB || !c.env.SYMBOL_STATE) {
      return c.html(layout('Positions', unavailable('DB or SYMBOL_STATE not bound')))
    }
    const universe = await loadSymbolUniverse(c.env)
    const client = new SymbolStateClient(c.env.SYMBOL_STATE)
    const rows = await Promise.all(
      universe.allowedSymbols.map(async (sym) => {
        try {
          return { sym, state: await client.getState(sym), error: null as string | null }
        } catch (err) {
          return { sym, state: null as SymbolState | null, error: messageOf(err) }
        }
      }),
    )
    return c.html(layout('Positions', positionsBody(rows)))
  })
  .get('/portfolio', async (c) => {
    if (!c.env.PORTFOLIO_STATE) {
      return c.html(layout('Portfolio', unavailable('PORTFOLIO_STATE not bound')))
    }
    try {
      const portfolio = await new PortfolioStateClient(c.env.PORTFOLIO_STATE).getPortfolio()
      return c.html(layout('Portfolio', portfolioBody(portfolio)))
    } catch (err) {
      return c.html(layout('Portfolio', unavailable(messageOf(err))))
    }
  })
  .get('/trades', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('Trades', unavailable('DB not bound')))
    }
    const limit = clampLimit(c.req.query('limit'))
    const db = createDb(c.env.DB)
    const rows = await db.select().from(tradeJournal).orderBy(desc(tradeJournal.id)).limit(limit)
    return c.html(layout('Trades', tradesBody(rows, limit)))
  })
  .get('/config', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('Config', unavailable('DB not bound')))
    }
    const [global, universe] = await Promise.all([
      loadGlobalConfigFrom(c.env),
      loadSymbolUniverse(c.env),
    ])
    return c.html(layout('Config', configBody(global, universe)))
  })
  .get('/cron', async (c) => {
    if (!c.env.DB) {
      return c.html(layout('Cron Decisions', unavailable('DB not bound')))
    }
    const limit = clampLimit(c.req.query('limit'))
    const symbolFilter = c.req.query('symbol')?.toUpperCase().trim() || undefined
    const db = createDb(c.env.DB)
    try {
      const rows = symbolFilter
        ? await db
            .select()
            .from(strategyDecisionLog)
            .where(eq(strategyDecisionLog.symbol, symbolFilter))
            .orderBy(desc(strategyDecisionLog.id))
            .limit(limit)
        : await db
            .select()
            .from(strategyDecisionLog)
            .orderBy(desc(strategyDecisionLog.id))
            .limit(limit)
      return c.html(layout('Cron Decisions', cronBody(rows, limit, symbolFilter)))
    } catch (err) {
      // migration 未適用 / 一時的な D1 エラーで 500 にせず unavailable に落とす
      // (CodeRabbit #132)。段階的デプロイ時の自己保護。
      return c.html(layout('Cron Decisions', unavailable(messageOf(err))))
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
  <a href="/dashboard">Home</a>
  <a href="/dashboard/positions">Positions</a>
  <a href="/dashboard/portfolio">Portfolio</a>
  <a href="/dashboard/trades">Trades</a>
  <a href="/dashboard/config">Config</a>
  <a href="/dashboard/cron">Cron</a>
</nav>
${body}
<div class="footer">rendered at ${esc(fmtJst(new Date()))}</div>
</body>
</html>`
}

function unavailable(reason: string): string {
  return `<p class="warn">unavailable: ${esc(reason)}</p>`
}

function indexBody(): string {
  return `<p>Operator read-only dashboard. 各ページは basic-auth で保護されています。</p>
<ul>
  <li><a href="/dashboard/positions">Positions</a> — 全銘柄の DO 状態 (position / avgPrice / pendingOrder / cooldown)</li>
  <li><a href="/dashboard/portfolio">Portfolio</a> — dailyStartEquity / realized PnL / drawdown / kill-switch</li>
  <li><a href="/dashboard/trades">Trades</a> — trade_journal 直近 (default 50、<code>?limit=N</code> で可変、max 200)</li>
  <li><a href="/dashboard/config">Config</a> — global_config + active symbol_config</li>
  <li><a href="/dashboard/cron">Cron Decisions</a> — strategy_decision_log 直近 (<code>?symbol=SOXL</code> で絞り込み、日本語 reason)</li>
</ul>`
}

function positionsBody(
  rows: Array<{ sym: string; state: SymbolState | null; error: string | null }>,
): string {
  if (rows.length === 0) return `<p class="muted">No active symbols.</p>`
  const tbody = rows
    .map((r) => {
      if (r.error !== null || r.state === null) {
        return `<tr><td>${esc(r.sym)}</td><td colspan="7" class="err">${esc(r.error ?? 'state unavailable')}</td></tr>`
      }
      const s = r.state
      const pos = s.position
      const quote = s.lastQuote
      const pendingSide = s.pendingOrder?.side
      const pnlPct =
        pos !== null && quote !== null && pos.avgPrice > 0
          ? ((quote.price - pos.avgPrice) / pos.avgPrice) * 100
          : null
      const pnlClass = pnlPct === null ? 'muted' : pnlPct >= 0 ? 'ok' : 'err'
      return `<tr>
        <td><strong>${esc(s.symbol)}</strong></td>
        <td>${pos ? esc(pos.qty) : '<span class="muted">-</span>'}</td>
        <td>${pos ? fmtNumber(pos.avgPrice, 2) : '<span class="muted">-</span>'}</td>
        <td>${quote ? fmtNumber(quote.price, 2) : '<span class="muted">-</span>'}</td>
        <td class="${pnlClass}">${pnlPct === null ? '-' : fmtNumber(pnlPct, 2) + '%'}</td>
        <td>${pendingSide ? esc(pendingSide) : '<span class="muted">-</span>'}</td>
        <td>${s.cooldownUntil ? esc(fmtJst(s.cooldownUntil)) : '<span class="muted">-</span>'}</td>
        <td class="muted">${esc(fmtJst(s.updatedAt))}</td>
      </tr>`
    })
    .join('')
  return `<table>
    <thead><tr>
      <th>Symbol</th><th>Qty</th><th>Avg</th><th>Quote</th><th>PnL</th>
      <th>Pending</th><th>Cooldown</th><th>Updated</th>
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
      <tr><th>dailyStartEquity</th><td>${fmtNumber(p.dailyStartEquity, 2)}</td></tr>
      <tr><th>dailyRealizedPnl</th><td class="${ddClass}">${fmtNumber(p.dailyRealizedPnl, 2)}</td></tr>
      <tr><th>drawdown</th><td class="${ddClass}">${drawdownPct === null ? '-' : fmtNumber(drawdownPct, 2) + '%'}</td></tr>
      <tr><th>tradingDisabledUntil</th><td>${kill ? `<span class="warn">${esc(fmtJst(kill))}</span>` : '<span class="ok">active</span>'}</td></tr>
      <tr><th>updatedAt</th><td class="muted">${esc(fmtJst(p.updatedAt))}</td></tr>
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
    return `<p class="muted">No trade_journal rows. (limit=${limit})</p>`
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
      const statusText =
        r.errorMessage ? `ERR: ${r.errorMessage}` : r.brokerStatus ?? r.tradeEventType
      return `<tr>
        <td>${r.id}</td>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td>${esc(r.tradeEventType)}</td>
        <td><strong>${esc(r.symbol ?? '-')}</strong></td>
        <td>${esc(r.side ?? '-')}</td>
        <td>${r.quantity === null ? '-' : esc(r.quantity)}</td>
        <td>${r.limitPrice === null ? '-' : fmtNumber(r.limitPrice, 2)}</td>
        <td>${r.filledQty === null ? '-' : esc(r.filledQty)}</td>
        <td>${r.filledPrice === null ? '-' : fmtNumber(r.filledPrice, 2)}</td>
        <td class="${statusClass}">${esc(statusText)}</td>
        <td>${esc(r.mode ?? '-')}</td>
      </tr>`
    })
    .join('')
  return `<p class="muted">Showing ${rows.length} rows (limit=${limit}, max 200).</p>
  <table>
    <thead><tr>
      <th>id</th><th>timestamp</th><th>event</th><th>symbol</th><th>side</th>
      <th>qty</th><th>limit</th><th>fill qty</th><th>fill px</th><th>status</th><th>mode</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}

function configBody(
  global: Awaited<ReturnType<typeof loadGlobalConfigFrom>>,
  universe: Awaited<ReturnType<typeof loadSymbolUniverse>>,
): string {
  const globalRows = Object.entries(global as unknown as Record<string, unknown>)
    .filter(([k]) => k !== 'source')
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(formatConfigValue(v))}</td></tr>`)
    .join('')
  const symRows = universe.allowedSymbols
    .map(
      (sym) =>
        `<tr>
          <td><strong>${esc(sym)}</strong></td>
          <td>${esc(universe.symbolCurrency[sym] ?? '-')}</td>
          <td>${universe.symbolMaxNotional[sym] ? esc(universe.symbolMaxNotional[sym]) : '<span class="muted">-</span>'}</td>
          <td>${universe.inversePairs[sym] ? esc(universe.inversePairs[sym]) : '<span class="muted">-</span>'}</td>
        </tr>`,
    )
    .join('')
  return `<details open>
    <summary>global_config</summary>
    <table><tbody>${globalRows}</tbody></table>
  </details>
  <details open>
    <summary>symbol_config (active=1) — ${universe.allowedSymbols.length} symbols</summary>
    <table>
      <thead><tr><th>symbol</th><th>currency</th><th>max_notional</th><th>inverse</th></tr></thead>
      <tbody>${symRows}</tbody>
    </table>
  </details>`
}

function formatConfigValue(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/**
 * Strategy / sizing が出力する英語 reason を日本語に翻訳する display helper。
 * ログ DB には英語のまま保存し、表示時のみ翻訳 (テスト互換性を崩さない)。
 * 動的数値はそのまま残すため正規表現で置換。
 */
function localizeReason(en: string | null | undefined): string {
  if (!en) return '-'
  let s = en
  // Strategy signal.reason パターン
  s = s.replace(/^pending order in flight$/, '発注中 (lock 保持)')
  s = s.replace(/^cooldown active until (.+)$/, 'クールダウン中 ($1 まで)')
  s = s.replace(/^take-profit hit: pnl (\S+) >= (\S+)$/, '利確到達 (pnl $1 ≥ $2)')
  s = s.replace(/^stop-loss hit: pnl (\S+) <= (\S+)$/, '損切到達 (pnl $1 ≤ $2)')
  s = s.replace(/^time-stop hit: held (\S+) >= (\S+)$/, '時間切れ (保有 $1 ≥ $2)')
  s = s.replace(/^holding: pnl (\S+) within \(([^)]+)\)$/, '保有継続 (pnl $1、範囲 $2)')
  s = s.replace(/^50d return (\S+) <= (\S+) trend threshold$/, '50日 return $1 が閾値 $2 未満 (uptrend 不成立)')
  s = s.replace(/^price (\S+) <= sma50 (\S+)$/, '価格 $1 が SMA50 $2 以下 (uptrend 不成立)')
  s = s.replace(/^invalid 20d high$/, '20日高値が無効')
  s = s.replace(/^pullback (\S+) > (\S+) \(not deep enough\)$/, '押し目 $1 が浅すぎ (閾値 $2)')
  s = s.replace(/^pullback (\S+) < (\S+) \(too deep\)$/, '押し目 $1 が深すぎ (閾値 $2)')
  s = s.replace(/^pullback (\S+) in uptrend \(50d return (\S+)\)$/, '押し目 $1、uptrend 継続 (50日 return $2)')
  // Sizing capReason
  s = s.replace(/^sizing rejected: lot-size-round$/, 'サイジング拒否: ロット丸め後に最小取引単位未満')
  s = s.replace(/^sizing rejected: insufficient-risk-budget$/, 'サイジング拒否: リスク予算不足')
  s = s.replace(/^sizing rejected: atr-floor$/, 'サイジング拒否: ATR floor (vol 崩壊)')
  s = s.replace(/^sizing rejected: symbol-cap$/, 'サイジング拒否: 銘柄別 notional cap 超過')
  s = s.replace(/^sizing rejected: invalid-stop$/, 'サイジング拒否: stop 距離が無効')
  s = s.replace(/^sizing rejected: zero qty$/, 'サイジング拒否: qty が 0')
  // Scheduler inline
  s = s.replace(/^SELL without position$/, 'SELL 対象ポジションなし')
  s = s.replace(/^insufficient bars for indicators$/, 'bar 本数不足 (indicator 計算不能)')
  s = s.replace(/^pending order already in flight$/, '発注中 (pending lock 競合)')
  s = s.replace(/^invalid price: (\S+)$/, '価格が無効 ($1)')
  s = s.replace(/^invalid notional:/, 'notional が無効:')
  s = s.replace(/^invalid position qty: (\S+)$/, 'ポジション qty が無効 ($1)')
  s = s.replace(/^invalid expiresAt/, 'expiresAt が無効')
  s = s.replace(/^bar fetch: /, 'bar 取得失敗: ')
  s = s.replace(/^broker submit error: /, 'broker 送信エラー: ')
  // Bucket gate
  s = s.replace(/^bucket cap: (\S+) projected (\S+) > (\S+)$/, 'バケット cap: $1 合計 $2 が上限 $3 を超過')
  s = s.replace(/^bucket cap: (\S+) cap (\S+) <= 0$/, 'バケット cap: $1 の cap ($2) が 0 以下')
  s = s.replace(/^bucket cap: (\S+) invalid addNotional (\S+)$/, 'バケット cap: $1 の addNotional ($2) が無効')
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
  }>,
  limit: number,
  symbolFilter: string | undefined,
): string {
  const header = symbolFilter
    ? `<p class="muted">Showing ${rows.length} decisions for <strong>${esc(symbolFilter)}</strong> (limit=${limit}, max 200)。<a href="/dashboard/cron">全銘柄へ戻る</a></p>`
    : `<p class="muted">Showing ${rows.length} decisions (limit=${limit}, max 200)。<code>?symbol=SOXL</code> で絞り込み可能。</p>`
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
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td><a href="/dashboard/cron?symbol=${encodeURIComponent(r.symbol)}"><strong>${esc(r.symbol)}</strong></a></td>
        <td class="${cls}">${esc(r.decision)}</td>
        <td>${esc(localizeReason(r.reason))}</td>
        <td>${r.price === null ? '-' : fmtNumber(r.price, 2)}</td>
      </tr>`
    })
    .join('')
  return `${header}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>symbol</th><th>decision</th><th>reason</th><th>price</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>`
}
