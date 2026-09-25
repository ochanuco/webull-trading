import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm'
import { configAuditLog, type ConfigAuditLogRow } from './schema'
import { createDb } from './tradeJournalRepo'

/**
 * Append-only audit trail for state-changing admin POST handlers. Each
 * mutation stores a `JSON.stringify`'d before/after snapshot so dashboard
 * views can render a diff without re-fetching state.
 *
 * `recordChange` skips the insert when before/after are identical, so a
 * pure no-op (e.g. `seed-cash` with the same amount) doesn't pollute the
 * audit table. D1 write failures propagate rather than being swallowed —
 * callers should wrap the handler so a logging failure surfaces.
 */

export interface RecordChangeParams {
  /**
   * Identity that performed the mutation, set by the Access auth middleware
   * (SSO email or a service-token `common_name`). Missing actor here means
   * the route was wired without auth — the middleware itself fails closed.
   */
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
 * Reads the actor stamped by `accessJwtMiddleware`. Throws instead of
 * falling back to a placeholder value — a missing actor here means a route
 * was wired without auth, and a silent default would mask that.
 */
export function extractActor(actor: string | undefined | null): string {
  if (typeof actor !== 'string') {
    throw new Error('extractActor: missing actor (request bypassed auth middleware?)')
  }
  const trimmed = actor.trim()
  if (trimmed.length === 0) {
    throw new Error('extractActor: empty actor (request bypassed auth middleware?)')
  }
  return trimmed
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
  /** Pagination cursor: returns rows with `id < before`. */
  before?: number
}

/** Latest-first SELECT for `/dashboard/audit`; filters combine with AND. */
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
  if (options.before !== undefined) conditions.push(lt(configAuditLog.id, options.before))
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
