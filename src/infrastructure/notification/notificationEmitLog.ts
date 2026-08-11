import { and, desc, eq, inArray, lt, type SQL } from 'drizzle-orm'
import {
  notificationEmitLog,
  type NotificationEmitLogInsert,
  type NotificationEmitLogRow,
} from '../db/schema'
import { createDb } from '../db/tradeJournalRepo'
import type { NotificationEvent, NotificationSeverity } from './Notifier'

/**
 * `notification_emit_log` table の R/W (#141)。
 *
 * `LoggingNotifier` (notify するたびに 1 行 INSERT する notifier 装飾) と
 * dashboard `/dashboard/alerts` view の SELECT で使う。
 *
 * ここは pure な D1 アクセス層なので env binding 自体の有無は呼び出し側の
 * 責務 (`env.DB` 不在時は呼ばない / NoopNotifier に委譲する)。
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

/**
 * D1 への 1 行 INSERT。失敗は throw しない (caller が握りつぶす)。
 *
 * 通知ログは「あれば便利」レイヤなので、D1 が一時的に落ちても webhook 送信
 * 自体は成功させたい — caller が必ず try/catch する前提で設計している。
 */
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
  // SUMMARY は銘柄非依存の集計通知なので symbol は常に null。
  return null
}

function pickCause(event: NotificationEvent): string | null {
  if (event.type === 'ERROR') return event.cause ?? null
  if (event.type === 'STATE_CHANGE') return event.field
  if (event.type === 'SUMMARY') return event.kind
  return null
}

export interface LoadAlertOptions {
  /**
   * 表示上限。dashboard 既定 100。最大 500 (D1 query を爆発させない)。
   */
  limit?: number
  /**
   * severity フィルタ (例: `['critical', 'warning']`)。空配列 / undefined なら全件。
   */
  severities?: NotificationSeverity[]
  /** event_type フィルタ ('TRADE' / 'ERROR' / 'STATE_CHANGE')。空なら全件。 */
  eventType?: NotificationEvent['type']
  /** cursor: id < before で古い方へページング。 */
  before?: number
}

export type AlertRow = NotificationEmitLogRow

/**
 * dashboard `/dashboard/alerts` 用 SELECT。timestamp DESC で最新から limit
 * 件返す。severity と eventType は両方指定された場合 AND で組み合わせる
 * (CodeRabbit #210): UI 側で両 filter の同時選択 URL が成立可能なため、
 * data 側でも両方を反映して silently drop しないようにする。
 */
export async function loadRecentAlerts(
  db: D1Database,
  options: LoadAlertOptions = {},
): Promise<AlertRow[]> {
  const limit = clampLimit(options.limit)
  const drizzle = createDb(db)
  let query = drizzle.select().from(notificationEmitLog).$dynamic()
  const conditions: SQL[] = []
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
  // `waitUntil` 配下の INSERT が前後すると id 順は実発生順とずれることが
  // ある。timestamp (ISO 文字列) DESC を first key にし、同 timestamp は
  // id DESC で tiebreak する (CodeRabbit #210)。
  return await query
    .orderBy(desc(notificationEmitLog.timestamp), desc(notificationEmitLog.id))
    .limit(limit)
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 100
  return Math.min(Math.floor(raw), 500)
}
