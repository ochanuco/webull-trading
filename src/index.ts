import { createApp } from './app'
import type { Env } from './config/env'
import { createDb, insertJournalRecord } from './infrastructure/db/tradeJournalRepo'
import { setTradeJournalDbContext } from './infrastructure/logger/tradeJournal'
import { keepBridgeAlive } from './trading/bridge/bridgeKeepAlive'
import { runQuoteFeed } from './trading/quotes/quoteScheduler'

export { SymbolStateDO } from './trading/state/SymbolStateDO'
export { PortfolioStateDO } from './trading/state/PortfolioStateDO'
export { BridgeContainer } from './trading/bridge/BridgeContainer'

const app = createApp()

/**
 * Attach a D1-backed sink so tradeJournal records also land in D1.
 * We deliberately do not clear the context on handler exit — the background
 * waitUntil tasks from that handler keep firing logs after return, and those
 * logs should still reach D1. Subsequent handler invocations overwrite the
 * context in place.
 */
function attachTradeJournalDb(env: Env, ctx: ExecutionContext): void {
  if (!env.DB) return
  const db = createDb(env.DB)
  setTradeJournalDbContext({
    insert: (record) => insertJournalRecord(db, record),
    waitUntil: (promise) => ctx.waitUntil(promise),
  })
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    attachTradeJournalDb(env, ctx)
    return app.fetch(request, env, ctx)
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    attachTradeJournalDb(env, ctx)
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
    ctx.waitUntil(keepBridgeAlive(env, { requestId }))
  },
}
