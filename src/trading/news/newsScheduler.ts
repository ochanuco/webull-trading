/**
 * News-attention producer, run every 5 minutes from the quote-reconcile
 * cron — outside the strategy tick, and read by nothing in
 * strategy/risk/execution. Kept as a separate I/O-bearing producer from the
 * (zero-I/O) gate that reads its output, so GDELT never sits on the
 * strategy tick's critical path.
 *
 * One HTTP request per tick: `NEWS_PROBES` rotates statelessly through
 * probe x metric pairs by the current 5-minute time slot, well inside
 * GDELT's rate limit.
 *
 * Never throws — fetch/DB failures are logged and swallowed so a GDELT
 * outage can't affect the quote feed or reconcile.
 */
import type { Env } from '../../config/env'
import {
  createAttentionObservationDb,
  createAttentionObservationRepo,
} from '../../infrastructure/db/attentionObservationRepo'
import { GdeltDocClient, type GdeltMetric } from '../../infrastructure/news/GdeltDocClient'
import { NEWS_PROBES } from '../../infrastructure/news/newsProbes'

const NEWS_ATTENTION_SOURCE = 'gdelt'
/** `timespan=1d` returns ~96 points at 15-minute resolution; every tick bulk-insert-ignores all of them. */
const FETCH_TIMESPAN = '1d'
const SLOT_MS = 5 * 60 * 1000

export interface NewsSchedulerSummary {
  ran: boolean
  source: string
  probeKey?: string
  metric?: GdeltMetric
  fetched: number
  inserted: number
  skipped: number
  reason?: string
}

interface RunNewsSchedulerOptions {
  env: Env
  requestId?: string
  now?: () => Date
  /** Test seam; defaults to a client built from `GDELT_API_BASE` (or the prod URL if unset). */
  client?: GdeltDocClient
}

interface RotationEntry {
  probeKey: string
  query: string
  metric: GdeltMetric
}

/** Flat probe x metric rotation table, rebuilt fresh on every call (stateless). */
function buildRotation(): RotationEntry[] {
  const rotation: RotationEntry[] = []
  for (const probe of NEWS_PROBES) {
    for (const metric of probe.metrics) {
      rotation.push({ probeKey: probe.key, query: probe.query, metric })
    }
  }
  return rotation
}

/** Current 5-minute slot number mod `length` — stateless round-robin, no DO or extra table. */
function pickRotationIndex(now: Date, length: number): number {
  const slot = Math.floor(now.getTime() / SLOT_MS)
  return ((slot % length) + length) % length
}

/** Unset or anything but `'true'` means disabled (opt-in, fail-closed default). */
function isOptInEnabled(flag: string | undefined): boolean {
  return (flag ?? '').trim().toLowerCase() === 'true'
}

export async function runNewsScheduler(options: RunNewsSchedulerOptions): Promise<NewsSchedulerSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())

  if (!isOptInEnabled(env.NEWS_ATTENTION_ENABLED)) {
    return {
      ran: false,
      source: NEWS_ATTENTION_SOURCE,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      reason: 'news_attention_disabled',
    }
  }
  if (!env.DB) {
    return {
      ran: false,
      source: NEWS_ATTENTION_SOURCE,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      reason: 'db_unavailable',
    }
  }

  const rotation = buildRotation()
  if (rotation.length === 0) {
    return {
      ran: false,
      source: NEWS_ATTENTION_SOURCE,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      reason: 'no_probes_configured',
    }
  }

  const nowDate = now()
  const target = rotation[pickRotationIndex(nowDate, rotation.length)]!

  try {
    const client = options.client ?? new GdeltDocClient({ baseUrl: env.GDELT_API_BASE })
    const points = await client.getTimeline(target.query, target.metric, FETCH_TIMESPAN)
    const fetchedAt = nowDate.toISOString()
    const repo = createAttentionObservationRepo(createAttentionObservationDb(env.DB))
    const { inserted, skipped } = await repo.bulkInsertIgnore(
      points.map((p) => ({
        source: NEWS_ATTENTION_SOURCE,
        probeKey: target.probeKey,
        metric: target.metric,
        bucketAt: p.bucketAt,
        value: p.value,
        fetchedAt,
        requestId: options.requestId ?? null,
      })),
    )
    return {
      ran: true,
      source: NEWS_ATTENTION_SOURCE,
      probeKey: target.probeKey,
      metric: target.metric,
      fetched: points.length,
      inserted,
      skipped,
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: 'news_scheduler_error',
        requestId: options.requestId,
        probeKey: target.probeKey,
        metric: target.metric,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    return {
      ran: false,
      source: NEWS_ATTENTION_SOURCE,
      probeKey: target.probeKey,
      metric: target.metric,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      reason: 'error',
    }
  }
}
