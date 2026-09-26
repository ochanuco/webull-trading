/**
 * Daily summary notification for the news-shock gate, ridden on the 22:00
 * UTC portfolio-roll cron. `newsShockGate` in `mode=observe` only notifies
 * on a regime STATE_CHANGE, which isn't enough to calibrate whether the
 * shock/direction thresholds are sane against real data — this sends the
 * current regime plus the trailing 24h's row coverage once a day regardless
 * of whether the regime changed.
 *
 * Same fail-safe stance as its neighboring schedulers: never throws, and
 * runs as its own `ctx.waitUntil` task so a D1/evaluation failure here
 * can't take portfolio roll down with it.
 */
import type { Env } from '../../config/env'
import { loadGlobalConfigFrom } from '../../infrastructure/db/globalConfigLoader'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../infrastructure/db/newsHeadlineEvalRepo'
import type { NewsHeadlineEvalRow } from '../../infrastructure/db/schema'
import { createNotifier } from '../../infrastructure/notification/createNotifier'
import type { NewsShockGateDecision, NewsShockRegime } from '../risk/newsShockGate'
import { isNewsShockGateReady, loadNewsShockDecision } from '../risk/newsShockDecision'

const SUMMARY_WINDOW_MS = 24 * 60 * 60_000

export interface DailyRowStats {
  total: number
  okCount: number
  /** Non-'ok' status → count, for every status seen in the window. */
  errorCounts: Record<string, number>
  /** Highest `shock` among 'ok' rows in the window, or null if none. */
  maxShock: { value: number; evaluatedAt: string; direction: string | null } | null
}

/** Pure aggregation, kept separate from the D1 read so it's directly testable. */
export function summarizeRows(rows: NewsHeadlineEvalRow[]): DailyRowStats {
  const stats: DailyRowStats = { total: rows.length, okCount: 0, errorCounts: {}, maxShock: null }
  for (const row of rows) {
    if (row.status !== 'ok') {
      stats.errorCounts[row.status] = (stats.errorCounts[row.status] ?? 0) + 1
      continue
    }
    stats.okCount += 1
    if (row.shock !== null && (stats.maxShock === null || row.shock > stats.maxShock.value)) {
      stats.maxShock = { value: row.shock, evaluatedAt: row.evaluatedAt, direction: row.direction }
    }
  }
  return stats
}

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

    // 'now' basis, same as the strategy tick: unlike GDELT's 1-7h ingestion
    // lag, the headline collector runs every 15 minutes, so a now-basis read
    // reflects the same freshness the trading path itself sees.
    const now = new Date()
    const decision = await loadNewsShockDecision(env.DB, global, requestId, now)

    const sinceIso = new Date(now.getTime() - SUMMARY_WINDOW_MS).toISOString()
    const repo = createNewsHeadlineEvalRepo(createNewsHeadlineEvalDb(env.DB))
    const rows = await repo.fetchSince(sinceIso)
    const stats = summarizeRows(rows)

    const mode = global.newsShockMode === 'enforce' ? 'enforce' : 'observe'
    const message = buildDailySummaryMessage(decision, stats, mode, now)
    const severity = decision.regime === 'critical' ? 'critical' : decision.regime === 'warning' ? 'warning' : 'info'

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

function describeDirection(direction: string | null): string {
  switch (direction) {
    case 'risk_off':
      return 'リスクオフ'
    case 'risk_on':
      return 'リスクオン'
    case 'mixed':
      return '方向感なし'
    case 'not_market_relevant':
      return '市場非関連'
    default:
      return '不明'
  }
}

/** Pure message builder, kept separate from the notify call so it's directly testable. */
export function buildDailySummaryMessage(
  decision: NewsShockGateDecision,
  stats: DailyRowStats,
  mode: 'observe' | 'enforce',
  now: Date,
): string {
  const lines: string[] = [
    `${regimeIcon(decision.regime)} **ニュース過熱ゲート (Jev)：${describeRegime(decision.regime)}**`,
    mode === 'enforce' ? '発注に反映されています' : '観測モード / 発注には影響しません',
    '',
  ]

  if (decision.shock !== null) {
    const timePart = decision.rowEvaluatedAt ? ` ｜ ${formatDataTime(decision.rowEvaluatedAt, now)}` : ''
    lines.push(`現在値: shock **${decision.shock.toFixed(2)}** ｜ ${describeDirection(decision.direction)}${timePart}`)
  } else {
    lines.push(`現在値: 判定不能 (${decision.reason})`)
  }

  lines.push('')
  const errorTotal = Object.values(stats.errorCounts).reduce((a, b) => a + b, 0)
  const errorBreakdown =
    errorTotal > 0
      ? ` (${Object.entries(stats.errorCounts)
          .map(([status, count]) => `${status} ${count}`)
          .join(', ')})`
      : ''
  lines.push(`直近24時間: OK ${stats.okCount}件 / エラー ${errorTotal}件${errorBreakdown}`)

  if (stats.maxShock) {
    lines.push(
      `最大 shock: **${stats.maxShock.value.toFixed(2)}** (${describeDirection(stats.maxShock.direction)}) — ${formatDataTime(stats.maxShock.evaluatedAt, now)}`,
    )
  }

  return lines.join('\n')
}

function formatDataTime(evaluatedAtIso: string, now: Date): string {
  const t = Date.parse(evaluatedAtIso)
  if (!Number.isFinite(t)) return '時刻不明'
  const jst = new Date(t + 9 * 60 * 60_000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  const stamp = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${hh}:${mm} JST`
  const lagHours = (now.getTime() - t) / (60 * 60_000)
  const lagPart = lagHours >= 1 ? `（${lagHours.toFixed(1)}時間前）` : ''
  return `${stamp}${lagPart}`
}
