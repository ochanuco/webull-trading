import type {
  Notifier,
  NotificationEvent,
  NotificationSeverity,
} from './Notifier'

// Bounded so an unresponsive webhook can't pin the isolate — cron shares
// this tick with other tasks (portfolio roll, etc).
const WEBHOOK_TIMEOUT_MS = 10_000

interface ErrorCauseInfo {
  /** Japanese headline, e.g. "株価取得が連続で失敗". */
  headline: string
  /** What the bot does about it, e.g. "5分ごとに自動で再試行しています". */
  impact: string
  /** Operator action, when one exists. Omitted causes skip the 要対応 line. */
  action?: string
}

// `event.cause` stays a machine key for notification_emit_log / brokerErrorSurge / dashboard
// alerts — this table only controls the human-facing text, never the key itself.
const ERROR_CAUSE_INFO: Record<string, ErrorCauseInfo> = {
  quote_feed_partial: { headline: '株価取得が連続で失敗', impact: '5分ごとに自動で再試行しています' },
  quote_feed: { headline: '株価取得が連続で失敗', impact: '5分ごとに自動で再試行しています' },
  reconcile_fills_partial: { headline: '約定照合で一部失敗', impact: '次回の照合 (5分後) で再試行します' },
  reconcile_fills: {
    headline: '約定照合が異常終了',
    impact: 'この回の約定反映は行われていません',
    action: 'ダッシュボードで注文と建玉を確認',
  },
  strategy_cron: {
    headline: '売買判定が異常終了',
    impact: 'この回の判定・発注は実行されていません',
    action: 'Workers のログを確認',
  },
  webull_token_refresh: {
    headline: 'Webull トークン更新に失敗',
    impact: '期限が切れると発注・照会が止まります',
    action: '`pnpm run issue-token` → `POST /admin/webull-token/seed`',
  },
  webull_market_data_unhealthy: {
    headline: 'Webull 市場データ API が異常',
    impact: '銘柄の取扱可否チェックが効かない可能性があります',
  },
  portfolio_halted: { headline: '売買停止中 (ポートフォリオ停止)', impact: '新規の判定・発注をスキップしています' },
  drawdown_kill: {
    headline: '売買停止: ドローダウン上限に到達',
    impact: '新規の判定・発注をスキップしています',
    action: '損益を確認して再開を判断',
  },
  no_bridge_state: {
    headline: '売買停止: 状態ストア未接続',
    impact: '判定・発注をスキップしています',
    action: 'Durable Object binding の設定を確認',
  },
  exit_unavailable_while_holding: {
    headline: '保有中の決済判定ができません',
    impact: 'この回の売却判定はスキップ、建玉は保持したままです',
    action: 'チャートで値動きを確認',
  },
  'bar fetch': { headline: '日足の取得に失敗', impact: 'この銘柄の今回の判定をスキップしました' },
  broker_4xx: { headline: '発注エラー (リクエスト拒否)', impact: '注文状況をダッシュボードで確認してください' },
  broker_429: { headline: '発注エラー (レート制限)', impact: '注文状況をダッシュボードで確認してください' },
  broker_5xx: { headline: '発注エラー (Webull 側障害)', impact: '注文状況をダッシュボードで確認してください' },
  broker_other: { headline: '発注エラー', impact: '注文状況をダッシュボードで確認してください' },
  'broker submit': { headline: '発注エラー', impact: '注文状況をダッシュボードで確認してください' },
}

const DEFAULT_ERROR_CAUSE_INFO: ErrorCauseInfo = { headline: '内部エラー', impact: 'ログを確認してください' }

