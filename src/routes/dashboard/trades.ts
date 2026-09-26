import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import { type TradeJournalRow, tradeJournal } from '../../infrastructure/db/schema'
import { createDb } from '../../infrastructure/db/tradeJournalRepo'
import { and, desc, eq, inArray, isNotNull, lt, or, type SQL } from 'drizzle-orm'
import { formatRealizedPnl } from './cron'
import { LOG_COPY_ALL_BTN, clampLimit, displaySymbol, esc, exportMeta, fmtJst, fmtNumber, inactiveTooltip, isSymbolInactive, logCopyRowBtn, parseCursor, renderLogCopyScript, renderPaginationNav, safeJsonScript } from './shared'

const TRADE_EVENT_LABELS: Record<string, { ja: string; color: string }> = {
  decision: { ja: '判定', color: '#86868b' },
  intent: { ja: '注文作成', color: '#46608a' },
  pre_submit: { ja: '送信記録', color: '#46608a' },
  post_submit: { ja: '送信応答', color: '#46608a' },
  fill: { ja: '約定', color: '#057a55' },
  exit: { ja: '手仕舞い', color: '#b25000' },
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
    `<a href="/dashboard/trades?view=${v}&limit=${limit}${filterQs}" class="chip${active ? ' active' : ''}" style="margin-right:6px">${esc(label)}</a>`
  const filterBanner = filters.clientOrderId
    ? `<p class="filter-banner">注文 <code>${esc(filters.clientOrderId)}</code> の履歴のみ表示。<a href="/dashboard/cron?clientOrderId=${encodeURIComponent(filters.clientOrderId)}">判定を見る</a> / <a href="/dashboard/trades">全件へ戻る</a></p>`
    : filters.symbol
      ? `<p class="filter-banner">銘柄 <strong>${esc(displaySymbol(filters.symbol, universe))}</strong> のみ表示。<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(filters.symbol)}">チャートで見る</a> / <a href="/dashboard/cron?symbol=${encodeURIComponent(filters.symbol)}">判定を見る</a> / <a href="/dashboard/trades">全件へ戻る</a></p>`
      : ''
  // Carries the current filter into the JSON link so it opens the same subset as the screen.
  const jsonHref = `/dashboard/trades/json?view=${view}&limit=${limit}${filterQs}${before !== undefined ? `&before=${before}` : ''}`
  const jsonLink = `<a href="${esc(jsonHref)}" target="_blank" rel="noreferrer" class="chip" style="margin-left:4px">JSON を開く</a>`
  const pills = `<nav style="margin-bottom:10px;display:flex;align-items:center;flex-wrap:wrap;gap:2px">${viewPill('全イベント', 'all', view === 'all')}${viewPill('約定・手仕舞い', 'fills', view === 'fills')}${viewPill('エラー', 'errors', view === 'errors')}<span class="muted" style="font-size:12px;margin:0 8px">${rows.length} 件 (limit=${limit})</span>${rows.length > 0 ? LOG_COPY_ALL_BTN : ''}${jsonLink}</nav>`
  if (rows.length === 0) {
    return `${filterBanner}${pills}<p class="muted">該当するレコードがありません。</p>`
  }
  const tbody = rows
    .map((r) => {
      const ev = TRADE_EVENT_LABELS[r.tradeEventType] ?? { ja: r.tradeEventType, color: '#86868b' }
      const eventCell = `<span title="${esc(r.tradeEventType)}" style="color:${ev.color};font-weight:600">● ${esc(ev.ja)}</span>`
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
        ? `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}" title="${esc(symbolTitle)}" style="text-decoration:none"><strong${inactive ? ' class="symbol-disabled"' : ''}>${esc(r.symbol)}</strong></a> <a href="/dashboard/trades?symbol=${encodeURIComponent(r.symbol)}" class="muted" title="この銘柄の約定だけに絞り込み" style="font-size:11px;text-decoration:none">▼</a>`
        : '<span class="muted">—</span>'
      const decisionLink = r.clientOrderId
        ? ` <a href="/dashboard/cron?clientOrderId=${encodeURIComponent(r.clientOrderId)}" class="muted" title="この注文の判定 (戦略判定ログ) を見る" style="font-size:11px">判定→</a>`
        : ''
      const sideCell =
        r.side === 'BUY'
          ? `<span class="ok" style="font-weight:700">買</span> <span class="muted" style="font-size:11px">BUY</span>`
          : r.side === 'SELL'
            ? `<span class="err" style="font-weight:700">売</span> <span class="muted" style="font-size:11px">SELL</span>`
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
          ? `${formatRealizedPnl(r.realizedPnl)}${r.exitReason ? ` <span class="muted" style="font-size:11px">${esc(r.exitReason)}</span>` : ''}`
          : '<span class="muted">—</span>'
      // Raw enum values are kept in title/details (not fully translated) so they stay
      // grep-able against the broker API's own error/status strings.
      let statusCell: string
      const errorText = r.errorMessage ?? r.errorClass
      if (errorText) {
        const code = extractBrokerErrorCode(errorText)
        const short = code ? (BROKER_ERROR_LABELS[code] ?? code) : (r.errorClass ?? 'エラー')
        statusCell = `<span class="pill err">エラー: ${esc(short)}</span>
          <details style="margin-top:2px"><summary class="muted" style="font-size:11px;cursor:pointer">全文</summary><code style="font-size:11px;white-space:pre-wrap;word-break:break-all">${esc(errorText)}</code></details>`
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
        <td class="muted" style="white-space:nowrap">${esc(fmtJst(r.timestamp))}</td>
        <td style="white-space:nowrap">${eventCell}${decisionLink}</td>
        <td>${symbolCell}</td>
        <td style="white-space:nowrap">${sideCell}</td>
        <td class="num">${qtyCell}</td>
        <td class="num">${priceCell}</td>
        <td class="num">${pnlCell}</td>
        <td class="grow">${statusCell}</td>
        <td>${modeCell}</td>
      </tr>`
    })
    .join('')
  return `${filterBanner}${pills}
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
  ${renderLogCopyScript('__tradesCopy')}`
}
