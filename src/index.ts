import { createApp } from './app'
import type { Env } from './config/env'
import { createDb, insertJournalRecord } from './infrastructure/db/tradeJournalRepo'
import { setTradeJournalDbContext } from './infrastructure/logger/tradeJournal'
import { createNotifier } from './infrastructure/notification/createNotifier'
import {
  findHeldTradableDisappearances,
  formatHeldTradableDisappearanceMessage,
} from './infrastructure/notification/tradableAllowlistDisappearance'
import { checkMarketDataHealth } from './infrastructure/webull/checkMarketDataHealth'
import { refreshTradableAllowlist } from './infrastructure/webull/refreshTradableAllowlist'
import { refreshWebullToken } from './infrastructure/webull/refreshWebullToken'
import { resolveAccessToken } from './infrastructure/webull/resolveAccessToken'
import { createWebullReadClient } from './infrastructure/webull/WebullReadClient'
import { runExtendedHoursObservation } from './trading/quotes/extendedHoursScheduler'
import { runNewsScheduler } from './trading/news/newsScheduler'
import { runNewsShockDailySummary } from './trading/news/newsShockDailySummary'
import { runPortfolioRoll } from './trading/portfolio/runPortfolioRoll'
import { runQuoteFeed } from './trading/quotes/quoteScheduler'
import { reconcileFills } from './trading/reconciliation/reconcileFills'
import { runStrategyCron } from './trading/strategy/runStrategyCron'

const CRON_QUOTE_RECONCILE = '*/5 * * * *'
const CRON_STRATEGY = '*/15 * * * *'
const CRON_PORTFOLIO_ROLL = '0 22 * * *'

export { SymbolStateDO } from './trading/state/SymbolStateDO'
export { PortfolioStateDO } from './trading/state/PortfolioStateDO'
export { WebullTokenStateDO } from './trading/state/WebullTokenStateDO'

