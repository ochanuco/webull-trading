import type { Env } from '../../config/env'
import { LoggingNotifier } from './LoggingNotifier'
import { NoopNotifier } from './NoopNotifier'
import type { Notifier, NotificationEvent } from './Notifier'
import { WebhookNotifier } from './WebhookNotifier'

export interface CreateNotifierOptions {
  /** Propagated to `notification_emit_log.request_id`. */
  requestId?: string
  /** Test override; production uses `WebhookNotifier.formatMessage`. */
  formatMessage?: (event: NotificationEvent) => string
}

export function createNotifier(env: Env, options: CreateNotifierOptions = {}): Notifier {
  const slack = env.SLACK_WEBHOOK_URL?.trim()
  const discord = env.DISCORD_WEBHOOK_URL?.trim()

  if (!slack && !discord) {
    if (!env.DB) return new NoopNotifier()
    // No webhook, but D1 is bound: log-only via LoggingNotifier wrapping a no-op inner.
    return new LoggingNotifier({
      inner: new NoopNotifier(),
      db: env.DB,
      formatMessage: options.formatMessage ?? createDefaultFormatter(env),
      requestId: options.requestId,
    })
  }

  const webhook = new WebhookNotifier({
    slackUrl: slack,
    discordUrl: discord,
    dashboardBaseUrl: env.DASHBOARD_BASE_URL,
  })
  if (!env.DB) return webhook
  return new LoggingNotifier({
    inner: webhook,
    db: env.DB,
    formatMessage: options.formatMessage ?? webhook.formatMessage.bind(webhook),
    requestId: options.requestId,
  })
}

// Reuses WebhookNotifier purely for its formatter (URLs unset, so its
// notify() path never runs — this instance only ever calls formatMessage).
function createDefaultFormatter(env: Env): (event: NotificationEvent) => string {
  const formatter = new WebhookNotifier({
    slackUrl: undefined,
    discordUrl: undefined,
    dashboardBaseUrl: env.DASHBOARD_BASE_URL,
  })
  return (event) => formatter.formatMessage(event)
}
