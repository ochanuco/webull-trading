import type { Notifier, NotificationEvent } from './Notifier'

/**
 * 何もしない Notifier。`SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` がいずれも
 * 未設定な環境 (= 既定) で `createNotifier` から返される fallback。test 用
 * stub としても使える。
 */
export class NoopNotifier implements Notifier {
  async notify(_event: NotificationEvent): Promise<void> {
    // 意図的に no-op。env 未設定 = 通知無効、を意味する。
  }
}
