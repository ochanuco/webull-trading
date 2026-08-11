import { insertNotificationEmit } from './notificationEmitLog'
import type {
  Notifier,
  NotificationEvent,
  NotificationSeverity,
} from './Notifier'

/**
 * `Notifier` decorator that ALSO appends every notify() into D1
 * `notification_emit_log` (#141).
 *
 * Wrap any concrete `Notifier` (typically `WebhookNotifier`) so a single
 * notify() call:
 *   1. Forwards to the inner notifier (Slack/Discord webhook send)
 *   2. INSERTs a row into `notification_emit_log` for the dashboard alerts view
 *
 * Both are fire-and-forget from the caller's perspective: this class always
 * resolves, never throws. D1 INSERT failures are caught + logged so a flaky
 * D1 cannot block webhook delivery (and vice-versa).
 *
 * `formatMessage` is a callback so we can record the same string the inner
 * notifier displayed (single source of truth for "what the operator saw").
 */
export interface LoggingNotifierOptions {
  inner: Notifier
  db: D1Database
  /**
   * 通知 message を組み立てる callback。`WebhookNotifier` の formatter と
   * 同じ実装を使う想定 (factory 側で wiring)。失敗したら event.type に
   * fallback。
   */
  formatMessage: (event: NotificationEvent) => string
  /**
   * cron fire 単位の correlation id。`notification_emit_log.request_id` に書く。
   */
  requestId?: string
  /** test 用に固定可能。 */
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
    // Webhook と D1 INSERT は独立。片方の失敗で他方を止めない (silent fallback)。
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

/**
 * Event の native severity を抽出。TRADE は POC では `info` 扱い (ledger
 * としての行を残す目的)、ERROR は未指定なら `warning`、STATE_CHANGE は
 * 必須なので素直に取る。SUMMARY は定期配信 (regime 変化を表さない) なので
 * 未指定なら ERROR と違い `info` に倒す。
 */
export function pickSeverity(event: NotificationEvent): NotificationSeverity {
  if (event.type === 'TRADE') return 'info'
  if (event.type === 'STATE_CHANGE') return event.severity
  if (event.type === 'SUMMARY') return event.severity ?? 'info'
  return event.severity ?? 'warning'
}
