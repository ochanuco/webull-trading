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
import { runHeadlineEvalScheduler } from './trading/news/headlineEvalScheduler'
import { runNewsScheduler } from './trading/news/newsScheduler'
import { runNewsShockDailySummary } from './trading/news/newsShockDailySummary'
import { runPortfolioRoll } from './trading/portfolio/runPortfolioRoll'
import {
  QUOTE_FEED_ALL_KEY,
  reconcileQuoteFeedFailureStreak,
  toQuoteFeedFailureItems,
} from './trading/quotes/quoteFeedFailureStreak'
import { runQuoteFeed } from './trading/quotes/quoteScheduler'
import { reconcileFills } from './trading/reconciliation/reconcileFills'
import { runStrategyCron } from './trading/strategy/runStrategyCron'

const CRON_QUOTE_RECONCILE = '*/5 * * * *'
// Offset from `*/5`'s :00/:05/:10 quote updates so strategy decisions always run against a
// quote that's already landed, instead of racing it at the same minute.
const CRON_STRATEGY = '*/15 * * * *'
// 22:00 UTC ≈ NY 17:00 ET/18:00 EDT: after the US regular session closes, before the JP morning
// session opens — the daily anchor point for PortfolioStateDO.rollDaily()'s drawdown/risk-scale reset.
const CRON_PORTFOLIO_ROLL = '0 22 * * *'

export { SymbolStateDO } from './trading/state/SymbolStateDO'
export { PortfolioStateDO } from './trading/state/PortfolioStateDO'
export { WebullTokenStateDO } from './trading/state/WebullTokenStateDO'

const app = createApp()

// Never cleared on handler exit: background waitUntil tasks from that handler keep logging
// after return and still need this context, so the next invocation just overwrites it in place.
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
      // The token goes INVALID after 15 days of inactivity, so this daily check refreshes it
      // via createToken(existingToken) once expiry is within 7 days — run off-hours to keep
      // this side effect (rate limit usage etc.) away from the trading window.
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
            // A failure needs operator action (reissue the token, then seed it) — push critical
            // now rather than let it sit until the next 24h tick. A skip is routine, no notify.
            if (summary.failureReason) {
              ctx.waitUntil(
                createNotifier(env, { requestId })
                  .notify({
                    type: 'ERROR',
                    message: `Webull token refresh failed: ${summary.failureReason}`,
                    cause: 'webull_token_refresh',
                    severity: 'critical',
                  })
                  .catch(() => undefined),
              )
            }
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(
              JSON.stringify({
                event: 'webull_token_refresh_error',
                requestId,
                message,
              }),
            )
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

      // Canary for a Webull quote/bars regression: warns only when the documented snapshot
      // endpoint stops returning 200. A healthy result is logged, not notified, to avoid spam.
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
            // checkMarketDataHealth is designed to never throw; this branch is a defensive backstop.
            const message = error instanceof Error ? error.message : String(error)
            console.error(
              JSON.stringify({
                event: 'webull_market_data_health_check_error',
                requestId,
                message,
              }),
            )
          },
        ),
      )

      // Upserts only — never a physical delete — so a symbol's disappearance from the sweep is
      // still recoverable/auditable rather than silently dropped from D1.
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
            console.error(
              JSON.stringify({
                event: 'tradable_allowlist_refresh_error',
                requestId,
                message,
              }),
            )
          },
        ),
      )

      // While mode=observe only fires a STATE_CHANGE notify on regime transitions, this daily
      // summary gives a steady stream of current-state data for calibrating the thresholds.
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
                // Mutually exclusive with skipReason: set when the run itself proceeded (exits
                // were evaluated) but new entries specifically were halted.
                entryHaltReason: result.entryHaltReason ?? null,
                summary,
                analysis: result.analysis,
              }),
            )
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(
              JSON.stringify({
                event: 'strategy_cron_error',
                requestId,
                message,
              }),
            )
            // Wrapped in waitUntil so the notify webhook fetch completes before the isolate is
            // torn down — otherwise a cron-ending throw could silently drop the alert.
            ctx.waitUntil(
              createNotifier(env, { requestId })
                .notify({
                  type: 'ERROR',
                  message,
                  cause: 'strategy_cron',
                  severity: 'critical',
                })
                .catch(() => undefined),
            )
          },
        ),
      )
      return
    }

    // default: CRON_QUOTE_RECONCILE — quote feed + fill reconcile run independently below,
    // each creating its own notifier on its own error path.
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
          // A per-category throw inside getSnapshots() only lands in summary.errors — the
          // overall promise still resolves — so without this, a persistent per-symbol failure
          // stays invisible. Notifying every tick instead would page on transient platform
          // blips (e.g. a Durable Object storage reset) that the next 5-minute tick recovers.
          ctx.waitUntil(
            reconcileQuoteFeedFailureStreak({
              db: env.DB,
              notifier: createNotifier(env, { requestId }),
              items: toQuoteFeedFailureItems(summary.errors),
              cause: 'quote_feed_partial',
              requestId,
            }).catch(() => undefined),
          )
        },
        (error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(
            JSON.stringify({
              event: 'quote_feed_error',
              requestId,
              message,
            }),
          )
          // Warning, not critical: distinguishes a full quote_feed throw from a per-symbol skip.
          ctx.waitUntil(
            reconcileQuoteFeedFailureStreak({
              db: env.DB,
              notifier: createNotifier(env, { requestId }),
              items: [{ key: QUOTE_FEED_ALL_KEY, display: message }],
              cause: 'quote_feed',
              requestId,
            }).catch(() => undefined),
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
              abandoned: summary.abandoned,
            }),
          )
          // One notify per summary, not per row — a per-row notify would fire repeatedly across
          // polling ticks. Auto-abandoned rows (sanity-stuck for >=5 attempts) don't land in
          // summary.errors or this notify path; they're visible via the `reconcile_auto_abandon` audit log instead.
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
          console.error(
            JSON.stringify({
              event: 'reconcile_fills_error',
              requestId,
              message,
            }),
          )
          // Critical: a full reconcile throw means split-brain repair between D1 and the DO isn't running at all.
          ctx.waitUntil(
            createNotifier(env, { requestId })
              .notify({
                type: 'ERROR',
                message,
                cause: 'reconcile_fills',
                severity: 'critical',
              })
              .catch(() => undefined),
          )
        },
      ),
    )
    // Wired fully independent of quote/reconcile so a GDELT outage or rate limit can't
    // propagate into the trading path. runNewsScheduler already swallows its own fetch/DB
    // failures internally; the `.catch` here is defense in depth, not the primary guard.
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
    // Same isolation pattern as the news scheduler above: wired independent of
    // quote/reconcile/strategy so a Yahoo outage can't propagate into the trading path.
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
    // Same isolation pattern as the news scheduler above: wired independent of
    // quote/reconcile/strategy so a Google News / Workers AI outage can't
    // propagate into the trading path. Observe-only — read by nothing here.
    ctx.waitUntil(
      runHeadlineEvalScheduler({ env, requestId })
        .then((summary) => {
          if (!summary.ran) return
          console.log(
            JSON.stringify({
              event: 'headline_eval_scheduler_run',
              requestId,
              status: summary.status,
              headlineCount: summary.headlineCount,
              inserted: summary.inserted,
            }),
          )
        })
        .catch(() => undefined),
    )
  },
}
