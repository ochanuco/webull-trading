/**
 * Notifier — Slack/Discord webhook 通知用 thin port (#199)。
 *
 * 様子見フェーズで dashboard を能動的に開かなくても DRY_RUN BUY/SELL や cron
 * error に気付けるようにするための shallow event sink。意図的に薄い:
 *   - retry / dedup / rate-limit はしない (POC の通知漏れ許容)
 *   - 呼び出し側は **fire-and-forget** で叩く (await しない)
 *   - 実装は失敗を握りつぶす責務を持つ (silent fallback)
 *
 * Production wiring は `createNotifier(env)` で env から組み立てる。
 * env 未設定 (SLACK_WEBHOOK_URL も DISCORD_WEBHOOK_URL も無し) なら
 * `NoopNotifier` が返り、cron 経路は何もしない。
 */
export interface Notifier {
  /**
   * イベント 1 件を送信する。実装は **必ず resolve** する (fetch 失敗 / 4xx /
   * 5xx / network error は内部で catch + log)。 caller が `.catch()` を
   * 忘れても cron が落ちないようにするため。
   */
  notify(event: NotificationEvent): Promise<void>
}

export type NotificationEvent =
  | TradeNotificationEvent
  | ErrorNotificationEvent

export interface TradeNotificationEvent {
  type: 'TRADE'
  side: 'BUY' | 'SELL'
  symbol: string
  qty: number
  price: number
  /** SELL のみ。BUY 時は undefined。 */
  realizedPnl?: number
  mode: 'DRY_RUN' | 'LIVE'
}

export interface ErrorNotificationEvent {
  type: 'ERROR'
  /** symbol 単位で失敗した時のみ。global 失敗 (D1 等) は undefined。 */
  symbol?: string
  message: string
  /** 例外の root cause / context (例: `bar fetch`, `broker submit`). */
  cause?: string
}
