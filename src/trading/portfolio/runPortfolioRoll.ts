import type { Env } from '../../config/env'
import { PortfolioStateClient } from '../state/PortfolioStateClient'
import type { PortfolioStore } from '../state/PortfolioStore'

/**
 * EOD daily rollover (issue #140)。`PortfolioStateDO.rollDaily()` を一発叩いて
 * `dailyStartEquity += dailyRealizedPnl` / `dailyRealizedPnl = 0` を確定し、
 * `lastRolledAt` を ISO timestamp で更新する。
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
}

export async function runPortfolioRoll(
  env: Env,
  requestId: string,
  deps: RunPortfolioRollDeps = {},
): Promise<void> {
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
