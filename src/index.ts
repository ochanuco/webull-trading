import { createApp } from './app'
import type { Env } from './config/env'
import { createDb, insertJournalRecord } from './infrastructure/db/tradeJournalRepo'
import { setTradeJournalDbContext } from './infrastructure/logger/tradeJournal'
import { runQuoteFeed } from './trading/quotes/quoteScheduler'
import { reconcileFills } from './trading/reconciliation/reconcileFills'
import { runStrategyCron } from './trading/strategy/runStrategyCron'

// 5 分毎の quote feed + fill reconcile cron.
const CRON_QUOTE_RECONCILE = '*/5 * * * *'
// 毎時 :15 の Pullback 戦略 cron (position で自然 idempotent)
const CRON_STRATEGY = '15 * * * *'

export { SymbolStateDO } from './trading/state/SymbolStateDO'
export { PortfolioStateDO } from './trading/state/PortfolioStateDO'

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
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    attachTradeJournalDb(env, ctx)
    const requestId = crypto.randomUUID()

    if (event.cron === CRON_STRATEGY) {
      ctx.waitUntil(
        runStrategyCron(env).then(
          (result) => {
            console.log(
              JSON.stringify({
                event: 'strategy_cron_run',
                requestId,
                symbols: result.symbols,
                skipReason: result.skipReason,
                summary: result.summary,
              }),
            )
          },
          (error) => {
            console.error(
              JSON.stringify({
                event: 'strategy_cron_error',
                requestId,
                message: error instanceof Error ? error.message : String(error),
              }),
            )
          },
        ),
      )
      return
    }

    // default: CRON_QUOTE_RECONCILE (`*/5 * * * *`) — quote feed + fill reconcile.
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
    // Fill reconciliation piggybacks on the 5-minute cadence. The SELECT
    // filters out terminal rows so if nothing is in flight this is a single
    // zero-row query. Per-order Webull GET only fires for unreconciled coids.
    ctx.waitUntil(
      reconcileFills({ env, requestId }).then(
        (summary) => {
          // Skip the log line entirely when there was nothing to do — the
          // feed runs every 5 minutes and most intervals are idle.
          if (summary.inspected === 0) return
          console.log(
            JSON.stringify({
              event: 'reconcile_fills_run',
              requestId,
              inspected: summary.inspected,
              updated: summary.updated,
              stillPending: summary.stillPending.length,
              notFound: summary.notFound.length,
              errorCount: summary.errors.length,
            }),
          )
        },
        (error) => {
          console.error(
            JSON.stringify({
              event: 'reconcile_fills_error',
              requestId,
              message: error instanceof Error ? error.message : String(error),
            }),
          )
        },
      ),
    )
  },
}
