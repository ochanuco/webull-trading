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
import type { NewsShockGateDecision, NewsShockRegime } from '../risk/newsShockGate'
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

    // 表示用は 'latest_observation' で評価する。GDELT の反映は実測 1〜7 時間
    // 遅れるため、now 基準 (strategy tick と同じ) だと 22:00 UTC のサマリは
    // ほぼ毎回 unavailable (判定不能) になり校正材料として機能しない。届いて
    // いる最新観測の時点でどう判定されるかを、観測時刻つきで配信する。
    const now = new Date()
    const { combined, probes } = await loadNewsShockDecision(
      env.DB,
      global,
      requestId,
      now,
      'latest_observation',
    )

    const lines = [
      `${regimeIcon(combined.regime)} **ニュース過熱ゲート：${describeRegime(combined.regime)}**`,
      '観測モード / 発注には影響しません',
      '',
      ...probes.flatMap((p, index) => [
        ...(index > 0 ? [''] : []),
        `**${probeLabel(p.probeKey)}**`,
        ...describeDecisionLines(p.decision, now),
      ]),
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

function probeLabel(probeKey: string): string {
  switch (probeKey) {
    case 'trump_macro':
      return 'トランプ関税報道'
    case 'market_selloff':
      return '株式急落報道'
    default:
      return probeKey
  }
}

function describeRegime(regime: NewsShockRegime): string {
  switch (regime) {
    case 'normal':
      return '平常'
    case 'warning':
      return '警戒'
    case 'critical':
      return '過熱'
    case 'unknown':
    default:
      return '判定不能'
  }
}

function regimeIcon(regime: NewsShockRegime): string {
  switch (regime) {
    case 'normal':
      return '✅'
    case 'warning':
      return '⚠️'
    case 'critical':
      return '🔴'
    case 'unknown':
    default:
      return '❔'
  }
}

function describeDecisionLines(decision: NewsShockGateDecision, now: Date): string[] {
  if (decision.ratio !== null) {
    const tonePart =
      decision.regime === 'critical' && decision.toneDrop !== null
        ? ` ｜ 論調悪化 **${decision.toneDrop.toFixed(1)}**`
        : ''
    return [
      `${regimeIcon(decision.regime)} ${describeRegime(decision.regime)} ｜ 平時比 **${decision.ratio.toFixed(1)}倍**${tonePart}`,
      `データ: ${formatDataTime(decision.asOf, now)}`,
    ]
  }

  if (decision.reason.startsWith('news_shock_insufficient_baseline')) {
    const counts = decision.reason.match(/(\d+)\/(\d+)/)
    return [
      `${regimeIcon(decision.regime)} 判定不能 ｜ 比較基準のサンプル不足${counts ? ` (${counts[1]}/${counts[2]}件)` : ''}`,
      `データ: ${formatDataTime(decision.asOf, now)}`,
    ]
  }
  if (decision.reason.startsWith('news_shock_degenerate_baseline')) {
    return [
      `${regimeIcon(decision.regime)} 判定不能 ｜ 過去7日の報道量が全点ゼロ`,
      `データ: ${formatDataTime(decision.asOf, now)}`,
    ]
  }

  return [`${regimeIcon(decision.regime)} 判定不能 ｜ 直近の観測データなし`]
}

function formatDataTime(asOfIso: string, now: Date): string {
  const t = Date.parse(asOfIso)
  if (!Number.isFinite(t)) return '時刻不明'
  const jst = new Date(t + 9 * 60 * 60_000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  const stamp = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${hh}:${mm} JST`
  const lagHours = (now.getTime() - t) / (60 * 60_000)
  const lagPart = lagHours >= 1 ? `（${lagHours.toFixed(1)}時間前）` : ''
  return `${stamp}${lagPart}`
}
