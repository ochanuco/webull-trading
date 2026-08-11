import type { SymbolUniverse } from '../../infrastructure/db/symbolUniverse'
import type { AlertRow } from '../../infrastructure/notification/notificationEmitLog'
import type { NotificationSeverity, NotificationEvent } from '../../infrastructure/notification/Notifier'
import {
  LOG_COPY_ALL_BTN,
  displaySymbol,
  esc,
  fmtJst,
  inactiveTooltip,
  isSymbolInactive,
  logCopyRowBtn,
  renderLogCopyScript,
  renderPaginationNav,
  safeJsonScript,
} from './shared'
import { BROKER_ERROR_LABELS, extractBrokerErrorCode } from './trades'

/**
 * `?limit=N` を 1〜500 の範囲に丸める。`/dashboard/alerts` 専用 (cron 系の
 * `clampLimit` は既定 50 / max 200 で別ロール)。
 */
export function clampAlertLimit(raw: string | undefined): number {
  const n = raw === undefined ? 100 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(n, 500)
}

/**
 * `c.req.url` から `URLSearchParams` を取り出す。filter pill が他の query
 * (例: `limit=500`) を保持するために使う (CodeRabbit #210)。
 *
 * URL 構築失敗時は空 URLSearchParams にフォールバック。
 */
export function parseAlertsQuery(rawUrl: string): URLSearchParams {
  try {
    return new URL(rawUrl).searchParams
  } catch {
    return new URLSearchParams()
  }
}

export const SEVERITY_VALUES: ReadonlyArray<NotificationSeverity> = ['critical', 'warning', 'info']

export function parseSeverityFilter(raw: string | undefined): NotificationSeverity[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is NotificationSeverity =>
      (SEVERITY_VALUES as readonly string[]).includes(s),
    )
}

export const EVENT_TYPE_VALUES: ReadonlyArray<NotificationEvent['type']> = [
  'TRADE',
  'ERROR',
  'STATE_CHANGE',
  'SUMMARY',
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
  /** 現在の query string。filter pill が他の param (limit 等) を保持するために使う。 */
  currentQuery: URLSearchParams
  /** symbol 列の表示を JP 銘柄向け 番号-会社名 形式にするための universe (load 失敗は null)。 */
  universe?: SymbolUniverse | null
  before?: number
  hasMore?: boolean
}

/**
 * `/dashboard/alerts` の HTML 本文 (#141)。
 *
 *   - severity ピル (critical / warning / info / 全件) で絞り込み
 *   - event type ピル (TRADE / ERROR / STATE_CHANGE / 全件) で絞り込み
 *   - 表示は最新 100 件 (`?limit=N` で 1〜500)
 *   - 行クリックで Slack/Discord に出したのと同じ message を JST 時刻と一緒に確認
 */
/** severity → 日本語 pill (#alerts-trades-ui)。cls は共通 .pill variant (layout.ts)。 */
export const ALERT_SEVERITY_PILLS: Record<string, { ja: string; cls: string }> = {
  critical: { ja: '重大', cls: 'err' },
  warning: { ja: '警告', cls: 'warn' },
  info: { ja: '情報', cls: 'info' },
}

/** event type → 日本語。 */
export const ALERT_EVENT_LABELS: Record<string, string> = {
  ERROR: 'エラー',
  TRADE: '売買',
  STATE_CHANGE: '設定変更',
  SUMMARY: 'サマリ',
}

/** 長い message は先頭を出して残りを <details> に畳む閾値。 */
export const ALERT_MESSAGE_FOLD = 160

