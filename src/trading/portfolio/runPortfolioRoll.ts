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
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import type { PortfolioStore } from '../state/PortfolioStore'

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
 */
export interface RunPortfolioRollDeps {
  /** Override for unit tests — defaults to wrapping `env.PORTFOLIO_STATE` in a
   * `PortfolioStateClient`. Pass a hand-rolled stub to avoid the DO namespace. */
  portfolioStoreFactory?: (env: Env) => PortfolioStore
  /** Override for unit tests — `Date.now()` 等価。指定が無ければ `new Date()`。 */
  now?: () => Date
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
