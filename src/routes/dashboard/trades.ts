import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { type TradeJournalRow, tradeJournal } from '../../infrastructure/db/schema'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { and, desc, eq, inArray, isNotNull, lt, or, type SQL } from 'drizzle-orm'
import { formatRealizedPnl } from './cron'
import { LOG_COPY_ALL_BTN, clampLimit, displaySymbol, esc, exportMeta, fmtJstCompactCell, fmtNumber, inactiveTooltip, isSymbolInactive, logCopyRowBtn, parseCursor, renderLogCopyScript, renderPaginationNav, safeJsonScript } from './shared'

// `cls` names an event-type color utility declared in this page's own <style>
// block (below) — decision/fill/exit reuse the foundation's muted/ok/warn
// text tokens, order-lifecycle events (intent/pre_submit/post_submit) get a
// page-local `.evt-order` since no foundation token means "in-flight order".
const TRADE_EVENT_LABELS: Record<string, { ja: string; cls: string }> = {
  decision: { ja: '判定', cls: 'muted' },
  intent: { ja: '注文作成', cls: 'evt-order' },
  pre_submit: { ja: '送信記録', cls: 'evt-order' },
  post_submit: { ja: '送信応答', cls: 'evt-order' },
  fill: { ja: '約定', cls: 'ok' },
  exit: { ja: '手仕舞い', cls: 'warn' },
}

export const BROKER_ERROR_LABELS: Record<string, string> = {
  OAUTH_OPENAPI_TICKER_IS_DENY: '銘柄取扱なし',
  OAUTH_OPENAPI_SELL_QTY_EXCEED_AVAILABLE_QTY: '売却数量超過',
  OAUTH_OPENAPI_PARAM_ERR: 'パラメータ不正',
  INVALID_TOKEN: 'トークン無効',
}

export function extractBrokerErrorCode(message: string): string | null {
  const fromJson = message.match(/"error_code"\s*:\s*"([A-Z0-9_]+)"/)
  if (fromJson) return fromJson[1]!
  const bare = message.match(/\b([A-Z][A-Z0-9_]{6,})\b/)
  return bare ? bare[1]! : null
}

/** Shared query-parsing result for the SSR page and its JSON export. */
export interface TradesQuery {
  view: 'all' | 'fills' | 'errors'
  symbol?: string
  clientOrderId?: string
  limit: number
  before?: number
}

// Single parse point for SSR and /json: parsing the query separately in each would let the
// screen's filter and the JSON's filter drift apart.
export function parseTradesQuery(query: (key: string) => string | undefined): TradesQuery {
  const view = ((v) => (v === 'fills' || v === 'errors' ? v : 'all'))(query('view'))
  const out: TradesQuery = { view, limit: clampLimit(query('limit')) }
  const symbol = query('symbol')?.toUpperCase().trim()
  if (symbol) out.symbol = symbol
  const clientOrderId = query('clientOrderId')?.trim()
  if (clientOrderId) out.clientOrderId = clientOrderId
  const before = parseCursor(query('before'))
  if (before !== undefined) out.before = before
  return out
}

/** Shared by SSR and JSON export; SSR passes `limit + 1` and pops the extra row to detect `hasMore`. */
export async function loadTradeJournalRows(
  db: ReturnType<typeof createDb>,
  q: TradesQuery,
): Promise<TradeJournalRow[]> {
  const baseQuery = db.select().from(tradeJournal)
  const conditions: SQL[] = []
  if (q.view === 'fills') {
    conditions.push(inArray(tradeJournal.tradeEventType, ['fill', 'exit']))
  } else if (q.view === 'errors') {
    conditions.push(or(isNotNull(tradeJournal.errorMessage), isNotNull(tradeJournal.errorClass))!)
  }
  if (q.symbol) {
    conditions.push(eq(tradeJournal.symbol, q.symbol))
  }
  if (q.clientOrderId) {
    conditions.push(eq(tradeJournal.clientOrderId, q.clientOrderId))
  }
  if (q.before !== undefined) {
    conditions.push(lt(tradeJournal.id, q.before))
  }
  const filtered = conditions.length > 0
    ? baseQuery.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    : baseQuery
  return filtered.orderBy(desc(tradeJournal.id)).limit(q.limit)
}

