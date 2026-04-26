import type { Env } from '../../config/env'
import { LoggingNotifier } from './LoggingNotifier'
import { NoopNotifier } from './NoopNotifier'
import type { Notifier, NotificationEvent } from './Notifier'
import { WebhookNotifier } from './WebhookNotifier'

/**
 * Env から `Notifier` を組み立てる factory (#199 → #141 拡張)。
 *
 * 組み立てルール:
 *   - Slack/Discord webhook URL がいずれも未設定 → `NoopNotifier`
 *     - ただし `env.DB` があれば「webhook 無し / D1 ログのみ」の `LoggingNotifier`
 *       を返す。dashboard alerts view が動くため。
 *   - URL 設定あり → `WebhookNotifier` を作る
 *     - `env.DB` があればさらに `LoggingNotifier` で wrap (D1 INSERT も走る)
 *     - `env.DB` 不在なら WebhookNotifier 単体 (POC 後方互換)
 *
 * fail-silent 方針は変えない: env の typo / 抜け落ちで通知が飛ばないだけで
 * cron 自体は止めない。
 */
export interface CreateNotifierOptions {
  /**
   * cron fire 単位の correlation id (`scheduled()` の `crypto.randomUUID()`)。
   * `notification_emit_log.request_id` に書き込むために伝搬させる。
   */
  requestId?: string
  /**
   * 通知 message を組み立てる関数の override (test 用)。production は
   * `WebhookNotifier.formatMessage` を使う。
   */
  formatMessage?: (event: NotificationEvent) => string
}

export function createNotifier(env: Env, options: CreateNotifierOptions = {}): Notifier {
  const slack = env.SLACK_WEBHOOK_URL?.trim()
  const discord = env.DISCORD_WEBHOOK_URL?.trim()

  // Webhook 単体 (D1 ログ無し) — `env.DB` 未 bind の old fixture / minimal env
  // を破壊しないため、`createNotifier` を flat に保つ。
  if (!slack && !discord) {
    if (!env.DB) return new NoopNotifier()
    // webhook 無し + D1 あり: ログだけ残す Notifier。NoopNotifier を inner に
    // 据えて LoggingNotifier で wrap する (D1 INSERT 専用パス)。
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

/**
 * D1 ログのみで使う message formatter。Slack/Discord に出すのと同じ表現を
 * 出すために WebhookNotifier の formatter をそのまま借りる。webhook URL が
 * 全く無い場合でもこのインスタンスは format 専用に使い、fetch は呼ばれない
 * (notify path の中に出てこない)。
 */
function createDefaultFormatter(env: Env): (event: NotificationEvent) => string {
  const formatter = new WebhookNotifier({
    slackUrl: undefined,
    discordUrl: undefined,
    dashboardBaseUrl: env.DASHBOARD_BASE_URL,
  })
  return (event) => formatter.formatMessage(event)
}
