import type { Env } from '../../config/env'
import { NoopNotifier } from './NoopNotifier'
import type { Notifier } from './Notifier'
import { WebhookNotifier } from './WebhookNotifier'

/**
 * Env から `Notifier` を組み立てる factory (#199)。
 *
 * Slack/Discord webhook URL がいずれも未設定なら `NoopNotifier` を返し、
 * cron 経路は完全に no-op になる。env の typo / 抜け落ちで通知が飛ばないだけで
 * cron 自体は止めない (fail-open ではなく **fail-silent**)。
 */
export function createNotifier(env: Env): Notifier {
  const slack = env.SLACK_WEBHOOK_URL?.trim()
  const discord = env.DISCORD_WEBHOOK_URL?.trim()
  if (!slack && !discord) return new NoopNotifier()
  return new WebhookNotifier({
    slackUrl: slack,
    discordUrl: discord,
    dashboardBaseUrl: env.DASHBOARD_BASE_URL,
  })
}
