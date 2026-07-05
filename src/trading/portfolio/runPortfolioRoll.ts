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
import type { WebullAccountBalanceDto } from '../../infrastructure/webull/dto'
import { resolveAccessToken } from '../../infrastructure/webull/resolveAccessToken'
import { createWebullReadClient } from '../../infrastructure/webull/WebullReadClient'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import type { PortfolioStore } from '../state/PortfolioStore'
import { usdEquityFromBalance } from './usdEquityFromBalance'

/**
 * EOD daily rollover (issue #140 / #319)。`PortfolioStateDO.rollDaily()` を一発
 * 叩いて `dailyStartEquity += dailyRealizedPnl` / `dailyRealizedPnl = 0` を確定
 * し、`lastRolledAt` を ISO timestamp で更新する。
 *
 * Calendar-aware skip (issue #319):
 *   - cron は 22:00 UTC 固定で発火するが、その日が NYSE 立会日でない (土日 /
 *     祝日) もしくは翌日が TSE 立会日でない (土日 / 祝日) 場合は roll を skip。
 *   - hard-coded list が当該年をカバーしない場合も fail-closed で skip。
 *   - skip 理由は `event: 'daily_roll_skipped'` の structured log で出す。
 *
 * Silent fallback 設計:
 *   - PORTFOLIO_STATE binding 不在 → log だけ出して return (cron は失敗扱いに
 *     しない)。staging で binding 未配線でも他 cron を巻き込まない。
 *   - DO 例外 → `event: 'portfolio_roll_error'` を console.error し、cron 自体は
 *     成功扱い (Cloudflare の自動 retry を抑止)。次回 22:00 UTC で素直に再試行。
 *
 * `src/index.ts` 側から呼ばれる薄い wrapper。Cloudflare Worker runtime に依存
 * しない (PortfolioStateClient だけが DO namespace 経由で stub を取る) のでテ
 * ストでは fake namespace を渡せる。
 *
 * Broker equity re-seed (dailyStartEquity 自動 re-seed):
 *   - `rollDaily()` は単に `dailyStartEquity += dailyRealizedPnl` するだけの
 *     台帳更新で、入金・為替振替・含み損益を一切反映しない。手動 seed のまま
 *     放置すると実口座資産と乖離し、`computeDrawdownRiskScale` の分母が壊れる
 *     (実績: 円建て値を誤 seed → 分母が実資産の ~47 倍)。
 *   - roll 成功後、`global_config.dryRun` が `false` の時だけ Webull 残高 API
 *     から USD 建て資産 (`usdEquityFromBalance`) を取得し
 *     `store.seedDailyStartEquity()` で上書きする。
 *   - dryRun / config load 失敗 / token 失敗 / broker fetch 失敗 / parse null
 *     はいずれも fail-safe に re-seed を skip し、roll 済みの値をそのまま
 *     維持する (値を捏造しない)。例外は外に投げず structured warn/error ログ
 *     のみ残す — cron 自体は成功扱い。
 *   - 成否に関わらず最後に `recordPortfolioEquitySnapshot` で日次スナップ
 *     ショットを D1 に書く (`/admin/portfolio/roll-daily` の payload / drawdown
 *     計算の流儀を踏襲)。
 */
export interface RunPortfolioRollDeps {
  /** Override for unit tests — defaults to wrapping `env.PORTFOLIO_STATE` in a
   * `PortfolioStateClient`. Pass a hand-rolled stub to avoid the DO namespace. */
  portfolioStoreFactory?: (env: Env) => PortfolioStore
  /** Override for unit tests — `Date.now()` 等価。指定が無ければ `new Date()`。 */
  now?: () => Date
  /** Override for unit tests — defaults to `loadGlobalConfigFrom(env, requestId)`.
   * dryRun フラグだけ見るので戻り値は最小限の shape。 */
  loadGlobalConfig?: (env: Env, requestId: string) => Promise<{ dryRun: boolean }>
  /** Override for unit tests — defaults to `resolveAccessToken(env)`. */
  resolveAccessToken?: (env: Env) => Promise<string | undefined>
  /** Override for unit tests — defaults to
   * `createWebullReadClient(env, { accessToken })`. 必要なのは
   * `getAccountBalance()` だけなので narrow な shape で受ける。 */
  createReadClient?: (
    env: Env,
    opts: { accessToken?: string },
  ) => { getAccountBalance(): Promise<WebullAccountBalanceDto> }
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

  // Issue #319: calendar-aware pre-check。NY 今日 (= cron 発火時の NY 暦日) が
  // NYSE session day で、かつ JP 明日 (= NY close 後 ~JP open までの間) が TSE
  // session day である事を要件とする。どちらかが満たされなければ skip。
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

/**
 * roll 直後の `dailyStartEquity` (=`rolledEquity`) を Webull 残高 API 由来の
 * USD 建て資産で re-seed する。dryRun / config load 失敗 / token・broker 取得
 * 失敗 / parse null はいずれも fail-safe に skip し、roll 済みの値をそのまま
 * 維持する。呼び出し元 (`runPortfolioRoll`) に例外を伝播させない。
 */
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
    const accessToken = deps.resolveAccessToken
      ? await deps.resolveAccessToken(env)
      : await resolveAccessToken(env)
    const readClient = deps.createReadClient
      ? deps.createReadClient(env, { accessToken })
      : createWebullReadClient(env, { accessToken })
    const balance = await readClient.getAccountBalance()
    equity = usdEquityFromBalance(balance)
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

/**
 * `/admin/portfolio/roll-daily` と同じ payload / drawdown 計算の流儀で日次
 * equity スナップショットを D1 に書く。cron 経路はこれまでスナップショットを
 * 書いておらず時系列が欠けていたための追加 (dashboard chart 用)。書込失敗は
 * warn ログのみで握りつぶす (roll 自体は既に成立済み)。
 */
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
 * the next JP business day (= JP local date at cron fire-time, since cron runs
 * 22:00 UTC ≈ NY 17/18:00 same date = JP next-calendar-date 07:00) is not a
 * TSE session day. Otherwise `null` (proceed).
 *
 * Out-of-range (e.g. 2027 before annual refresh) → skip with reason so the
 * operator is forced to refresh the hard-coded tables.
 *
 * Time-of-day assumption: this helper is correct *only* when called close to
 * the cron's 22:00 UTC fire time. At 22:00 UTC, JP local time is already on
 * "tomorrow" relative to NY's calendar date (UTC+9 → 07:00 next day in JP),
 * so `formatJpYmd(now)` already returns the "JP next day" without explicit
 * `+24h` arithmetic. The handler does not enforce the call-time invariant —
 * `src/index.ts` only invokes this from the `CRON_PORTFOLIO_ROLL` branch.
 */
function decideSkipReason(now: Date): SkipReason | null {
  const nyYmd = formatNyYmd(now)
  // JP local date at cron fire-time ≈ NY date + 1 calendar day.
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
