import type { Env } from '../../config/env'
import {
  isNyseSessionDay,
  isWithinSupportedRange as isNyseWithinSupportedRange,
  formatNyYmd,
} from '../../infrastructure/calendar/usMarketCalendar'
import {
  isTseSessionDay,
  isWithinSupportedRange as isTseWithinSupportedRange,
  formatJpYmd,
} from '../../infrastructure/calendar/jpMarketCalendar'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import {
  recordPortfolioEquitySnapshot,
  type RecordPortfolioEquitySnapshotPayload,
} from '../../infrastructure/db/portfolioEquitySnapshotRepo'
import { fetchUsdEquity } from '../../infrastructure/webull/usdEquityFromBalance'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import type { PortfolioStore } from '../state/PortfolioStore'

/**
 * EOD daily rollover: calls `PortfolioStateDO.rollDaily()` to fold
 * `dailyRealizedPnl` into `dailyStartEquity`, re-seeds `dailyStartEquity`
 * from the broker's actual USD balance, and writes a daily equity snapshot.
 *
 * Cron fires at a fixed 22:00 UTC regardless of calendar, so this skips the
 * roll (structured `daily_roll_skipped` log, not an error) when NY isn't an
 * NYSE session day, JP-tomorrow isn't a TSE session day, or either
 * hard-coded calendar table doesn't cover the date yet.
 *
 * A missing `PORTFOLIO_STATE` binding or a DO exception is logged and
 * swallowed rather than thrown — an uncaught error here would make
 * Cloudflare retry the whole cron, and a plain re-run of `rollDaily()` on
 * partial failure is not idempotent. The next 22:00 UTC tick retries
 * naturally instead.
 *
 * Broker re-seed exists because `rollDaily()` is a pure ledger update —
 * deposits, FX transfers, and unrealized P&L never touch
 * `dailyStartEquity`, so leaving it unseeded drifts from the real account
 * and corrupts `computeDrawdownRiskScale`'s denominator (seen once: a
 * mis-seeded JPY value ~47x the real balance). Re-seed only runs when
 * `dryRun` is false, and any failure (config load, token, broker fetch,
 * null balance) leaves the rolled value untouched rather than guessing.
 */
export interface RunPortfolioRollDeps {
  /** Override for unit tests — defaults to wrapping `env.PORTFOLIO_STATE` in a
   * `PortfolioStateClient`. Pass a hand-rolled stub to avoid the DO namespace. */
  portfolioStoreFactory?: (env: Env) => PortfolioStore
  /** Override for unit tests — defaults to `new Date()`. */
  now?: () => Date
  /** Override for unit tests — defaults to `loadGlobalConfigFrom(env, requestId)`; only `dryRun` is read, so the return shape is minimal. */
  loadGlobalConfig?: (env: Env, requestId: string) => Promise<{ dryRun: boolean }>
  /** Override for unit tests — defaults to `fetchUsdEquity(env)`, which keeps the raw Webull balance DTO inside the infrastructure layer. */
  fetchUsdEquity?: (env: Env) => Promise<number | null>
  /** Override for unit tests — defaults to `recordPortfolioEquitySnapshot`. */
  recordSnapshot?: (
    d1: D1Database,
    payload: RecordPortfolioEquitySnapshotPayload,
  ) => Promise<void>
}

