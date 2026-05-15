import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm'
import { configAuditLog, type ConfigAuditLogRow } from './schema'
import { createDb } from './tradeJournalRepo'

/**
 * Append-only audit trail for state-changing admin POST handlers (#274). Each
 * mutation captures a JSON snapshot of the affected resource `before` and
 * `after`. The pair is `JSON.stringify`'d at write-time so dashboard views can
 * render a diff without re-fetching state.
 *
 * `recordChange` returns early when the stringified before/after match — a
 * pure no-op (e.g. `seed-cash` with the same amount) shouldn't show up in the
 * audit table. D1 write failures are propagated; callers wrap the entire admin
 * handler so a logging failure surfaces rather than silently dropping the row.
 */

export interface RecordChangeParams {
  /** basic-auth username, or `'ai-agent'` when the header is absent / unparseable. */
  actor: string
  /** logical endpoint id (e.g. `/admin/symbols/:symbol/seed-cash`). */
  endpoint: string
  /** Short tag identifying the affected resource (e.g. `symbol=SOXL`). */
  targetKey: string | null
  /** Pre-mutation snapshot. Any JSON-serializable value. */
  before: unknown
  /** Post-mutation snapshot. Any JSON-serializable value. */
  after: unknown
  requestId?: string | null
  /** Test seam for deterministic timestamps. */
  now?: () => Date
}

export interface RecordChangeResult {
  /** `true` when a row was inserted. `false` when before==after (no-op skip). */
  recorded: boolean
}

export async function recordChange(
  db: D1Database,
  params: RecordChangeParams,
): Promise<RecordChangeResult> {
  const beforeJson = JSON.stringify(params.before ?? null)
  const afterJson = JSON.stringify(params.after ?? null)
  if (beforeJson === afterJson) {
    return { recorded: false }
  }
  const timestamp = (params.now ?? (() => new Date()))().toISOString()
  await createDb(db).insert(configAuditLog).values({
    timestamp,
    actor: params.actor,
    endpoint: params.endpoint,
    targetKey: params.targetKey,
    beforeJson,
    afterJson,
    requestId: params.requestId ?? null,
  })
  return { recorded: true }
}

/**
 * Extract basic-auth username from an incoming `Authorization` header. Mirrors
 * the parse that Hono's `basicAuth` middleware already accepted upstream — we
 * just decode again here because Hono does not surface the username in context.
 *
 * Fallback `'ai-agent'` when the header is missing / malformed: every audit row
 * still has an actor, and the bot-vs-human distinction is preserved on the
 * dashboard.
 */
export function extractActor(authorizationHeader: string | null | undefined): string {
  if (!authorizationHeader) return 'ai-agent'
  const match = /^basic\s+(.+)$/i.exec(authorizationHeader.trim())
  if (!match) return 'ai-agent'
  const token = match[1]?.trim()
  if (!token) return 'ai-agent'
  let decoded: string
  try {
    decoded = atob(token)
  } catch {
    return 'ai-agent'
  }
  const idx = decoded.indexOf(':')
  const user = (idx >= 0 ? decoded.slice(0, idx) : decoded).trim()
  return user.length > 0 ? user : 'ai-agent'
}

export type ConfigAuditRow = ConfigAuditLogRow

export interface LoadAuditOptions {
  /** Latest N rows. Default 100, capped at 500. */
  limit?: number
  /** Exact actor match. */
  actor?: string
  /** Exact endpoint match. */
  endpoint?: string
  /** ISO timestamp inclusive lower bound. */
  fromIso?: string
  /** ISO timestamp inclusive upper bound. */
  toIso?: string
}

/**
 * dashboard `/dashboard/audit` 用 SELECT。timestamp DESC で最新から limit 件返す。
 * actor / endpoint / date range は AND で組み合わせる。
 */
export async function loadRecentAudit(
  db: D1Database,
  options: LoadAuditOptions = {},
): Promise<ConfigAuditRow[]> {
  const limit = clampLimit(options.limit)
  const drizzle = createDb(db)
  let query = drizzle.select().from(configAuditLog).$dynamic()
  const conditions: SQL[] = []
  if (options.actor) conditions.push(eq(configAuditLog.actor, options.actor))
  if (options.endpoint) conditions.push(eq(configAuditLog.endpoint, options.endpoint))
  if (options.fromIso) conditions.push(gte(configAuditLog.timestamp, options.fromIso))
  if (options.toIso) conditions.push(lte(configAuditLog.timestamp, options.toIso))
  if (conditions.length > 0) {
    query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
  }
  return await query
    .orderBy(desc(configAuditLog.timestamp), desc(configAuditLog.id))
    .limit(limit)
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 100
  return Math.min(Math.floor(raw), 500)
}
