/**
 * Notifier — Slack/Discord webhook 通知用 thin port (#199 → #141 拡張)。
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
 *
 * Issue #141 — 通知 event の taxonomy を critical events に拡張:
 *   - `severity` を ERROR / STATE_CHANGE に追加 (critical / warning / info)
 *   - cron skip (portfolio_halted / drawdown_kill / no_bridge_state) や
 *     reconcile error / quote feed error も `Notifier.notify()` 経由で push 通知
 *   - `dry_run=0 && trading_enabled=1` 等の状態遷移は STATE_CHANGE で通知
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
  | StateChangeNotificationEvent
  | SummaryNotificationEvent

/**
 * Severity tier for ERROR / STATE_CHANGE events (#141)。
 *   - `critical`: ops が即対応すべき (trading 停止 / 状態異常)。赤系 icon。
 *   - `warning` : 注意して見るべき (cron skip / quote feed エラー)。黄系 icon。
 *   - `info`    : 状態遷移ログとしての通知 (運用判断には影響しない)。青系 icon。
 *
 * TRADE event は POC では severity を付けない (BUY/SELL は side で色分け済み)。
 */
export type NotificationSeverity = 'critical' | 'warning' | 'info'

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
  /**
   * 通知の重要度。未指定なら `warning` (#199 の既定挙動を保つ)。critical は
   * `strategy_cron_error` / `dry_run=0 && trading_enabled=1` 切替の trading
   * 停止リスクの高い経路だけに付ける。
   */
  severity?: NotificationSeverity
}

/**
 * 状態遷移通知 (#141)。`global_config` の dry_run / trading_enabled 等が
 * cron tick 間で変化した時に出る。1 tick で複数 field が変わる場合は
 * field ごとに 1 件ずつ送る (formatter が message を自動生成)。
 *
 * `from` / `to` は arbitrary primitive を取れるよう unknown だが、JSON
 * stringify 可能であること (Slack/Discord に表示するため)。
 */
export interface StateChangeNotificationEvent {
  type: 'STATE_CHANGE'
  /** 変化した config field 名 (例: `dry_run`, `trading_enabled`). */
  field: string
  from: unknown
  to: unknown
  /**
   * `dry_run: true→false` や `trading_enabled: false→true` 等の「実発注に
   * 近づく」遷移は critical。逆方向 (実発注を止める向き) は info。
   */
  severity: NotificationSeverity
  /**
   * 補足 (例: `requestId`)。formatter が末尾に付ける。
   */
  note?: string
}

/**
 * 定期サマリ配信用イベント (news-shock-gate follow-up)。regime 変化が無くても
 * 現状を届けたい定期スケジューラ (例: news shock gate の日次サマリ) 向け。
 * STATE_CHANGE と違い「変化」を表さないので、from/to は持たず自由記述の
 * `message` を呼び出し側が組み立てる。
 */
export interface SummaryNotificationEvent {
  type: 'SUMMARY'
  /** emit log の cause 列に入る識別子 (例: 'news_shock_daily_summary')。 */
  kind: string
  /** 送信本文 (複数行可)。呼び出し側が組み立てる。 */
  message: string
  /** 未指定なら 'info'。 */
  severity?: NotificationSeverity
}
