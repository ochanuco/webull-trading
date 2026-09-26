import type { Notifier, NotificationEvent } from './Notifier'

/** `createNotifier` の fallback: webhook URL 未設定 = 通知無効を no-op で表す。 */
export class NoopNotifier implements Notifier {
  async notify(_event: NotificationEvent): Promise<void> {}
}