export function alertsBody(args: AlertsBodyArgs): string {
  const { rows, limit, severityFilter, eventTypeFilter, currentQuery, universe, before, hasMore = false } = args
  const filterPills = renderAlertFilterPills(severityFilter, eventTypeFilter, currentQuery)
  const countLine = `<span class="muted" style="font-size:12px;margin-right:8px">${rows.length} 件 (limit=${limit}, max 500)</span>${rows.length > 0 ? LOG_COPY_ALL_BTN : ''}`
  if (rows.length === 0) {
    return `${filterPills}${countLine}<p class="muted">該当するアラートはありません。</p>`
  }
  const tbody = rows
    .map((r) => {
      const sev = ALERT_SEVERITY_PILLS[r.severity] ?? { ja: r.severity, cls: 'neutral' }
      const sevCell = `<span title="${esc(r.severity)}" class="pill ${sev.cls}">${esc(sev.ja)}</span>`
      const eventCell = `<span title="${esc(r.eventType)}" style="font-size:12px">${esc(ALERT_EVENT_LABELS[r.eventType] ?? r.eventType)}</span>`
      const symbolInactive = r.symbol ? isSymbolInactive(r.symbol, universe) : false
      const symbolCell = r.symbol
        ? `<a href="/dashboard/charts?tab=symbol&symbol=${encodeURIComponent(r.symbol)}"${symbolInactive ? ` title="${esc(inactiveTooltip(r.symbol, universe))}"` : ''} style="text-decoration:none"><strong${symbolInactive ? ' class="symbol-disabled"' : ''}>${esc(displaySymbol(r.symbol, universe))}</strong></a>`
        : '<span class="muted">—</span>'
      // broker エラーは error_code を短い日本語にして先頭へ。message 全文は
      // 長ければ畳む (enum / 原文は grep 突き合わせ用に details に保持)。
      const code = r.eventType === 'ERROR' ? extractBrokerErrorCode(r.message) : null
      const shortLabel = code ? (BROKER_ERROR_LABELS[code] ?? code) : null
      const messageBody =
        r.message.length > ALERT_MESSAGE_FOLD
          ? `${esc(r.message.slice(0, ALERT_MESSAGE_FOLD))}…<details style="margin-top:2px"><summary class="muted" style="font-size:11px;cursor:pointer">全文</summary><code style="font-size:11px;white-space:pre-wrap;word-break:break-all">${esc(r.message)}</code></details>`
          : esc(r.message)
      // <details> (block) を含み得るので外側は div (CodeRabbit #469)。
      const messageCell = `${shortLabel ? `<span class="pill err">${esc(shortLabel)}</span>` : ''}<div style="font-size:12px">${messageBody}</div>`
      const causeCell = r.cause
        ? `<code style="font-size:11px">${esc(r.cause)}</code>`
        : '<span class="muted">—</span>'
      return `<tr style="vertical-align:top">
        <td>${logCopyRowBtn(r.id)}</td>
        <td class="muted" style="white-space:nowrap">${esc(fmtJst(r.timestamp))}</td>
        <td>${sevCell}</td>
        <td>${eventCell}</td>
        <td>${symbolCell}</td>
        <td>${causeCell}</td>
        <td>${messageCell}</td>
        <td class="muted"><code style="font-size:11px">${esc(r.requestId ?? '—')}</code></td>
      </tr>`
    })
    .join('')
  return `${filterPills}${countLine}
  <table>
    <thead><tr>
      <th></th><th>日時 (JST)</th><th>重要度</th><th>種別</th><th>銘柄</th><th>要因</th><th>内容</th><th>requestId</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
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
  ${renderLogCopyScript('__alertsCopy')}`
}

export function buildAlertBaseHref(
  limit: number,
  severityFilter: NotificationSeverity[],
  eventTypeFilter: NotificationEvent['type'] | undefined,
): string {
  const params: string[] = [`limit=${limit}`]
  if (severityFilter.length > 0) params.push(`severity=${severityFilter.join(',')}`)
  if (eventTypeFilter) params.push(`eventType=${eventTypeFilter}`)
  return `/dashboard/alerts?${params.join('&')}`
}

/**
 * `/dashboard/alerts` の severity / eventType filter ピルを描画する。
 *
 * `currentQuery` の他 param (例: `limit=500`) は preserve したまま、対象 key
 * のみを差し替える / 削除する (CodeRabbit #210)。
 *
 * Exported for unit test (URL preservation).
 */
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
  // trades / cron の view 切替と同じ .chip 見た目に統一 (#dashboard-design)。
  const pill = (label: string, href: string, isActive: boolean): string =>
    `<a href="${esc(href)}" class="chip${isActive ? ' active' : ''}" style="margin-right:6px">${esc(label)}</a>`
  const sev = [
    pill('全 severity', buildHref('severity', null), active.length === 0),
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
      'critical+warning',
      buildHref('severity', 'critical,warning'),
      active.length === 2 && active.includes('critical') && active.includes('warning'),
    ),
    pill('info', buildHref('severity', 'info'), active.length === 1 && active[0] === 'info'),
  ].join('')
  const ev = [
    pill('全 type', buildHref('eventType', null), activeEventType === undefined),
    pill('ERROR', buildHref('eventType', 'ERROR'), activeEventType === 'ERROR'),
    pill('TRADE', buildHref('eventType', 'TRADE'), activeEventType === 'TRADE'),
    pill(
      'STATE_CHANGE',
      buildHref('eventType', 'STATE_CHANGE'),
      activeEventType === 'STATE_CHANGE',
    ),
    pill('SUMMARY', buildHref('eventType', 'SUMMARY'), activeEventType === 'SUMMARY'),
  ].join('')
  return `<nav style="margin-bottom:12px">${sev}<span class="muted" style="margin:0 8px">|</span>${ev}</nav>`
}