// rows are raw trade_journal rows, including fields the SSR table omits — the `filter` envelope
// (mirroring the SSR filter banner) tells the reader whether this is the whole table or a subset.
export function buildTradesPacket(rows: TradeJournalRow[], q: TradesQuery) {
  return {
    ...exportMeta('dashboard_trades_export.v1'),
    filter: {
      view: q.view,
      symbol: q.symbol ?? null,
      clientOrderId: q.clientOrderId ?? null,
      limit: q.limit,
      before: q.before ?? null,
    },
    rowCount: rows.length,
    rows,
  }
}

// Page-local utilities not worth promoting to the shared STYLE: `.evt-order`
// has no foundation token (no existing color means "order in flight"), and
// `.small` bumps the log tables' secondary link/meta text from the old 11px
// up to the 12px operator-mandated readability floor.
const TRADES_PAGE_STYLE = `<style>
  .evt-order{color:var(--info)}
  .small{font-size:12px}
</style>`

export function tradesBody(
  rows: TradeJournalRow[],
  limit: number,
  universe?: SymbolUniverse | null,
  view: 'all' | 'fills' | 'errors' = 'all',
  before?: number,
  hasMore = false,
  filters: { symbol?: string; clientOrderId?: string } = {},
): string {
  const filterQs =
    (filters.symbol ? `&symbol=${encodeURIComponent(filters.symbol)}` : '') +
    (filters.clientOrderId ? `&clientOrderId=${encodeURIComponent(filters.clientOrderId)}` : '')
  const viewPill = (label: string, v: string, active: boolean): string =>
    `<a href="/dashboard/trades?view=${v}&limit=${limit}${filterQs}"${active ? ' class="active"' : ''}>${esc(label)}</a>`
  const filterBanner = filters.clientOrderId
    ? `<p class="filter-banner">注文 <code>${esc(filters.clientOrderId)}</code> の履歴のみ表示。<a href="/dashboard/cron?clientOrderId=${encodeURIComponent(filters.clientOrderId)}">判定を見る</a> / <a href="/dashboard/trades">全件へ戻る</a></p>`
    : filters.symbol
      ? `<p class="filter-banner">銘柄 <strong>${esc(displaySymbol(filters.symbol, universe))}</strong> のみ表示。<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(filters.symbol)}">チャートで見る</a> / <a href="/dashboard/cron?symbol=${encodeURIComponent(filters.symbol)}">判定を見る</a> / <a href="/dashboard/trades">全件へ戻る</a></p>`
      : ''
  // Carries the current filter into the JSON link so it opens the same subset as the screen.
  const jsonHref = `/dashboard/trades/json?view=${view}&limit=${limit}${filterQs}${before !== undefined ? `&before=${before}` : ''}`
  const jsonLink = `<a href="${esc(jsonHref)}" target="_blank" rel="noreferrer" class="chip">JSON を開く</a>`
  const cardActions = `<div class="seg">${viewPill('全イベント', 'all', view === 'all')}${viewPill('約定・手仕舞い', 'fills', view === 'fills')}${viewPill('エラー', 'errors', view === 'errors')}</div>
    <span class="muted small">${rows.length} 件 (limit=${limit})</span>${rows.length > 0 ? LOG_COPY_ALL_BTN : ''}${jsonLink}`
  const cardHead = `<div class="card-head"><h2 class="card-title">約定履歴</h2><div class="card-actions">${cardActions}</div></div>`
  if (rows.length === 0) {
    return `<div class="card">${cardHead}${filterBanner}<p class="empty">該当するレコードがありません。</p></div>`
  }
  const tbody = rows
    .map((r) => {
      const ev = TRADE_EVENT_LABELS[r.tradeEventType] ?? { ja: r.tradeEventType, cls: 'muted' }
      const eventCell = `<span title="${esc(r.tradeEventType)}" class="${ev.cls}" style="font-weight:600">● ${esc(ev.ja)}</span>`
      const symbolText = r.symbol ? displaySymbol(r.symbol, universe) : null
      const inactive = r.symbol ? isSymbolInactive(r.symbol, universe) : false
      // Ticker only in the cell; the full display name (e.g. "VUG-Vanguard Growth Index Fund
      // ETF Shares") would blow out this no-wrap column and break the table layout, so it (and
      // the inactive note) go in the hover title instead.
      const symbolTitle = r.symbol
        ? inactive
          ? `${symbolText} — ${inactiveTooltip(r.symbol, universe)}`
          : (symbolText ?? r.symbol)
        : ''
      const symbolCell = r.symbol
        ? `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}" title="${esc(symbolTitle)}"><strong${inactive ? ' class="symbol-disabled"' : ''}>${esc(r.symbol)}</strong></a> <a href="/dashboard/trades?symbol=${encodeURIComponent(r.symbol)}" class="muted small" title="この銘柄の約定だけに絞り込み">▼</a>`
        : '<span class="muted">—</span>'
      const decisionLink = r.clientOrderId
        ? ` <a href="/dashboard/cron?clientOrderId=${encodeURIComponent(r.clientOrderId)}" class="muted small" title="この注文の判定 (戦略判定ログ) を見る">判定→</a>`
        : ''
      const sideCell =
        r.side === 'BUY'
          ? `<span class="pill buy">買</span> <span class="muted small">BUY</span>`
          : r.side === 'SELL'
            ? `<span class="pill sell">売</span> <span class="muted small">SELL</span>`
            : '<span class="muted">—</span>'
      const qtyCell =
        r.filledQty !== null && r.quantity !== null && r.filledQty !== r.quantity
          ? `${esc(r.quantity)} → <strong>${esc(r.filledQty)}</strong>`
          : r.filledQty !== null
            ? `${esc(r.filledQty)}`
            : r.quantity !== null
              ? `${esc(r.quantity)}`
              : '—'
      const priceCell =
        r.filledPrice !== null
          ? fmtNumber(r.filledPrice, 2)
          : r.limitPrice !== null
            ? `<span class="muted" title="指値 (未約定)">指 ${fmtNumber(r.limitPrice, 2)}</span>`
            : '—'
      const pnlCell =
        r.realizedPnl !== null
          ? `${formatRealizedPnl(r.realizedPnl)}${r.exitReason ? ` <span class="muted small">${esc(r.exitReason)}</span>` : ''}`
          : '<span class="muted">—</span>'
      // Raw enum values are kept in title/details (not fully translated) so they stay
      // grep-able against the broker API's own error/status strings.
      let statusCell: string
      const errorText = r.errorMessage ?? r.errorClass
      if (errorText) {
        const code = extractBrokerErrorCode(errorText)
        const short = code ? (BROKER_ERROR_LABELS[code] ?? code) : (r.errorClass ?? 'エラー')
        statusCell = `<span class="pill err">エラー: ${esc(short)}</span>
          <details style="margin-top:2px"><summary class="muted small">全文</summary><code class="small" style="white-space:pre-wrap;word-break:break-all">${esc(errorText)}</code></details>`
      } else if (r.brokerStatus === 'FILLED') {
        statusCell = `<span class="pill ok">約定</span>`
      } else if (r.brokerStatus) {
        statusCell = `<span class="pill warn" title="${esc(r.brokerStatus)}">${esc(r.brokerStatus)}</span>`
      } else {
        statusCell = '<span class="muted">—</span>'
      }
      const modeCell =
        r.mode === 'LIVE'
          ? `<span class="pill err">実発注</span>`
          : r.mode === 'DRY_RUN'
            ? `<span class="pill neutral">DRY</span>`
            : '<span class="muted">—</span>'
      return `<tr>
        <td>${logCopyRowBtn(r.id)}</td>
        <td class="muted">${fmtJstCompactCell(r.timestamp)}</td>
        <td>${eventCell}${decisionLink}</td>
        <td>${symbolCell}</td>
        <td>${sideCell}</td>
        <td class="num">${qtyCell}</td>
        <td class="num">${priceCell}</td>
        <td class="num">${pnlCell}</td>
        <td class="grow">${statusCell}</td>
        <td>${modeCell}</td>
      </tr>`
    })
    .join('')
  return `${TRADES_PAGE_STYLE}<div class="card">${cardHead}${filterBanner}
  <div class="tablewrap">
  <table class="fit">
    <thead><tr>
      <th></th><th>日時 (JST)</th><th>イベント</th><th>銘柄</th><th>売買</th>
      <th class="num">数量</th><th class="num">単価</th><th class="num">実現損益</th>
      <th class="grow">状態</th><th>モード</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  </div>
  ${renderPaginationNav({
    baseHref: `/dashboard/trades?view=${view}&limit=${limit}${filterQs}`,
    before,
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id : undefined,
    hasMore,
  })}
  ${safeJsonScript('__tradesCopy', {
    meta: {
      page: 'trade_journal (約定履歴)',
      filter: `view=${view}, limit=${limit}${filters.symbol ? `, symbol=${filters.symbol}` : ''}${filters.clientOrderId ? `, clientOrderId=${filters.clientOrderId}` : ''}`,
      generatedAt: new Date().toISOString(),
    },
    rows,
  })}
  ${renderLogCopyScript('__tradesCopy')}</div>`
}
