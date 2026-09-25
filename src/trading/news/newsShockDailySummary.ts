/**
 * Daily summary notification for the news-shock gate, ridden on the 22:00
 * UTC portfolio-roll cron. `newsShockGate` in `mode=observe` only notifies
 * on a regime STATE_CHANGE, which isn't enough to calibrate whether the
 * thresholds are sane against real data — this sends the combined regime
 * plus each probe's reason once a day regardless of whether it changed.
 *
 * Same fail-safe stance as its neighboring schedulers: never throws, and
 * runs as its own `ctx.waitUntil` task so a D1/evaluation failure here
 * can't take portfolio roll down with it.
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

    // 'latest_observation' basis, not 'now': GDELT lags ~1-7h, so a
    // now-basis read would show unavailable on almost every 22:00 UTC run.
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

    // Awaited, not fire-and-forget: this function IS the ctx.waitUntil task
    // body, so a dangling promise could let the isolate exit before the
    // webhook fetch completes. Notifier is contracted to always resolve;
    // the catch below is defensive.
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
