/**
 * Slack/Discord webhook 通知用 thin port。意図的に薄い: retry / dedup /
 * rate-limit はせず、呼び出し側は fire-and-forget で叩く。
 * `createNotifier(env)` が production wiring — webhook URL 未設定なら
 * `NoopNotifier` を返す。
 */
export interface Notifier {
  /** 実装は fetch 失敗を含め必ず resolve する — caller が `.catch()` を忘れても cron を落とさないため。 */
  notify(event: NotificationEvent): Promise<void>
}

export type NotificationEvent =
  | TradeNotificationEvent
  | ErrorNotificationEvent
  | StateChangeNotificationEvent
  | SummaryNotificationEvent

/** `critical` = ops action needed now, `warning` = worth watching, `info` = state log only. TRADE events don't use severity (BUY/SELL already color-coded by side). */
export type NotificationSeverity = 'critical' | 'warning' | 'info'

interface TradeNotificationEvent {
  type: 'TRADE'
  side: 'BUY' | 'SELL'
  symbol: string
  qty: number
  price: number
  /** SELL のみ。BUY は undefined。 */
  realizedPnl?: number
  mode: 'DRY_RUN' | 'LIVE'
}

interface ErrorNotificationEvent {
  type: 'ERROR'
  /** symbol 単位の失敗のみ設定。global 失敗 (D1 等) は undefined。 */
  symbol?: string
  message: string
  /** 例外の root cause / context (例: `bar fetch`, `broker submit`). */
  cause?: string
  /** 未指定なら `warning`。`critical` は trading 停止リスクの高い経路のみに付ける。 */
  severity?: NotificationSeverity
}

/** `global_config` の field 変化通知。1 tick で複数 field 変化時は field ごとに 1 件送る。`from`/`to` は JSON stringify 可能な値であること。 */
interface StateChangeNotificationEvent {
  type: 'STATE_CHANGE'
  /** 変化した config field 名 (例: `dry_run`, `trading_enabled`). */
  field: string
  from: unknown
  to: unknown
  /** 実発注に近づく遷移 (`dry_run: true→false` 等) は critical、止める向きは info。 */
  severity: NotificationSeverity
  /** 補足 (例: `requestId`)。formatter が末尾に付ける。 */
  note?: string
  /** 指定時、既定の `state change: <field> <from> → <to>` の代わりに表示する見出し。field/from/to は emit log の構造化列 / dedup 判定のため別途保持される。 */
  headline?: string
}

/** 変化ではなく現状を届ける定期配信 (SUMMARY) 向け。STATE_CHANGE と異なり from/to を持たず、本文は呼び出し側が組み立てる。 */
interface SummaryNotificationEvent {
  type: 'SUMMARY'
  /** サマリ識別子 (例: 'news_shock_daily_summary')。push 専用 — LoggingNotifier は SUMMARY の `notification_emit_log` INSERT を skip する。 */
  kind: string
  /** 送信本文 (複数行可)。呼び出し側が組み立てる。 */
  message: string
  /** 未指定なら 'info'。 */
  severity?: NotificationSeverity
}
