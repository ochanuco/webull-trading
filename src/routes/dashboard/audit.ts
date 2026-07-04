import type { ConfigAuditRow } from '../../infrastructure/db/configAuditLog'
import { esc, fmtJst, renderPaginationNav } from './shared'

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

/**
 * `/dashboard/audit` の HTML 本文 (#274)。
 *
 *   - 直近 100 件 (`?limit=N` で 1〜500)
 *   - actor / endpoint / from / to で絞り込み (GET form)
 *   - before_json / after_json は `<details>` で展開表示
 */
export function auditBody(args: AuditBodyArgs): string {
  const { rows, limit, actorFilter, endpointFilter, fromFilter, toFilter, before, hasMore = false } = args
  const form = `<form method="get" action="/dashboard/audit" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
  <label>actor<br><input name="actor" value="${esc(actorFilter ?? '')}" placeholder="ai-agent" style="padding:4px 8px"></label>
  <label>endpoint<br><input name="endpoint" value="${esc(endpointFilter ?? '')}" placeholder="/admin/symbols/:symbol/seed-cash" style="padding:4px 8px;min-width:280px"></label>
  <label>from<br><input name="from" type="date" value="${esc(fromFilter)}" style="padding:4px 8px"></label>
  <label>to<br><input name="to" type="date" value="${esc(toFilter)}" style="padding:4px 8px"></label>
  <label>limit<br><input name="limit" type="number" min="1" max="500" value="${limit}" style="padding:4px 8px;width:90px"></label>
  <button type="submit" style="padding:6px 14px">絞り込み</button>
  <a href="/dashboard/audit" style="padding:6px 14px;text-decoration:none">リセット</a>
</form>`
  const header = `<p class="muted">直近 ${rows.length} 件 (limit=${limit}, max 500)。状態変更系 admin POST の before/after diff。before == after の no-op 呼び出しは記録されません。</p>`
  if (rows.length === 0) {
    return `${header}${form}<p class="muted">該当する監査ログは見つかりませんでした。</p>`
  }
  const tbody = rows
    .map((r) => {
      return `<tr>
        <td class="muted">${esc(fmtJst(r.timestamp))}</td>
        <td><strong>${esc(r.actor)}</strong></td>
        <td><code>${esc(r.endpoint)}</code></td>
        <td>${esc(r.targetKey ?? '-')}</td>
        <td><details><summary class="muted">before</summary><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:#fafafa;padding:6px;border-radius:4px">${esc(formatAuditJson(r.beforeJson))}</pre></details></td>
        <td><details><summary class="muted">after</summary><pre style="margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12px;background:#fafafa;padding:6px;border-radius:4px">${esc(formatAuditJson(r.afterJson))}</pre></details></td>
        <td class="muted"><code>${esc(r.requestId ?? '-')}</code></td>
      </tr>`
    })
    .join('')
  const auditBaseParams: string[] = [`limit=${limit}`]
  if (actorFilter) auditBaseParams.push(`actor=${encodeURIComponent(actorFilter)}`)
  if (endpointFilter) auditBaseParams.push(`endpoint=${encodeURIComponent(endpointFilter)}`)
  if (fromFilter) auditBaseParams.push(`from=${encodeURIComponent(fromFilter)}`)
  if (toFilter) auditBaseParams.push(`to=${encodeURIComponent(toFilter)}`)
  return `${header}${form}
  <table>
    <thead><tr>
      <th>timestamp (JST)</th><th>actor</th><th>endpoint</th><th>target</th><th>before</th><th>after</th><th>requestId</th>
    </tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  ${renderPaginationNav({
    baseHref: `/dashboard/audit?${auditBaseParams.join('&')}`,
    before,
    lastId: rows.length > 0 ? rows[rows.length - 1]!.id : undefined,
    hasMore,
  })}`
}

/**
 * `?limit=N` を 1〜500 に丸める。`/dashboard/audit` 既定 100。
 */
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

/**
 * `YYYY-MM-DD` 日付フィルタを ISO timestamp に展開。`isEnd=true` は `T23:59:59.999Z`、
 * false は `T00:00:00.000Z` を付ける (UTC base — 監査ログの timestamp は
 * ISO UTC で書かれる)。文法が合わない値は undefined を返す (フィルタ skip)。
 */
export function parseAuditDateFilter(raw: string | undefined, isEnd: boolean): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined
  return isEnd ? `${trimmed}T23:59:59.999Z` : `${trimmed}T00:00:00.000Z`
}

/**
 * `before_json` / `after_json` を整形して表示。JSON parse が成功すれば 2-space
 * indent、失敗 (= マイグレ前の raw 文字列など) は原文をそのまま返す。
 */
export function formatAuditJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
