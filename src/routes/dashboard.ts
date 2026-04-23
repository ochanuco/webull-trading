import { Hono } from 'hono'
import type { AppBindings } from '../app'
import { loadGlobalConfigFrom } from '../infrastructure/db/globalConfigLoader'
import { loadSymbolUniverse } from '../infrastructure/db/symbolUniverse'
import { createDb } from '../infrastructure/db/tradeJournalRepo'
import { tradeJournal } from '../infrastructure/db/schema'
import { desc } from 'drizzle-orm'
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
</nav>
${body}
<div class="footer">rendered at ${esc(new Date().toISOString())}</div>
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
        <td>${s.cooldownUntil ? esc(s.cooldownUntil) : '<span class="muted">-</span>'}</td>
        <td class="muted">${esc(s.updatedAt)}</td>
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
      <tr><th>tradingDisabledUntil</th><td>${kill ? `<span class="warn">${esc(kill)}</span>` : '<span class="ok">active</span>'}</td></tr>
      <tr><th>updatedAt</th><td class="muted">${esc(p.updatedAt)}</td></tr>
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
        <td class="muted">${esc(r.timestamp)}</td>
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