export async function runPortfolioRoll(
  env: Env,
  requestId: string,
  deps: RunPortfolioRollDeps = {},
): Promise<void> {
  const now = deps.now ? deps.now() : new Date()

  const skipReason = decideSkipReason(now)
  if (skipReason) {
    console.warn(
      JSON.stringify({
        event: 'daily_roll_skipped',
        requestId,
        reason: skipReason.reason,
        nyYmd: skipReason.nyYmd,
        jpTomorrowYmd: skipReason.jpTomorrowYmd,
      }),
    )
    return
  }

  let store: PortfolioStore
  if (deps.portfolioStoreFactory) {
    store = deps.portfolioStoreFactory(env)
  } else if (env.PORTFOLIO_STATE) {
    store = new PortfolioStateClient(env.PORTFOLIO_STATE)
  } else {
    console.warn(
      JSON.stringify({
        event: 'portfolio_roll_skipped',
        requestId,
        reason: 'PORTFOLIO_STATE binding not configured',
      }),
    )
    return
  }
  try {
    const { before, after } = await store.rollDaily()
    console.log(
      JSON.stringify({
        event: 'portfolio_roll_run',
        requestId,
        rolledAt: after.updatedAt,
        rolledDelta: before.dailyRealizedPnl,
        before: {
          dailyStartEquity: before.dailyStartEquity,
          dailyRealizedPnl: before.dailyRealizedPnl,
        },
        after: {
          dailyStartEquity: after.dailyStartEquity,
          dailyRealizedPnl: after.dailyRealizedPnl,
          lastRolledAt: after.lastRolledAt,
        },
      }),
    )

    await reseedDailyStartEquityFromBroker(env, requestId, store, after.dailyStartEquity, deps)
    await writeDailyEquitySnapshot(env, requestId, before, after, deps)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'portfolio_roll_error',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/** Re-seeds `dailyStartEquity` from the broker's USD balance. Never throws — every failure mode logs and leaves `rolledEquity` as-is. */
async function reseedDailyStartEquityFromBroker(
  env: Env,
  requestId: string,
  store: PortfolioStore,
  rolledEquity: number,
  deps: RunPortfolioRollDeps,
): Promise<void> {
  let dryRun: boolean
  try {
    const loadConfig = deps.loadGlobalConfig ?? loadGlobalConfigFrom
    const config = await loadConfig(env, requestId)
    dryRun = config.dryRun
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_equity_reseed_skipped',
        requestId,
        reason: 'global_config_load_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return
  }

  if (dryRun) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_equity_reseed_skipped',
        requestId,
        reason: 'dry_run',
      }),
    )
    return
  }

  let equity: number | null
  try {
    const fetchEquity = deps.fetchUsdEquity ?? fetchUsdEquity
    equity = await fetchEquity(env)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'portfolio_equity_reseed_failed',
        requestId,
        reason: 'broker_fetch_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return
  }

  if (equity === null) {
    console.warn(
      JSON.stringify({
        event: 'portfolio_equity_reseed_skipped',
        requestId,
        reason: 'no_usd_equity_in_balance',
      }),
    )
    return
  }

  try {
    await store.seedDailyStartEquity(equity)
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'portfolio_equity_reseed_failed',
        requestId,
        reason: 'seed_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return
  }

  console.log(
    JSON.stringify({
      event: 'portfolio_equity_reseeded',
      requestId,
      rolledEquity,
      brokerEquity: equity,
    }),
  )
}

/** Mirrors `/admin/portfolio/roll-daily`'s payload/drawdown shape so the dashboard chart has a daily time series. A write failure is logged, not thrown — the roll itself already succeeded. */
async function writeDailyEquitySnapshot(
  env: Env,
  requestId: string,
  before: { dailyStartEquity: number; dailyRealizedPnl: number },
  after: { updatedAt: string },
  deps: RunPortfolioRollDeps,
): Promise<void> {
  if (!env.DB) return

  const drawdownPct =
    before.dailyStartEquity > 0 ? before.dailyRealizedPnl / before.dailyStartEquity : null

  try {
    const recordSnapshot = deps.recordSnapshot ?? recordPortfolioEquitySnapshot
    await recordSnapshot(env.DB, {
      snapshotAt: after.updatedAt,
      dailyStartEquityUsd: before.dailyStartEquity,
      dailyStartEquityJpy: null,
      dailyRealizedPnlUsd: before.dailyRealizedPnl,
      dailyRealizedPnlJpy: null,
      drawdownPct,
      requestId,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'portfolio_equity_snapshot_write_failed',
        endpoint: 'cron:runPortfolioRoll',
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

interface SkipReason {
  reason: string
  nyYmd: string
  jpTomorrowYmd: string
}

/**
 * Returns a skip reason if today's NY date is not an NYSE session day, or if
 * the next JP business day is not a TSE session day; `null` otherwise. Also
 * skips (with reason) when a hard-coded calendar table doesn't cover the
 * date, forcing an operator refresh instead of guessing session status.
 *
 * Assumes it's called at the cron's 22:00 UTC fire time: at that instant JP
 * local time (UTC+9) is already on "tomorrow" relative to NY's calendar
 * date, so `formatJpYmd(now)` directly gives the JP next-day without extra
 * `+24h` arithmetic. Not enforced here — only `src/index.ts`'s
 * `CRON_PORTFOLIO_ROLL` branch calls this.
 */
function decideSkipReason(now: Date): SkipReason | null {
  const nyYmd = formatNyYmd(now)
  const jpTomorrowYmd = formatJpYmd(now)

  if (!isNyseWithinSupportedRange(now)) {
    return {
      reason: `NYSE calendar out of supported range for NY date ${nyYmd}; refresh hard-coded closure list`,
      nyYmd,
      jpTomorrowYmd,
    }
  }
  if (!isTseWithinSupportedRange(now)) {
    return {
      reason: `TSE calendar out of supported range for JP date ${jpTomorrowYmd}; refresh hard-coded closure list`,
      nyYmd,
      jpTomorrowYmd,
    }
  }
  if (!isNyseSessionDay(now)) {
    return {
      reason: `NY ${nyYmd} is not an NYSE session day (weekend or holiday)`,
      nyYmd,
      jpTomorrowYmd,
    }
  }
  if (!isTseSessionDay(now)) {
    return {
      reason: `JP ${jpTomorrowYmd} is not a TSE session day (weekend or holiday)`,
      nyYmd,
      jpTomorrowYmd,
    }
  }
  return null
}
