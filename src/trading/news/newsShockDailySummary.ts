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
      `ニュース過熱ゲート 日次サマリ (観測のみ・発注に影響なし)`,
      `総合判定: ${describeRegime(combined.regime)}`,
      ...probes.map((p) => `- ${probeLabel(p.probeKey)}: ${describeDecision(p.decision, now)}`),
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

/**
 * probe key → 通知に出す日本語ラベル。query の意味 (`newsProbes.ts`) を人が
 * 読める形にしたもの。未知の key (probe 追加時のラベル漏れ) は key をそのまま
 * 出す — 表示が英語に落ちるだけで通知自体は壊さない。
 */
function probeLabel(probeKey: string): string {
  switch (probeKey) {
    case 'trump_macro':
      return 'トランプ関税報道 (trump_macro)'
    case 'market_selloff':
      return '株式急落報道 (market_selloff)'
    default:
      return probeKey
  }
}

function describeRegime(regime: NewsShockRegime): string {
  switch (regime) {
    case 'normal':
      return '平常'
    case 'warning':
      return '警戒 (報道量スパイク)'
    case 'critical':
      return '過熱 (報道量スパイク + 論調悪化)'
    case 'unknown':
    default:
      return '判定不能'
  }
}

/**
 * probe 1 本分の decision を 1 行の日本語にする。ratio が取れている場合は
 * 数値で状況を、unknown 系は canonical reason (`newsShockGate.ts` の形式) を
 * prefix で判別して理由を書く。観測時刻 (decision.asOf = 最新 volume bucket)
 * と now からの遅延も併記する — GDELT の反映遅延で「なぜ今の話ではないのか」
 * が読み手に伝わるようにする。
 */
function describeDecision(decision: NewsShockGateDecision, now: Date): string {
  const dataAt = formatDataTime(decision.asOf, now)
  if (decision.ratio !== null) {
    const ratioPart = `報道量 平時比 ${decision.ratio.toFixed(1)}倍`
    const tonePart =
      decision.regime === 'critical' && decision.toneDrop !== null
        ? `、論調悪化 ${decision.toneDrop.toFixed(1)}`
        : ''
    return `${describeRegime(decision.regime)} — ${ratioPart}${tonePart}${dataAt}`
  }
  // ratio が無い = unknown 系。reason prefix で理由を日本語化する。
  if (decision.reason.startsWith('news_shock_insufficient_baseline')) {
    const counts = decision.reason.match(/(\d+)\/(\d+)/)
    return `判定不能 — 比較基準のサンプル不足${counts ? ` (${counts[1]}/${counts[2]}件)` : ''}${dataAt}`
  }
  if (decision.reason.startsWith('news_shock_degenerate_baseline')) {
    return `判定不能 — 過去7日の報道量が全点ゼロ${dataAt}`
  }
  return `判定不能 — 直近の観測データなし${dataAt}`
}

/**
 * `[8/12 18:15 JST 時点]`、now から 1 時間以上古ければ `・x.x時間前` を併記。
 * epoch は UTC ISO 前提 (`attention_observation.bucket_at`)。parse 不能なら
 * 時刻部分を出さない (表示だけの問題なので throw しない)。
 */
function formatDataTime(asOfIso: string, now: Date): string {
  const t = Date.parse(asOfIso)
  if (!Number.isFinite(t)) return ''
  const jst = new Date(t + 9 * 60 * 60_000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  const stamp = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${hh}:${mm} JST`
  const lagHours = (now.getTime() - t) / (60 * 60_000)
  const lagPart = lagHours >= 1 ? `・${lagHours.toFixed(1)}時間前` : ''
  return ` [${stamp}${lagPart} 時点]`
}
