import type { Notifier, NotificationEvent } from './Notifier'

export interface WebhookNotifierOptions {
  /** Slack incoming webhook URL。空 / undefined なら Slack には送らない。 */
  slackUrl?: string
  /** Discord webhook URL。空 / undefined なら Discord には送らない。 */
  discordUrl?: string
  /**
   * dashboard の base URL (例: `https://webull-trading.example.workers.dev`)。
   * 設定されていれば各メッセージ末尾に `/dashboard/charts?...` link を付ける。
   * 未設定なら link 省略 (deploy 環境固有なので env 任せ)。
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
 *
 * dedup / retry / batching は意図的に持たない (POC、頻度は cron 15 分粒度の範囲)。
 */
export class WebhookNotifier implements Notifier {
  private readonly slackUrl?: string
  private readonly discordUrl?: string
  private readonly dashboardBaseUrl?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: WebhookNotifierOptions) {
    // 空文字列も「未設定」扱い。env loader が `?? ''` した時に静かに無効化する。
    this.slackUrl = options.slackUrl?.trim() ? options.slackUrl : undefined
    this.discordUrl = options.discordUrl?.trim() ? options.discordUrl : undefined
    this.dashboardBaseUrl = options.dashboardBaseUrl?.trim()
      ? stripTrailingSlash(options.dashboardBaseUrl)
      : undefined
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
    // allSettled で握りつぶす (silent fallback)。caller には常に resolve を返す。
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
      })
      if (!response.ok) {
        // 4xx / 5xx は webhook URL 設定ミス / Slack 側の問題。log だけ残して続行。
        console.warn(
          JSON.stringify({
            event: 'notifier_webhook_non_ok',
            target,
            status: response.status,
          }),
        )
      }
    } catch (error) {
      // network failure 等。やはり throw しない (silent fallback)。
      console.warn(
        JSON.stringify({
          event: 'notifier_webhook_failed',
          target,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  private formatMessage(event: NotificationEvent): string {
    if (event.type === 'TRADE') {
      const head =
        event.side === 'BUY'
          ? `🟢 BUY ${event.symbol} qty=${event.qty} @ $${formatPrice(event.price)} (${event.mode})`
          : `🔴 SELL ${event.symbol} qty=${event.qty} @ $${formatPrice(event.price)}${
              event.realizedPnl !== undefined ? ` pnl=${formatPnl(event.realizedPnl)}` : ''
            } (${event.mode})`
      const link = this.dashboardLinkFor(event.symbol)
      return link ? `${head}\n${link}` : head
    }
    // ERROR
    const sym = event.symbol ?? 'global'
    const causePart = event.cause ? ` (${event.cause})` : ''
    const head = `⚠️ cron error: ${sym} — ${event.message}${causePart}`
    const link = event.symbol ? this.dashboardLinkFor(event.symbol) : undefined
    return link ? `${head}\n${link}` : head
  }

  private dashboardLinkFor(symbol: string): string | undefined {
    if (!this.dashboardBaseUrl) return undefined
    // chart UI の deep link。dashboard route は src/routes/dashboard 配下に存在。
    const encoded = encodeURIComponent(symbol)
    return `${this.dashboardBaseUrl}/dashboard/charts?tab=symbol&symbol=${encoded}`
  }
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
  // pnl は正負ありうる。読みやすさで小数 2 桁固定 + 符号明示。
  const sign = pnl > 0 ? '+' : ''
  return `${sign}${pnl.toFixed(2)}`
}
