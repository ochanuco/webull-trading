import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { AlertRow } from '../../infrastructure/notification/notificationEmitLog'
import type { NotificationSeverity, NotificationEvent } from '../../infrastructure/notification/Notifier'
import {
  LOG_COPY_ALL_BTN,
  displaySymbol,
  esc,
  fmtJstCompactCell,
  inactiveTooltip,
  isSymbolInactive,
  logCopyRowBtn,
  renderLogCopyScript,
  renderPaginationNav,
  safeJsonScript,
} from './shared'
import { BROKER_ERROR_LABELS, extractBrokerErrorCode } from './trades'

// Own clamp, not the cron `clampLimit`: this view's default/max (100/500) differ from cron's (50/200).
export function clampAlertLimit(raw: string | undefined): number {
  const n = raw === undefined ? 100 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(n, 500)
}

export function parseAlertsQuery(rawUrl: string): URLSearchParams {
  try {
    return new URL(rawUrl).searchParams
  } catch {
    return new URLSearchParams()
  }
}

const SEVERITY_VALUES: ReadonlyArray<NotificationSeverity> = ['critical', 'warning', 'info']

export function parseSeverityFilter(raw: string | undefined): NotificationSeverity[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is NotificationSeverity =>
      (SEVERITY_VALUES as readonly string[]).includes(s),
    )
}

// Excludes SUMMARY: LoggingNotifier skips the emit-log INSERT for it (push-only), so it never
// appears in this view and offering it as a filter would just be a dead option.
const EVENT_TYPE_VALUES: ReadonlyArray<NotificationEvent['type']> = [
  'TRADE',
  'ERROR',
  'STATE_CHANGE',
]

export function parseEventTypeFilter(raw: string | undefined): NotificationEvent['type'] | undefined {
  if (!raw) return undefined
  const upper = raw.trim().toUpperCase() as NotificationEvent['type']
  return (EVENT_TYPE_VALUES as readonly string[]).includes(upper) ? upper : undefined
}

export interface AlertsBodyArgs {
  rows: AlertRow[]
  limit: number
  severityFilter: NotificationSeverity[]
  eventTypeFilter: NotificationEvent['type'] | undefined
  /** Preserves other params (e.g. limit) when building filter pill hrefs. */
  currentQuery: URLSearchParams
  /** Used to render JP symbols as "number - company name"; null when the universe load failed. */
  universe?: SymbolUniverse | null
  before?: number
  hasMore?: boolean
}

const ALERT_SEVERITY_PILLS: Record<string, { ja: string; cls: string }> = {
  critical: { ja: '重大', cls: 'err' },
  warning: { ja: '警告', cls: 'warn' },
  info: { ja: '情報', cls: 'info' },
}

const ALERT_EVENT_LABELS: Record<string, string> = {
  ERROR: 'エラー',
  TRADE: '売買',
  STATE_CHANGE: '設定変更',
}

const ALERT_MESSAGE_FOLD = 160

// `.small` bumps this page's old 11px meta text (requestId / cause / full
// message text) up to the 12px operator-mandated readability floor.
const ALERTS_PAGE_STYLE = `<style>.small{font-size:12px}</style>`

