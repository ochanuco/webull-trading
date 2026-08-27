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

// 5 分毎の quote feed + fill reconcile cron.
const CRON_QUOTE_RECONCILE = '*/5 * * * *'
// 15 分毎の Pullback 戦略 cron (position 保有で自然 idempotent)。:00/:05/:10
// の quote 更新後、:15/:30/:45/:00 に判定が走る (quote と strategy の 5 分ズレ
// を維持するため HH:00 ではなく +15 相当の */15 にしている)。
const CRON_STRATEGY = '*/15 * * * *'
// EOD 自動 rollover cron (issue #140)。22:00 UTC ≈ NY 17:00 ET / 18:00 EDT で
// US 通常立会終了後、JP 朝立会前に発火。`PortfolioStateDO.rollDaily()` を呼んで
// `dailyRealizedPnl` を翌日の `dailyStartEquity` に畳み、drawdown kill / risk
// scale が「今日の」基準で動くよう毎日アンカーし直す。
const CRON_PORTFOLIO_ROLL = '0 22 * * *'

export { SymbolStateDO } from './trading/state/SymbolStateDO'
export { PortfolioStateDO } from './trading/state/PortfolioStateDO'
export { WebullTokenStateDO } from './trading/state/WebullTokenStateDO'

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

    if (event.cron === CRON_PORTFOLIO_ROLL) {
      // 22:00 UTC daily: portfolio rollover + Webull access-token refresh.
      // Token は 15 days inactivity で INVALID 化するので、daily check で
      // expires 残り 7 days 以内なら createToken(existingToken) で更新する。
      // 取引時間外に動かす事で broker API への副作用 (rate limit etc) を最小化。
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
            // refresh が失敗したら operator action が必要 (token 再発行 → seed)。
            // critical 通知で push する (cron は 24h 後の next tick まで待つので
            // 早めに気付かせたい)。skip は通常運用なので通知しない。
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

      // #475: Market Data API (trade host + x-version v2 で稼働中、PR #474 実測)
      // の死活監視。旧実装は存在しない host (data-api) の launch を見張っていた
      // が、向きを反転 — documented snapshot endpoint が **200 を返さなくなったら**
      // warn 通知する (quote/bars の Webull 回帰の前提カナリア)。healthy は
      // daily log のみ (spam 防止)。
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
            // 関数自体が throw するのは設計上ないが念のため
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

      // #460: OpenAPI 取扱可能銘柄 allowlist の日次リフレッシュ。
      // tradable/list を全件 sweep し D1 にキャッシュ (物理削除しない upsert)。
      // 取引時間外 (22:00 UTC) に動かして rate limit / 副作用を最小化する。
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

      // news shock gate 日次サマリ (news-shock-gate follow-up)。22:00 UTC =
      // US 市場close後。GDELT producer (newsScheduler) は 24h 稼働しているので
      // この時刻でも観測は新鮮。mode=observe の間は regime 変化時の
      // STATE_CHANGE 通知しか出ないため、閾値校正の材料として現状を毎日配信する。
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
                // #exit-only-halt: run 全体は走っているが新規 entry だけ止めた場合。
                // skipReason とは排他で、こちらが出ている tick は exit 判定済み。
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
            // cron 全体が落ちた時 (D1 失敗 / unexpected throw 等) も通知 (#199 → #141)。
            // severity: critical で push する。waitUntil で wrap して isolate
            // terminate 前に webhook fetch を完了させる。
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

    // default: CRON_QUOTE_RECONCILE (`*/5 * * * *`) — quote feed + fill reconcile.
    // 5 分 cron は quote と reconcile が独立に走るので、片方の error 経路で
    // notifier を 1 回ずつ作る (overhead は無視できる: createNotifier は薄い)。
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
              // #475: QUOTE_SOURCE canary の観測用 — primary source と Yahoo
              // fallback に回った銘柄をログで追えるようにする。
              source: summary.source,
              fallbackSymbols: summary.fallbackSymbols,
            }),
          )
          // Partial failure: getSnapshots() がカテゴリ単位で throw しても全体の
          // promise は resolve するため、summary.errors にだけ積まれて silent に
          // なってた (SOXL が 5 日 stale だったケース)。errors 件数 > 0 のときは
          // /dashboard/alerts に warning として昇格させ、operator が cron 沈黙を
          // 検知できるようにする。global throw の cause='quote_feed' とは区別する
          // ため cause='quote_feed_partial'。
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
          console.error(
            JSON.stringify({
              event: 'quote_feed_error',
              requestId,
              message,
            }),
          )
          // quote feed の global throw は warning (per-symbol skip と区別)。
          // 連続 fail で operator が気付けるよう push 通知 (#141)。
          ctx.waitUntil(
            createNotifier(env, { requestId })
              .notify({
                type: 'ERROR',
                message,
                cause: 'quote_feed',
                severity: 'warning',
              })
              .catch(() => undefined),
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
          // reconcile の per-row error が出ていれば 1 件まとめて通知 (#141)。
          // 1 row 1 通知だと polling tick で連発するので summary 単位で 1 件。
          //
          // Auto-abandoned rows (sanity-stuck for >=5 attempts) は
          // summary.errors に積まれずこの message 経路から抜ける。
          // operator 側は `reconcile_auto_abandon` audit log を別経路で
          // 拾えば良い。
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
          // reconcile 全体 throw は critical (split-brain リスク、#142 系列の
          // 修復が走らない)。
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
    // News attention producer (issue #196 follow-up、newsShockGate PR 1)。
    // quote/reconcile とは完全に独立 — GDELT 障害・レート制限が取引経路に
    // 伝播しないことを物理的に保証する配線 (runNewsScheduler 自体も内部で
    // fetch/DB 失敗を throw せず握りつぶすが、ここでも二重に .catch する)。
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
    // Extended-hours (pre-market) reference observation producer (issue #709
    // Phase 1)。quote/reconcile/strategy とは完全に独立 — Yahoo 障害が取引経路に
    // 伝播しないことを物理的に保証する配線 (runExtendedHoursObservation 自体も
    // 内部で fetch/DB 失敗を throw せず握りつぶすが、ここでも二重に .catch する)。
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
