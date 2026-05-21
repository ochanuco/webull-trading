import { createApp } from './app'
import type { Env } from './config/env'
import { createDb, insertJournalRecord } from './infrastructure/db/tradeJournalRepo'
import { setTradeJournalDbContext } from './infrastructure/logger/tradeJournal'
import { createNotifier } from './infrastructure/notification/createNotifier'
import { checkMarketDataReachability } from './infrastructure/webull/checkMarketDataReachability'
import { refreshWebullToken } from './infrastructure/webull/refreshWebullToken'
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

      // #21 follow-up: Webull JP 本番 market-data API (`data-api.webull.co.jp`)
      // が今は応答しない (DNS resolve するが TCP 443 沈黙)。launch されたら
      // operator が気付けるよう daily で疎通 check → 応答返ったら notify。
      // 失敗は silent (= 現状の期待値、毎日通知して spam にしない)。
      ctx.waitUntil(
        checkMarketDataReachability().then(
          (result) => {
            if (result.reachable) {
              console.log(
                JSON.stringify({
                  event: 'webull_market_data_reachable',
                  requestId,
                  status: result.status,
                  msTaken: result.msTaken,
                }),
              )
              // info severity の初使用例。実発注に近づく state change じゃないので
              // ERROR type だが severity=info で「青系 icon、運用判断ありき」の扱い。
              ctx.waitUntil(
                createNotifier(env, { requestId })
                  .notify({
                    type: 'ERROR',
                    message: `Webull JP market-data API (data-api.webull.co.jp) is now responding (HTTP ${result.status}, ${result.msTaken}ms). Consider switching strategy cron back from Yahoo to WebullQuoteClient — see PR #334 for the switchover pattern.`,
                    cause: 'webull_market_data_reachable',
                    severity: 'info',
                  })
                  .catch(() => undefined),
              )
            }
            // unreachable: 現状の期待挙動、log すら出さない (cron tick 毎に noise)
          },
          (error) => {
            // 関数自体が throw するのは設計上ないが念のため
            const message = error instanceof Error ? error.message : String(error)
            console.error(
              JSON.stringify({
                event: 'webull_market_data_reachability_check_error',
                requestId,
                message,
              }),
            )
          },
        ),
      )
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
  },
}

