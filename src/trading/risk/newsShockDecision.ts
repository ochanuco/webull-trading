/**
 * Builds a news-shock decision from the latest `news_headline_eval` row: D1
 * read plus the pure evaluation in `evaluateNewsShockGate`, kept separate so
 * other callers (e.g. the daily summary) can reuse the D1 read.
 */
import {
  DEFAULT_NEWS_SHOCK_CONFIG,
  evaluateNewsShockGate,
  sanitizeNewsShockConfig,
  type NewsShockGateDecision,
  type NewsShockRegime,
} from './newsShockGate'
import {
  createNewsHeadlineEvalDb,
  createNewsHeadlineEvalRepo,
} from '../../infrastructure/db/newsHeadlineEvalRepo'

/** Guards against an unmigrated D1 (preview / new env) — treat as not-ready rather than throwing. */
export async function isNewsShockGateReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='news_headline_eval' LIMIT 1",
      )
      .first<{ ok: number }>()
    return row?.ok === 1
  } catch {
    return false
  }
}

/** Severity rank for logging/display (0=normal/unknown, 1=warning, 2=critical). */
export const NEWS_SHOCK_REGIME_RANK: Record<NewsShockRegime, number> = {
  unknown: 0,
  normal: 0,
  warning: 1,
  critical: 2,
}

export function isNewsShockRegime(value: unknown): value is NewsShockRegime {
  return value === 'unknown' || value === 'normal' || value === 'warning' || value === 'critical'
}

/**
 * D1-reads the newest `news_headline_eval` row at/before `now` and evaluates
 * it with `evaluateNewsShockGate`. Never calls fetch itself — collecting
 * headlines is `headlineEvalScheduler`'s job, a separate producer cron.
 * A D1 read failure is treated as no row (fail-open) rather than failing
 * the whole strategy tick.
 */
export async function loadNewsShockDecision(
  db: D1Database,
  global: {
    newsShockWarnSizeScale: number
    attentionStalePolicy: 'fail_open' | 'block_buy'
  },
  requestId: string | undefined,
  now: Date,
): Promise<NewsShockGateDecision> {
  const config = sanitizeNewsShockConfig({
    ...DEFAULT_NEWS_SHOCK_CONFIG,
    warnSizeScale: global.newsShockWarnSizeScale,
    attentionStalePolicy: global.attentionStalePolicy,
  })

  let row
  try {
    const repo = createNewsHeadlineEvalRepo(createNewsHeadlineEvalDb(db))
    row = await repo.fetchLatest({ atOrBeforeIso: now.toISOString() })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'news_shock_observation_fetch_failed',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      }),
    )
    row = null
  }
  return evaluateNewsShockGate({ row, now }, config)
}

/** Human-readable headline for a `news_shock_regime` STATE_CHANGE notification; undefined falls back to the default "state change: ..." display. */
export function buildNewsShockRegimeHeadline(
  from: NewsShockRegime,
  to: NewsShockRegime,
  decision: NewsShockGateDecision,
  mode: 'observe' | 'enforce',
): string | undefined {
  const shockText = decision.shock !== null ? `shock ${decision.shock.toFixed(2)}` : 'shock 算出不能'
  const directionSuffix = decision.direction ? ` (${decision.direction})` : ''
  if (to === 'critical') {
    const action =
      mode === 'enforce' ? '新規買いを停止します' : '本来は新規買い停止 (observe中: 発注は変更しません)'
    return `ニュース急落シグナル: ${shockText}${directionSuffix} で市場悪化を検知 — ${action}`
  }
  if (to === 'warning') {
    // No separate severity label (e.g. 警戒) — the ⚠️ icon already conveys it.
    const action =
      mode === 'enforce'
        ? `新規買い数量を縮小します (x${decision.sizeScale})`
        : 'observe中のため発注は変更しません'
    return `ニュース悪化シグナル (${shockText}${directionSuffix}) — ${action}`
  }
  if (to === 'normal' && (from === 'warning' || from === 'critical')) {
    return `ニュース悪化シグナル解除 — 平常に戻りました (現在${shockText})`
  }
  // unknown→normal is data recovery, not a market signal — shouldNotify
  // suppresses that transition entirely, so no headline is needed here.
  return undefined
}