export interface WebhookNotifierOptions {
  /** Empty/undefined skips Slack. */
  slackUrl?: string
  /** Empty/undefined skips Discord. */
  discordUrl?: string
  /** Only ERROR notifications with a symbol get a `/dashboard/charts?...` link; TRADE notifications never do. */
  dashboardBaseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * Slack (`{ text }`) / Discord (`{ content }`) webhook notifier. Both
 * targets are posted in parallel via `Promise.allSettled` so one failing
 * doesn't block the other, and `notify()` never throws.
 */
export class WebhookNotifier implements Notifier {
  private readonly slackUrl?: string
  private readonly discordUrl?: string
  private readonly dashboardBaseUrl?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: WebhookNotifierOptions) {
    const slack = options.slackUrl?.trim()
    const discord = options.discordUrl?.trim()
    const dashboard = options.dashboardBaseUrl?.trim()
    this.slackUrl = slack ? slack : undefined
    this.discordUrl = discord ? discord : undefined
    this.dashboardBaseUrl = dashboard ? stripTrailingSlash(dashboard) : undefined
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async notify(event: NotificationEvent): Promise<void> {
    const message = this.formatMessage(event)
    const tasks: Array<Promise<unknown>> = []
    if (this.slackUrl) {
      tasks.push(this.postSafe(this.slackUrl, { text: message }, 'slack'))
    }
    if (this.discordUrl) {
      tasks.push(this.postSafe(this.discordUrl, { content: message }, 'discord'))
    }
    if (tasks.length === 0) return
    await Promise.allSettled(tasks)
  }

  private async postSafe(
    url: string,
    body: Record<string, unknown>,
    target: 'slack' | 'discord',
  ): Promise<void> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            event: 'notifier_webhook_non_ok',
            target,
            status: response.status,
          }),
        )
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'notifier_webhook_failed',
          target,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  /** Public so `LoggingNotifier` can persist the same text to `notification_emit_log.message`. */
  formatMessage(event: NotificationEvent): string {
    if (event.type === 'TRADE') {
      return formatTradeMessage(event)
    }
    if (event.type === 'STATE_CHANGE') {
      const head = event.headline
        ? `${severityIcon(event.severity)} ${event.headline}`
        : `${severityIcon(event.severity)} state change: ${event.field} ${formatValue(event.from)} → ${formatValue(event.to)}`
      const note = event.note ? `\n${event.note}` : ''
      return `${head}${note}`
    }
    if (event.type === 'SUMMARY') {
      return `${severityIcon(event.severity ?? 'info')} ${event.message}`
    }
    const info = (event.cause ? ERROR_CAUSE_INFO[event.cause] : undefined) ?? DEFAULT_ERROR_CAUSE_INFO
    const icon = severityIcon(event.severity ?? 'warning')
    const symbolPart = event.symbol ? `：${event.symbol}` : ''
    const lines = [`${icon} ${info.headline}${symbolPart}`, info.impact]
    if (info.action) lines.push(`要対応: ${info.action}`)
    lines.push('', `詳細: ${event.message}`)
    const link = event.symbol ? this.dashboardLinkFor(event.symbol) : undefined
    if (link) lines.push(link)
    return lines.join('\n')
  }

  private dashboardLinkFor(symbol: string): string | undefined {
    if (!this.dashboardBaseUrl) return undefined
    const encoded = encodeURIComponent(symbol)
    return `${this.dashboardBaseUrl}/dashboard/charts?tab=symbol&symbol=${encoded}`
  }
}

type TradeEvent = Extract<NotificationEvent, { type: 'TRADE' }>

function formatTradeMessage(event: TradeEvent): string {
  const modeLine = event.mode === 'DRY_RUN' ? '\n\n🧪 DRY RUN' : ''
  if (event.side === 'BUY') {
    return `⚪ ${event.symbol} 買付\n${event.qty}株 @ $${formatPrice(event.price)}${modeLine}`
  }

  if (event.realizedPnl === undefined) {
    return `⚪ ${event.symbol} 売却\n${event.qty}株 @ $${formatPrice(event.price)}${modeLine}`
  }

  const icon = event.realizedPnl > 0 ? '🟢' : event.realizedPnl < 0 ? '🔴' : '⚪'
  const pnlRate = realizedPnlRate(event.realizedPnl, event.qty, event.price)
  const ratePart = pnlRate === null ? '' : ` (${formatPercent(pnlRate)})`
  return `${icon} ${event.symbol} 売却\n${event.qty}株 @ $${formatPrice(event.price)}\n\n実現損益: $${formatPnl(event.realizedPnl)}${ratePart}${modeLine}`
}

// Backs out capital basis from (exit notional - realizedPnl) rather than
// requiring entry price on the event, since TRADE events don't carry position history.
function realizedPnlRate(realizedPnl: number, qty: number, exitPrice: number): number | null {
  if (!Number.isFinite(realizedPnl) || !Number.isFinite(qty) || !Number.isFinite(exitPrice)) return null
  const exitNotional = qty * exitPrice
  const capitalBasis = exitNotional - realizedPnl
  if (!Number.isFinite(capitalBasis) || capitalBasis <= 0) return null
  return (realizedPnl / capitalBasis) * 100
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return String(price)
  return price.toFixed(2)
}

function formatPnl(pnl: number): string {
  if (!Number.isFinite(pnl)) return String(pnl)
  const sign = pnl > 0 ? '+' : ''
  return `${sign}${pnl.toFixed(2)}`
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

function severityIcon(severity: NotificationSeverity): string {
  switch (severity) {
    case 'critical':
      return '🚨'
    case 'info':
      return 'ℹ️'
    case 'warning':
    default:
      return '⚠️'
  }
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
