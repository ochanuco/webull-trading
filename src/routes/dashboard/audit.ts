import type { ConfigAuditRow } from '../../infrastructure/db/configAuditLog'
import { esc, fmtJstCompactCell, renderPaginationNav } from './shared'

export interface AuditBodyArgs {
  rows: ConfigAuditRow[]
  limit: number
  actorFilter: string | undefined
  endpointFilter: string | undefined
  /** Raw query string values for the form inputs (passthrough so a typo round-trips). */
  fromFilter: string
  toFilter: string
  before?: number
  hasMore?: boolean
}

// Local input/button sizing: this page's filter form predates the
// foundation's `.btn`/`.seg` components and has no bare `<input>` styling to
// fall back on, so the 13px/32px/border-strong baseline from the type-scale
// spec is declared here instead of relying on browser defaults.
const AUDIT_PAGE_STYLE = `<style>
  .audit-form{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:4px}
  .audit-form label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-2)}
  .audit-form input{height:32px;padding:0 8px;font-size:13px;border:1px solid var(--border-strong);border-radius:var(--radius-sm);background:var(--surface);color:var(--text);font-family:inherit}
  .audit-form input:focus{outline:2px solid var(--accent);outline-offset:1px}
  .small{font-size:12px}
</style>`

export function auditBody(args: AuditBodyArgs): string {
  const { rows, limit, actorFilter, endpointFilter, fromFilter, toFilter, before, hasMore = false } = args
  const form = `<form method="get" action="/dashboard/audit" class="audit-form">
  <label>actor<input name="actor" value="${esc(actorFilter ?? '')}" placeholder="ai-agent"></label>
  <label>endpoint<input name="endpoint" value="${esc(endpointFilter ?? '')}" placeholder="/admin/symbols/:symbol/seed-cash" style="min-width:280px"></label>
  <label>from<input name="from" type="date" value="${esc(fromFilter)}"></label>
  <label>to<input name="to" type="date" value="${esc(toFilter)}"></label>
  <label>limit<input name="limit" type="number" min="1" max="500" value="${limit}" style="width:90px"></label>
  <button type="submit" class="btn primary">絞り込み</button>
  <a href="/dashboard/audit" class="btn">リセット</a>
</form>`
  const cardHead = `<div class="card-head"><h2 class="card-title">監査ログ</h2><span class="info-tip" tabindex="0" aria-label="監査ログの注記" data-tip="状態変更系 admin POST の before/after diff。before == after の no-op 呼び出しは記録されません。">?</span><div class="card-actions"><span class="muted small">直近 ${rows.length} 件 (limit=${limit}, max 500)</span></div></div>`
  if (rows.length === 0) {
    return `${AUDIT_PAGE_STYLE}<div class="card">${cardHead}${form}<p class="empty">該当する監査ログは見つかりませんでした。</p></div>`
  }
  const tbody = rows
    .map((r) => {
      return `<tr>
        <td class="muted">${fmtJstCompactCell(r.timestamp)}</td>
        <td><strong>${esc(r.actor)}</strong></td>
        <td><code>${esc(r.endpoint)}</code></td>
        <td>${esc(r.targetKey ?? '-')}</td>
        <td><details><summary class="muted">before</summary><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--surface-2);padding:6px;border-radius:4px">${esc(formatAuditJson(r.beforeJson))}</pre></details></td>
        <td><details><summary class="muted">after</summary><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--surface-2);padding:6px;border-radius:4px">${esc(formatAuditJson(r.afterJson))}</pre></details></td>
        <td class="muted"><code>${esc(r.requestId ?? '-')}</code></td>
      </tr>`
    })
    .join('')
  const auditBaseParams: string[] = [`limit=${limit}`]
  if (actorFilter) auditBaseParams.push(`actor=${encodeURIComponent(actorFilter)}`)
  if (endpointFilter) auditBaseParams.push(`endpoint=${encodeURIComponent(endpointFilter)}`)
  if (fromFilter) auditBaseParams.push(`from=${encodeURIComponent(fromFilter)}`)
  if (toFilter) auditBaseParams.push(`to=${encodeURIComponent(toFilter)}`)
  return `${AUDIT_PAGE_STYLE}<div class="card">${cardHead}${form}
  <div class="tablewrap">
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>actor</th><th>endpoint</th><th>target</th><th>before</th><th>after</th><th>requestId</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  </div>
  ${renderPaginationNav({
    baseHref: `/dashboard/audit?${auditBaseParams.join('&')}`,
    before,
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id : undefined,
    hasMore,
  })}</div>`
}

export function clampAuditLimit(raw: string | undefined): number {
  const n = raw === undefined ? 100 : Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return 100
  return Math.min(n, 500)
}

export function trimQuery(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

// UTC suffix, not local time: configAuditLog.timestamp is written as ISO UTC.
export function parseAuditDateFilter(raw: string | undefined, isEnd: boolean): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined
  return isEnd ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`
}

function formatAuditJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
