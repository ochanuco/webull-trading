/**
 * news shock gate 日次サマリ通知 (news-shock-gate follow-up)。
 *
 * newsShockGate は `mode=observe` の間 STATE_CHANGE 通知 (regime 遷移時のみ)
 * しか出さない。sparse probe (`market_selloff`) が恒常的に 'unknown' に
 * 張り付いていたバグ (このファイルの姉妹修正 `newsShockGate.ts` /
 * `newsShockDecision.ts` 参照) のせいで、実運用開始から一度も通知が飛んで
 * いなかった。observe モードの校正 (閾値が実データに対して妥当か判断する)
 * には「今どう判定されているか」を regime 変化が無くても定期的に見られる
 * 必要があるため、22:00 UTC の portfolio roll cron に相乗りして 1 日 1 回、
 * 合成 regime + probe 別の reason を配信する。
 *
 * `runPortfolioRoll` / `checkMarketDataHealth` 等の隣接スケジューラと同じ
 * fail-safe 方針: 何が起きても throw しない。D1/評価が失敗しても
 * portfolio roll を巻き込まないよう、呼び出し元 (`index.ts`) から見て
 * 独立した `ctx.waitUntil` として起動する。
 */
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import { createNotifier } from '../../infrastructure/notification/createNotifier'
import { isNewsShockGateReady, loadNewsShockDecision } from '../risk/newsShockDecision'

export async function runNewsShockDailySummary(env: Env, requestId: string): Promise<void> {
  try {
    if (!env.DB) {
      console.log(
        JSON.stringify({
          event: 'news_shock_daily_summary_skipped',
          requestId,
          reason: 'db_unavailable',
        }),
      )
      return
    }

    const global = await loadGlobalConfigFrom(env, requestId)
    if (global.newsShockMode === 'off') {
      console.log(
        JSON.stringify({
          event: 'news_shock_daily_summary_skipped',
          requestId,
          reason: 'mode_off',
        }),
      )
      return
    }

    if (!(await isNewsShockGateReady(env.DB))) {
      console.log(
        JSON.stringify({
          event: 'news_shock_daily_summary_skipped',
          requestId,
          reason: 'table_missing',
        }),
      )
      return
    }

    const { combined, probes } = await loadNewsShockDecision(env.DB, global, requestId, new Date())

    const lines = [
      `news shock gate 日次サマリ (mode=${global.newsShockMode}): 合成 regime=${combined.regime}`,
      ...probes.map((p) => `- ${p.probeKey}: ${p.decision.reason}`),
    ]
    const message = lines.join('\n')
    const severity = combined.regime === 'critical' ? 'critical' : combined.regime === 'warning' ? 'warning' : 'info'

    // await する — この関数自体が `ctx.waitUntil` のタスク本体なので、
    // fire-and-forget にすると notify の webhook fetch 完了前に isolate が
    // 終了しうる (index.ts の他タスクは notify promise を ctx.waitUntil に
    // 渡して同じ問題を回避している)。Notifier は必ず resolve する契約だが
    // 念のため catch も残す。
    await createNotifier(env, { requestId })
      .notify({
        type: 'SUMMARY',
        kind: 'news_shock_daily_summary',
        message,
        severity,
      })
      .catch((err) => {
        console.warn(
          JSON.stringify({
            event: 'news_shock_daily_summary_notify_failed',
            requestId,
            message: err instanceof Error ? err.message : String(err),
          }),
        )
      })
  } catch (err) {
    // D1 / config load / evaluate のいずれで失敗しても、この scheduler は
    // portfolio roll と同じ tick に相乗りしているので、絶対にここから外へ
    // 例外を投げない (呼び出し元は ctx.waitUntil で待つだけで catch しない前提)。
    console.warn(
      JSON.stringify({
        event: 'news_shock_daily_summary_failed',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
