/**
 * Builds a news-shock decision from `attention_observation` rows: D1 read
 * plus per-probe merge, kept separate from the pure decision logic in
 * `evaluateNewsShockGate` so other callers (e.g. daily summary) can reuse it.
 */
import {
  DEFAULT_NEWS_SHOCK_CONFIG,
  evaluateNewsShockGate,
  sanitizeNewsShockConfig,
  type NewsShockGateDecision,
  type NewsShockGateInput,
  type NewsShockRegime,
} from './newsShockGate'
import { createAttentionObservationDb, createAttentionObservationRepo } from '../../infrastructure/db/attentionObservationRepo'
import { NEWS_PROBES } from '../../infrastructure/news/newsProbes'

/** Guards against an unmigrated D1 (preview / new env) — treat as not-ready rather than throwing. */
export async function isNewsShockGateReady(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='attention_observation' LIMIT 1",
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

// unknown ranks below normal (not above): on a sizeScale tie (both 1.0), a
// data-backed normal wins over a stale/degenerate unknown. Otherwise one
// chronically sparse probe pins the combined regime at unknown forever and
// STATE_CHANGE notifications never fire even when the other probe moves.
// A block_buy unknown (sizeScale=0) still wins on the sizeScale comparison
// below, so fail-closed behavior is unaffected by this rank.
const NEWS_SHOCK_SEVERITY_RANK: Record<NewsShockRegime, number> = {
  unknown: 0,
  normal: 1,
  warning: 2,
  critical: 3,
}

export function isNewsShockRegime(value: unknown): value is NewsShockRegime {
  return value === 'unknown' || value === 'normal' || value === 'warning' || value === 'critical'
}

/**
 * Picks the more conservative (smaller sizeScale) of two probe decisions,
 * breaking ties by regime severity. Multiple probes can each independently
 * trip BUY-size scaling; any one of them doing so should win (AND-of-rejects).
 */
export function moreConservativeNewsShockDecision(
  a: NewsShockGateDecision,
  b: NewsShockGateDecision,
): NewsShockGateDecision {
  if (a.sizeScale !== b.sizeScale) return a.sizeScale < b.sizeScale ? a : b
  return NEWS_SHOCK_SEVERITY_RANK[a.regime] >= NEWS_SHOCK_SEVERITY_RANK[b.regime] ? a : b
}

/**
 * D1-reads recent observations for each of `NEWS_PROBES` and evaluates them
 * with `evaluateNewsShockGate`, returning the combined (more conservative)
 * decision plus each probe's own decision for per-probe display.
 *
 * Never calls fetch itself — GDELT ingestion is a separate producer cron.
 * A D1 read failure for a probe is treated as no observation (fail-open)
 * rather than failing the whole strategy tick.
 *
 * `evaluateAt`:
 *   - `'now'` (default): for the strategy tick. GDELT's own ingestion delay
 *     (observed 1-7h) can exceed `maxAgeMin` and fall back to unavailable —
 *     correct for a live trading decision, which shouldn't act on stale data.
 *   - `'latest_observation'`: evaluates each probe as of its own latest
 *     volume bucket, bypassing the staleness check. Display-only (e.g. daily
 *     summary) — do not use on the trading path. Falls back to `'now'` when
 *     a probe has no observations at all.
 */
export async function loadNewsShockDecision(
  db: D1Database,
  global: {
    newsShockWarnRatio: number
    newsShockBlockRatio: number
    newsShockWarnSizeScale: number
    newsShockToneDropThreshold: number
    newsShockRequireTone: boolean
    newsShockBaselineDays: number
    newsShockMinSamples: number
    newsShockWindowMin: number
    newsShockMaxAgeMin: number
    attentionStalePolicy: 'fail_open' | 'block_buy'
  },
  requestId: string | undefined,
  now: Date,
  evaluateAt: 'now' | 'latest_observation' = 'now',
): Promise<{ combined: NewsShockGateDecision; probes: Array<{ probeKey: string; decision: NewsShockGateDecision }> }> {
  const rawConfig = {
    ...DEFAULT_NEWS_SHOCK_CONFIG,
    warnRatio: global.newsShockWarnRatio,
    blockRatio: global.newsShockBlockRatio,
    warnSizeScale: global.newsShockWarnSizeScale,
    toneDropThreshold: global.newsShockToneDropThreshold,
    requireTone: global.newsShockRequireTone,
    baselineDays: global.newsShockBaselineDays,
    minSamples: global.newsShockMinSamples,
    windowMin: global.newsShockWindowMin,
    maxAgeMin: global.newsShockMaxAgeMin,
    attentionStalePolicy: global.attentionStalePolicy,
  }
  // Sanitize before computing sinceIso below: an unsanitized NaN
  // baselineDays (e.g. a bad global_config UPDATE) would make
  // `new Date(NaN).toISOString()` throw here, upstream of the sanitize
  // that evaluateNewsShockGate does internally.
  const config = sanitizeNewsShockConfig(rawConfig)
  const asOf = now.toISOString()
  const sinceIso = new Date(now.getTime() - config.baselineDays * 24 * 60 * 60_000).toISOString()
  const repo = createAttentionObservationRepo(createAttentionObservationDb(db))

  let combined: NewsShockGateDecision | undefined
  const probes: Array<{ probeKey: string; decision: NewsShockGateDecision }> = []
  for (const probe of NEWS_PROBES) {
    let input: NewsShockGateInput
    try {
      const [volumeRows, toneRows] = await Promise.all([
        repo.fetchRecent({ source: 'gdelt', probeKey: probe.key, metric: 'volume', sinceIso }),
        repo.fetchRecent({ source: 'gdelt', probeKey: probe.key, metric: 'tone', sinceIso }),
      ])
      // sinceIso (the fetch window) still anchors on `now`, not `probeAsOf`,
      // so the baseline's oldest edge can be short a few hours' worth of
      // rows — negligible against a 7-day baseline window.
      const probeAsOf =
        evaluateAt === 'latest_observation' ? (latestBucketAtOrNull(volumeRows, now) ?? asOf) : asOf
      input = {
        volumeObservations: volumeRows.map((r) => ({ bucketAt: r.bucketAt, value: r.value })),
        toneObservations: toneRows.map((r) => ({ bucketAt: r.bucketAt, value: r.value })),
        asOf: probeAsOf,
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'news_shock_observation_fetch_failed',
          requestId,
          probeKey: probe.key,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      input = { volumeObservations: [], toneObservations: [], asOf }
    }
    const decision = evaluateNewsShockGate(input, config)
    probes.push({ probeKey: probe.key, decision })
    combined = combined === undefined ? decision : moreConservativeNewsShockDecision(combined, decision)
  }
  return {
    // NEWS_PROBES is never empty in practice; this is just a typed fallback
    // for the loop producing no combined value.
    combined: combined ?? evaluateNewsShockGate({ volumeObservations: [], toneObservations: [], asOf }, config),
    probes,
  }
}

/** Human-readable headline for a `news_shock_regime` STATE_CHANGE notification; undefined falls back to the default "state change: ..." display. */
export function buildNewsShockRegimeHeadline(
  from: NewsShockRegime,
  to: NewsShockRegime,
  decision: NewsShockGateDecision,
  mode: 'observe' | 'enforce',
): string | undefined {
  const ratioText = decision.ratio !== null ? `平時の${decision.ratio.toFixed(1)}倍` : '倍率算出不能'
  if (to === 'critical') {
    const action =
      mode === 'enforce' ? '新規買いを停止します' : '本来は新規買い停止 (observe中: 発注は変更しません)'
    return `ニュース急落シグナル: 報道量が${ratioText}に急増・論調悪化 — ${action}`
  }
  if (to === 'warning') {
    // No separate severity label (e.g. 警戒) — the ⚠️ icon already conveys it.
    const action =
      mode === 'enforce'
        ? `新規買い数量を縮小します (x${decision.sizeScale})`
        : 'observe中のため発注は変更しません'
    return `ニュース報道量が急増 (${ratioText}) — ${action}`
  }
  if (to === 'normal' && (from === 'warning' || from === 'critical')) {
    return `ニュース過熱シグナル解除 — 平常に戻りました (現在${ratioText})`
  }
  // unknown→normal is data recovery, not a market signal — shouldNotify
  // suppresses that transition entirely, so no headline is needed here.
  return undefined
}

/** Latest bucket_at at or before `now`; null if none. Future-dated rows (clock skew / bad data) are ignored to stay consistent with evaluateNewsShockGate's own asOf-bounded filters. */
function latestBucketAtOrNull(rows: Array<{ bucketAt: string }>, now: Date): string | null {
  let latest: string | null = null
  let latestMs = Number.NEGATIVE_INFINITY
  for (const row of rows) {
    const t = Date.parse(row.bucketAt)
    if (!Number.isFinite(t) || t > now.getTime()) continue
    if (t > latestMs) {
      latestMs = t
      latest = row.bucketAt
    }
  }
  return latest
}
