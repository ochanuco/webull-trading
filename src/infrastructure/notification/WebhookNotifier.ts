import type {
  Notifier,
  NotificationEvent,
  NotificationSeverity,
} from './Notifier'

/**
 * Webhook POST の打ち切り時間。Slack/Discord は通常 1 秒未満で応答するので
 * 10 秒は十分な余裕。cron の他タスク (portfolio roll 等) と同じ tick に
 * 相乗りしているため、無応答の webhook で isolate を長く占有しない。
 */
const WEBHOOK_TIMEOUT_MS = 10_000

export interface WebhookNotifierOptions {
  /** Slack incoming webhook URL。空 / undefined なら Slack には送らない。 */
  slackUrl?: string
  /** Discord webhook URL。空 / undefined なら Discord には送らない。 */
  discordUrl?: string
  /**
   * dashboard の base URL (例: `https://webull-trading.example.workers.dev`)。
   * ERROR 通知に symbol がある場合のみ `/dashboard/charts?...` link を付ける。
   * TRADE 通知は約定結果を読みやすく保つため link を付けない。
   */
  dashboardBaseUrl?: string
  /**
   * 注入可能な fetch (test 用)。未指定ならグローバル `fetch`。
   */
  fetchImpl?: typeof fetch
}

/**
 * Slack / Discord webhook 通知の concrete 実装 (#199)。
 *
 * 設計:
 *   - Slack POST body: `{ text: "..." }`
 *   - Discord POST body: `{ content: "..." }` (key 名が違う点に注意)
 *   - 両方の URL が設定されていれば **両方に並列送信**
 *   - 個別 POST が失敗しても他方は止めない (Promise.allSettled)
 *   - 全失敗でも throw しない (`silent fallback`、cron を fail させない)
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

  /**
   * Slack/Discord に送るのと同じ message 文字列を組み立てる。`LoggingNotifier`
   * が D1 `notification_emit_log.message` 列に同じ表現を残すために public に
   * 露出している (#141)。テスト用にも便利。
   */
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
    const sym = event.symbol ?? 'global'
    const causePart = event.cause ? ` (${event.cause})` : ''
    const icon = severityIcon(event.severity ?? 'warning')
    const label = event.severity === 'critical' ? 'CRITICAL' : 'cron error'
    const head = `${icon} ${label}: ${sym} — ${event.message}${causePart}`
    const link = event.symbol ? this.dashboardLinkFor(event.symbol) : undefined
    return link ? `${head}\n${link}` : head
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

/**
 * realizedPnl は売買コスト控除後。exit notional - net PnL を投入資本相当額とみなし、
 * 通知用のネット損益率を算出する。追加の position 情報を event に持たせず、
 * Discord 上で「結局いくら勝ち負けしたか」を割合でも把握できるようにする。
 */
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
