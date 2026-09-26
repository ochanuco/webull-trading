import { and, desc, eq, inArray, lt, ne, type SQL } from 'drizzle-orm'
import {
  notificationEmitLog,
  type NotificationEmitLogInsert,
  type NotificationEmitLogRow,
} from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { NotificationEvent, NotificationSeverity } from './Notifier'

/**
 * `notification_emit_log` table の R/W。`LoggingNotifier` (notify のたびに
 * 1 行 INSERT) と dashboard `/dashboard/alerts` の SELECT で使う。pure な
 * D1 アクセス層 — `env.DB` の有無チェックは呼び出し側の責務。
 */
export interface NotificationEmitLogParams {
  event: NotificationEvent
  /** WebhookNotifier formatter が組み立てた送信文字列。 */
  message: string
  severity: NotificationSeverity
  requestId?: string
  /** test 用に固定可能。未指定なら `new Date().toISOString()`. */
  now?: () => Date
}

// Throws on failure by design — callers wrap this so a D1 outage doesn't
// also fail the webhook send this log entry is describing.
export async function insertNotificationEmit(
  db: D1Database,
  params: NotificationEmitLogParams,
): Promise<void> {
  const now = (params.now ?? (() => new Date()))().toISOString()
  const row = toInsertRow(params, now)
  await createDb(db).insert(notificationEmitLog).values(row)
}

function toInsertRow(
  params: NotificationEmitLogParams,
  timestamp: string,
): NotificationEmitLogInsert {
  const { event } = params
  return {
    timestamp,
    requestId: params.requestId ?? null,
    eventType: event.type,
    severity: params.severity,
    symbol: pickSymbol(event),
    cause: pickCause(event),
    message: params.message,
  }
}

function pickSymbol(event: NotificationEvent): string | null {
  if (event.type === 'TRADE') return event.symbol
  if (event.type === 'ERROR') return event.symbol ?? null
  return null
}

function pickCause(event: NotificationEvent): string | null {
  if (event.type === 'ERROR') return event.cause ?? null
  if (event.type === 'STATE_CHANGE') return event.field
  // SUMMARY never reaches here in practice (LoggingNotifier skips its
  // INSERT), but falls back to null defensively rather than throwing.
  return null
}

export interface LoadAlertOptions {
  /** Clamped to 500 regardless of input (see `clampLimit`); default 100. */
  limit?: number
  /** Empty/undefined = no severity filter. */
  severities?: NotificationSeverity[]
  eventType?: NotificationEvent['type']
  /** cursor: id < before で古い方へページング。 */
  before?: number
}

export type AlertRow = NotificationEmitLogRow

export async function loadRecentAlerts(
  db: D1Database,
  options: LoadAlertOptions = {},
): Promise<AlertRow[]> {
  const limit = clampLimit(options.limit)
  const drizzle = createDb(db)
  let query = drizzle.select().from(notificationEmitLog).$dynamic()
  const conditions: SQL[] = [
    // Excludes pre-existing SUMMARY rows too, not just new ones — the
    // alerts view is scoped to anomalies/fills/config changes only.
    ne(notificationEmitLog.eventType, 'SUMMARY'),
  ]
  if (options.eventType) {
    conditions.push(eq(notificationEmitLog.eventType, options.eventType))
  }
  if (options.severities && options.severities.length > 0) {
    conditions.push(inArray(notificationEmitLog.severity, options.severities))
  }
  if (options.before !== undefined) {
    conditions.push(lt(notificationEmitLog.id, options.before))
  }
  if (conditions.length > 0) {
    query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
  }
  // id order can lag actual occurrence order under concurrent `waitUntil`
  // inserts, so timestamp is the primary sort key with id as tiebreaker.
  return await query
    .orderBy(desc(notificationEmitLog.timestamp), desc(notificationEmitLog.id))
    .limit(limit)
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 100
  return Math.min(Math.floor(raw), 500)
}
