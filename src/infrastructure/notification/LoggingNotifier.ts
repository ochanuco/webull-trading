import { insertNotificationEmit } from './notificationEmitLog'
import type {
  Notifier,
  NotificationEvent,
  NotificationSeverity,
} from './Notifier'

/**
 * `Notifier` decorator: forwards to an inner `Notifier` (typically
 * `WebhookNotifier`) AND inserts a row into `notification_emit_log` for the
 * dashboard alerts view. Both paths run independently — a D1 failure never
 * blocks webhook delivery and vice versa, and `notify()` always resolves.
 */
export interface LoggingNotifierOptions {
  inner: Notifier
  db: D1Database
  /** Falls back to `event.type` if this throws. Typically `WebhookNotifier.formatMessage`, so the logged text matches what was sent. */
  formatMessage: (event: NotificationEvent) => string
  /** Written to `notification_emit_log.request_id`. */
  requestId?: string
  now?: () => Date
}

export class LoggingNotifier implements Notifier {
  private readonly inner: Notifier
  private readonly db: D1Database
  private readonly formatMessage: (event: NotificationEvent) => string
  private readonly requestId?: string
  private readonly now?: () => Date

  constructor(options: LoggingNotifierOptions) {
    this.inner = options.inner
    this.db = options.db
    this.formatMessage = options.formatMessage
    this.requestId = options.requestId
    this.now = options.now
  }

  async notify(event: NotificationEvent): Promise<void> {
    const message = this.safeFormatMessage(event)
    const severity = pickSeverity(event)
    const innerP = this.inner.notify(event).catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'logging_notifier_inner_failed',
          requestId: this.requestId ?? null,
          eventType: event.type,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
    // SUMMARY is push-only — the alerts view has no place to surface periodic market snapshots.
    if (event.type === 'SUMMARY') {
      await innerP
      return
    }
    const dbP = insertNotificationEmit(this.db, {
      event,
      message,
      severity,
      requestId: this.requestId,
      now: this.now,
    }).catch((err) => {
      console.warn(
        JSON.stringify({
          event: 'logging_notifier_db_failed',
          requestId: this.requestId ?? null,
          eventType: event.type,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
    })
    await Promise.allSettled([innerP, dbP])
  }

  private safeFormatMessage(event: NotificationEvent): string {
    try {
      return this.formatMessage(event)
    } catch {
      return event.type
    }
  }
}

export function pickSeverity(event: NotificationEvent): NotificationSeverity {
  if (event.type === 'TRADE') return 'info'
  if (event.type === 'STATE_CHANGE') return event.severity
  if (event.type === 'SUMMARY') return event.severity ?? 'info'
  return event.severity ?? 'warning'
}
