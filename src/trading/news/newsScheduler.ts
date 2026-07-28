/**
 * News attention producer scheduler (issue #196 follow-up、newsShockGate PR 1)。
 *
 * `quoteScheduler.runQuoteFeed` と同じ「cron から呼ばれる producer」の位置づけ
 * だが、この scheduler は **strategy tick の外**、`CRON_QUOTE_RECONCILE` (5分毎)
 * にぶら下がる。取引経路 (strategy/risk/execution) からは一切参照されない —
 * 外部 I/O ありの producer と、外部 I/O ゼロの gate (将来 PR) を物理的に分離
 * する設計 (plan doc 参照)。
 *
 * probe round-robin: 1 tick = GDELT への HTTP リクエスト 1 回のみ。
 * `NEWS_PROBES` は 2 本 × metric (volume/tone) = 4 組。5 分 cron で 1 組ずつ
 * 進めると各組 20 分ごとの更新になり、GDELT のレート制限 (1req/5s) に対して
 * 十分すぎるマージンがあるので sleep は不要。ローテーション位置はステートレスに
 * 「現在時刻の 5 分スロット番号 mod 組数」で決める (DO も追加テーブルも使わない)。
 *
 * fetch / DB 失敗は **絶対に throw しない** — 呼び出し元の cron (index.ts の
 * `ctx.waitUntil`) に伝播させず、既存 ログ形式 (`console.warn(JSON.stringify(...))`)
 * で握りつぶす。GDELT が落ちても quote feed / reconcile には一切影響しない。
 */
import type { Env } from '../../config/env'
import {
  createAttentionObservationDb,
  createAttentionObservationRepo,
} from '../../infrastructure/db/attentionObservationRepo'
import { GdeltDocClient, type GdeltMetric } from '../../infrastructure/news/GdeltDocClient'
import { NEWS_PROBES } from '../../infrastructure/news/newsProbes'

const NEWS_ATTENTION_SOURCE = 'gdelt'
/** `timespan=1d` は 15 分刻みで ~96 点返す。毎 tick 全点を bulk-insert-ignore する。 */
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
  /** test seam。未指定なら `GDELT_API_BASE` (未設定なら本番URL) で構築する。 */
  client?: GdeltDocClient
}

interface RotationEntry {
  probeKey: string
  query: string
  metric: GdeltMetric
}

/** probe × metric の flat rotation table。呼び出しごとに再構築する (ステートレス)。 */
function buildRotation(): RotationEntry[] {
  const rotation: RotationEntry[] = []
  for (const probe of NEWS_PROBES) {
    for (const metric of probe.metrics) {
      rotation.push({ probeKey: probe.key, query: probe.query, metric })
    }
  }
  return rotation
}

/** 現在時刻の 5 分スロット番号 mod `length` — DO / 追加テーブル無しのステートレス round-robin。 */
function pickRotationIndex(now: Date, length: number): number {
  const slot = Math.floor(now.getTime() / SLOT_MS)
  return ((slot % length) + length) % length
}

export async function runNewsScheduler(options: RunNewsSchedulerOptions): Promise<NewsSchedulerSummary> {
  const { env } = options
  const now = options.now ?? (() => new Date())

  // 未設定 = 無効 (この repo の「未設定は安全側 default、明示 opt-in」規約、
  // QUOTE_SOURCE / BAR_SOURCE と同じ判定パターン)。
  if ((env.NEWS_ATTENTION_ENABLED ?? '').trim().toLowerCase() !== 'true') {
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
    // fetch (GDELT rate limit / timeout / non-JSON body) と DB 失敗の両方を
    // ここで一元的に握りつぶす。cron 呼び出し元 (index.ts) には一切伝播させない。
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