export function alertsBody(args: AlertsBodyArgs): string {
  const { rows, limit, severityFilter, eventTypeFilter, currentQuery, universe, before, hasMore = false } = args
  const filterPills = renderAlertFilterPills(severityFilter, eventTypeFilter, currentQuery)
  const countLine = `<span class="muted small">${rows.length} 件 (上限 ${limit} 件、最大 500 件)</span>${rows.length > 0 ? LOG_COPY_ALL_BTN : ''}`
  const cardHead = `<div class="card-head"><h2 class="card-title">アラート</h2><div class="card-actions">${filterPills}${countLine}</div></div>`
  if (rows.length === 0) {
    return `${ALERTS_PAGE_STYLE}<div class="card">${cardHead}<p class="empty">該当するアラートはありません。</p></div>`
  }
  const tbody = rows
    .map((r) => {
      const sev = ALERT_SEVERITY_PILLS[r.severity] ?? { ja: r.severity, cls: 'neutral' }
      const sevCell = `<span title="${esc(r.severity)}" class="pill ${sev.cls}">${esc(sev.ja)}</span>`
      const eventCell = `<span title="${esc(r.eventType)}" class="small">${esc(ALERT_EVENT_LABELS[r.eventType] ?? r.eventType)}</span>`
      const symbolInactive = r.symbol ? isSymbolInactive(r.symbol, universe) : false
      const symbolCell = r.symbol
        ? `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}"${symbolInactive ? ` title="${esc(inactiveTooltip(r.symbol, universe))}"` : ''}><strong${symbolInactive ? ' class="symbol-disabled"' : ''}>${esc(displaySymbol(r.symbol, universe))}</strong></a>`
        : '<span class="muted">—</span>'
      const code = r.eventType === 'ERROR' ? extractBrokerErrorCode(r.message) : null
      const shortLabel = code ? (BROKER_ERROR_LABELS[code] ?? code) : null
      const messageBody =
        r.message.length > ALERT_MESSAGE_FOLD
          ? `${esc(r.message.slice(0, ALERT_MESSAGE_FOLD))}…<details style="margin-top:2px"><summary class="muted small">全文</summary><code class="small" style="white-space:pre-wrap;word-break:break-all">${esc(r.message)}</code></details>`
          : esc(r.message)
      // div, not span: the message body can contain a block-level <details>.
      const messageCell = `${shortLabel ? `<span class="pill err">${esc(shortLabel)}</span>` : ''}<div class="small">${messageBody}</div>`
      const causeCell = r.cause
        ? `<code class="small">${esc(r.cause)}</code>`
        : '<span class="muted">—</span>'
      return `<tr style="vertical-align:top">
        <td>${logCopyRowBtn(r.id)}</td>
        <td class="muted">${fmtJstCompactCell(r.timestamp)}</td>
        <td>${sevCell}</td>
        <td>${eventCell}</td>
        <td>${symbolCell}</td>
        <td>${causeCell}</td>
        <td>${messageCell}</td>
        <td class="muted"><code class="small">${esc(r.requestId ?? '—')}</code></td>
      </tr>`
    })
    .join('')
  return `${ALERTS_PAGE_STYLE}<div class="card">${cardHead}
  <div class="tablewrap">
  <table>
    <thead><tr>
      <th></th><th>日時 (JST)</th><th>重要度</th><th>種別</th><th>銘柄</th><th>要因</th><th>内容</th><th>リクエストID</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  </div>
  ${renderPaginationNav({
    baseHref: buildAlertBaseHref(limit, severityFilter, eventTypeFilter),
    before,
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id : undefined,
    hasMore,
  })}
  ${safeJsonScript('__alertsCopy', {
    meta: {
      page: 'notification_emit_log (アラート)',
      filter:
        severityFilter.length === 0 && eventTypeFilter === undefined
          ? '全件'
          : `severity=${severityFilter.join(',') || 'all'}, eventType=${eventTypeFilter ?? 'all'}`,
      generatedAt: new Date().toISOString(),
    },
    rows,
  })}
  ${renderLogCopyScript('__alertsCopy')}</div>`
}

function buildAlertBaseHref(
  limit: number,
  severityFilter: NotificationSeverity[],
  eventTypeFilter: NotificationEvent['type'] | undefined,
): string {
  const params: string[] = [`limit=${limit}`]
  if (severityFilter.length > 0) params.push(`severity=${severityFilter.join(',')}`)
  if (eventTypeFilter) params.push(`eventType=${eventTypeFilter}`)
  return `/dashboard/alerts?${params.join('&')}`
}

export function renderAlertFilterPills(
  active: NotificationSeverity[],
  activeEventType: NotificationEvent['type'] | undefined,
  currentQuery: URLSearchParams,
): string {
  const buildHref = (updatedKey: string, updatedValue: string | null): string => {
    const next = new URLSearchParams(currentQuery)
    if (updatedValue === null) next.delete(updatedKey)
    else next.set(updatedKey, updatedValue)
    const qs = next.toString()
    return qs.length === 0 ? '/dashboard/alerts' : `/dashboard/alerts?${qs}`
  }
  const pill = (label: string, href: string, isActive: boolean): string =>
    `<a href="${esc(href)}"${isActive ? ' class="active"' : ''}>${esc(label)}</a>`
  const sev = [
    pill('全重要度', buildHref('severity', null), active.length === 0),
    pill(
      'critical',
      buildHref('severity', 'critical'),
      active.length === 1 && active[0] === 'critical',
    ),
    pill(
      'warning',
      buildHref('severity', 'warning'),
      active.length === 1 && active[0] === 'warning',
    ),
    pill(
      'critical/warning',
      buildHref('severity', 'critical,warning'),
      active.length === 2 && active.includes('critical') && active.includes('warning'),
    ),
    pill('info', buildHref('severity', 'info'), active.length === 1 && active[0] === 'info'),
  ].join('')
  const ev = [
    pill('全種別', buildHref('eventType', null), activeEventType === undefined),
    pill('ERROR', buildHref('eventType', 'ERROR'), activeEventType === 'ERROR'),
    pill('TRADE', buildHref('eventType', 'TRADE'), activeEventType === 'TRADE'),
    pill(
      'STATE_CHANGE',
      buildHref('eventType', 'STATE_CHANGE'),
      activeEventType === 'STATE_CHANGE',
    ),
  ].join('')
  return `<div class="seg">${sev}</div><div class="seg">${ev}</div>`
}