const app = createApp()

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

    if (event.cron === CRON_PORTFOLIO_ROLL) {
      ctx.waitUntil(runPortfolioRoll(env, requestId))
      ctx.waitUntil(
        refreshWebullToken(env).then(
          (summary) => {
            console.log(
              JSON.stringify({
                event: 'webull_token_refresh',
                requestId,
                refreshed: summary.refreshed,
                skippedReason: summary.skippedReason ?? null,
                failureReason: summary.failureReason ?? null,
                lastSuccessAt: summary.after?.lastSuccessAt ?? null,
              }),
            )
            if (summary.failureReason) {
              ctx.waitUntil(
                createNotifier(env, { requestId })
                  .notify({
                    type: 'ERROR',
                    message: `Webull token refresh failed: ${summary.failureReason}. Run \`pnpm run issue-token\` and POST /admin/webull-token/seed.`,
                    cause: 'webull_token_refresh',
                    severity: 'critical',
                  })
                  .catch(() => undefined),
              )
            }
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(JSON.stringify({ event: 'webull_token_refresh_error', requestId, message }))
            ctx.waitUntil(
              createNotifier(env, { requestId })
                .notify({
                  type: 'ERROR',
                  message: `Webull token refresh threw: ${message}`,
                  cause: 'webull_token_refresh',
                  severity: 'critical',
                })
                .catch(() => undefined),
            )
          },
        ),
      )

      ctx.waitUntil(
        checkMarketDataHealth(env).then(
          (result) => {
            console.log(
              JSON.stringify({
                event: 'webull_market_data_health',
                requestId,
                healthy: result.healthy,
                status: result.status,
                msTaken: result.msTaken,
                error: result.error,
              }),
            )
            if (!result.healthy) {
              ctx.waitUntil(
                createNotifier(env, { requestId })
                  .notify({
                    type: 'ERROR',
                    message: `Webull JP Market Data API (snapshot v2 on trade host) is not healthy: ${result.error ?? 'unknown'} (HTTP ${result.status ?? 'n/a'}, ${result.msTaken}ms). Instrument lookup / tradability pre-check may be degraded — see issue #475.`,
                    cause: 'webull_market_data_unhealthy',
                    severity: 'warning',
                  })
                  .catch(() => undefined),
              )
            }
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(JSON.stringify({ event: 'webull_market_data_health_check_error', requestId, message }))
          },
        ),
      )

      ctx.waitUntil(
        refreshTradableAllowlist(env, new Date().toISOString()).then(
          async (summary) => {
            console.log(
              JSON.stringify({
                event: 'tradable_allowlist_refresh',
                requestId,
                ok: summary.ok,
                done: summary.done,
                pages: summary.pages,
                upserted: summary.upserted,
                disappeared: summary.disappeared,
                disappearedSymbols: summary.disappearedSymbols,
                error: summary.error ?? null,
              }),
            )
            if (summary.disappeared <= 0) return

            try {
              const accessToken = await resolveAccessToken(env)
              const positions = await createWebullReadClient(env, { accessToken }).getPositions()
              const held = findHeldTradableDisappearances(summary.disappearedSymbols, positions)

              console.log(
                JSON.stringify({
                  event: 'tradable_allowlist_disappearance_holdings_check',
                  requestId,
                  disappearedSymbols: summary.disappearedSymbols,
                  heldDisappeared: held,
                }),
              )

              if (held.length === 0) return

              await createNotifier(env, { requestId })
                .notify({
                  type: 'SUMMARY',
                  kind: 'tradable_allowlist_held_disappearance',
                  message: formatHeldTradableDisappearanceMessage(held),
                  severity: 'critical',
                })
                .catch(() => undefined)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              console.error(
                JSON.stringify({
                  event: 'tradable_allowlist_disappearance_holdings_check_error',
                  requestId,
                  disappearedSymbols: summary.disappearedSymbols,
                  message,
                }),
              )
            }
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(JSON.stringify({ event: 'tradable_allowlist_refresh_error', requestId, message }))
          },
        ),
      )

      ctx.waitUntil(runNewsShockDailySummary(env, requestId))
      return
    }

    if (event.cron === CRON_STRATEGY) {
      ctx.waitUntil(
        runStrategyCron(env, { requestId }).then(
          (result) => {
            const { decisions: _decisions, ...summary } = result.summary
            console.log(
              JSON.stringify({
                event: 'strategy_cron_run',
                logSchema: result.analysis.schema,
                requestId,
                symbols: result.symbols,
                skipReason: result.skipReason,
                entryHaltReason: result.entryHaltReason ?? null,
                summary,
                analysis: result.analysis,
              }),
            )
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(JSON.stringify({ event: 'strategy_cron_error', requestId, message }))
            ctx.waitUntil(
              createNotifier(env, { requestId })
                .notify({ type: 'ERROR', message, cause: 'strategy_cron', severity: 'critical' })
                .catch(() => undefined),
            )
          },
        ),
      )
      return
    }

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
              source: summary.source,
              fallbackSymbols: summary.fallbackSymbols,
            }),
          )
          if (summary.errors.length > 0) {
            const summaryMsg = summary.errors
              .slice(0, 3)
              .map((e) => `[${e.category}] ${e.message}`)
              .join(' | ')
            const tail = summary.errors.length > 3 ? ` (+${summary.errors.length - 3} more)` : ''
            ctx.waitUntil(
              createNotifier(env, { requestId })
                .notify({
                  type: 'ERROR',
                  message: `quote_feed partial failure (${summary.errors.length} error(s)): ${summaryMsg}${tail}`,
                  cause: 'quote_feed_partial',
                  severity: 'warning',
                })
                .catch(() => undefined),
            )
          }
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(JSON.stringify({ event: 'quote_feed_error', requestId, message }))
          ctx.waitUntil(
            createNotifier(env, { requestId })
              .notify({ type: 'ERROR', message, cause: 'quote_feed', severity: 'warning' })
              .catch(() => undefined),
          )
        },
      ),
    )

    ctx.waitUntil(
      reconcileFills({ env, requestId }).then(
        (summary) => {
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
              abandoned: summary.abandoned,
            }),
          )
          if (summary.errors.length > 0) {
            ctx.waitUntil(
              createNotifier(env, { requestId })
                .notify({
                  type: 'ERROR',
                  message: `reconcile fills had ${summary.errors.length} error(s), ${summary.abandoned} abandoned, across ${summary.inspected} row(s)`,
                  cause: 'reconcile_fills_partial',
                  severity: 'warning',
                })
                .catch(() => undefined),
            )
          }
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(JSON.stringify({ event: 'reconcile_fills_error', requestId, message }))
          ctx.waitUntil(
            createNotifier(env, { requestId })
              .notify({ type: 'ERROR', message, cause: 'reconcile_fills', severity: 'critical' })
              .catch(() => undefined),
          )
        },
      ),
    )

    ctx.waitUntil(
      runNewsScheduler({ env, requestId })
        .then((summary) => {
          if (!summary.ran) return
          console.log(
            JSON.stringify({
              event: 'news_scheduler_run',
              requestId,
              probeKey: summary.probeKey,
              metric: summary.metric,
              fetched: summary.fetched,
              inserted: summary.inserted,
              skipped: summary.skipped,
            }),
          )
        })
        .catch(() => undefined),
    )

    ctx.waitUntil(
      runExtendedHoursObservation({ env, requestId })
        .then((summary) => {
          if (!summary.ran) return
          console.log(
            JSON.stringify({
              event: 'extended_hours_observation_run',
              requestId,
              symbols: summary.symbols,
              persisted: summary.persisted,
              statuses: summary.statuses,
              errors: summary.errors,
            }),
          )
        })
        .catch(() => undefined),
    )
  },
}
