import { createApp } from './app'
import type { Env } from './config/env'
import { runQuoteFeed } from './trading/quotes/quoteScheduler'

export { SymbolStateDO } from './trading/state/SymbolStateDO'
export { PortfolioStateDO } from './trading/state/PortfolioStateDO'

const app = createApp()

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const requestId = crypto.randomUUID()
    ctx.waitUntil(
      runQuoteFeed({ env }).then(
        (summary) => {
          console.log(
            JSON.stringify({
              event: 'quote_feed_run',
              requestId,
              fetched: summary.fetched,
              persisted: summary.persisted,
              skipped: summary.skipped,
              errors: summary.errors,
            }),
          )
        },
        (error) => {
          console.error(
            JSON.stringify({
              event: 'quote_feed_error',
              requestId,
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        },
      ),
    )
  },
}