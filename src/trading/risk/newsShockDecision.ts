/**
 * `attention_observation` (news attention producer, PR 1) から news shock gate
 * の合成 decision を組み立てる層 (news-shock-gate PR 2、`runStrategyCron.ts`
 * から抽出)。D1 read (`attentionObservationRepo`) と複数 probe の merge を
 * 担い、pure な判定ロジック本体 (`evaluateNewsShockGate`) とは分離する。
 *
 * `runStrategyCron.ts` から切り出した理由: 日次サマリ通知 (news-shock-gate
 * follow-up) など、strategy tick 以外からも同じ「D1 read → probe 別評価 →
 * 合成」ロジックを再利用する必要が出たため。
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

/**
 * `attention_observation` (news attention producer, PR 1) が当該 D1 で
 * migrate 済みかを判定する (news-shock-gate PR 2)。`isMacroEventCalendarReady`
 * と同じ理由 — 未 migrate な preview / 新環境では gate を無効化して
 * fail-closed の連鎖 reject / D1 read エラーを回避する。
 */
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

/** severity 判定用の news shock regime ランク (0=normal/unknown, 1=warning, 2=critical)。 */
export const NEWS_SHOCK_REGIME_RANK: Record<NewsShockRegime, number> = {
  unknown: 0,
  normal: 0,
  warning: 1,
  critical: 2,
}

/**
 * ratio > severity の観点で「どちらがより保守的 (BUY を絞る側) か」を選ぶための
 * rank。unknown は fail-open の「データ無し」を表すだけで、それ自体が
 * critical/warning より保守的な意味を持つわけではない — sizeScale が同点
 * (1.0) の時、データに裏付けられた normal を合成結果として優先する
 * (news-shock-gate follow-up: 旧 rank では unknown が normal より上位だったため、
 * 片方の probe が sparse/degenerate で恒常的に unknown になると、もう片方が
 * normal でも合成結果が unknown に固定され続け、regime 変化が一切発生しない
 * = STATE_CHANGE 通知が永久に飛ばないバグの原因だった)。
 *
 * `attentionStalePolicy='block_buy'` の unknown は sizeScale=0 になるため、
 * sizeScale 優先の比較 (`moreConservativeNewsShockDecision` 内の最初の分岐)
 * で先に勝つ — つまりこの rank 変更後も fail-closed 運用時の挙動は変わらない。
 */
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
 * 2 つの probe 決定のうち、より保守的 (BUY を絞る側) な方を選ぶ。GDELT probe
 * は `trump_macro` / `market_selloff` の複数本あり (`newsProbes.ts`)、
 * このリポジトリでは「どちらか一方でも過熱を検知したら BUY を絞る」方針
 * (per-symbol gate の AND-of-rejects と同じ layered defense の考え方) を
 * とる。sizeScale が小さい方を優先し、同点なら regime の severity rank
 * (critical > warning > normal > unknown) で決める。
 */
export function moreConservativeNewsShockDecision(
  a: NewsShockGateDecision,
  b: NewsShockGateDecision,
): NewsShockGateDecision {
  if (a.sizeScale !== b.sizeScale) return a.sizeScale < b.sizeScale ? a : b
  return NEWS_SHOCK_SEVERITY_RANK[a.regime] >= NEWS_SHOCK_SEVERITY_RANK[b.regime] ? a : b
}

/**
 * `attention_observation` (GDELT producer, PR 1) から直近観測を D1 read し、
 * `evaluateNewsShockGate` で regime decision を返す (news-shock-gate PR 2)。
 *
 * **D1 read のみ。fetch は一切呼ばない** — 15分間隔の strategy tick cron に
 * 外部 API 呼び出しを足さないという安全上の絶対条件の core。GDELT への実際の
 * fetch は別 cron (`newsScheduler`, 5分間隔) の producer 側の責務。
 *
 * `NEWS_PROBES` (`trump_macro` / `market_selloff`) を両方評価し、より保守的な
 * 方 (`moreConservativeNewsShockDecision`) を tick の decision として返す
 * (`combined`)。probe 別の decision も `probes` として返す — 日次サマリ通知
 * (news-shock-gate follow-up) が「どの probe がどう判定したか」を1行ずつ
 * 表示するために必要。D1 read が failure した probe は観測なし (= fail-open)
 * として扱う — D1 障害で strategy tick 全体を落とさないため。
 *
 * `evaluateAt`:
 *   - `'now'` (default): strategy tick 用。asOf = now で評価するため、GDELT の
 *     反映遅延 (実測 1〜7 時間) が `maxAgeMin` を超えていると unavailable に
 *     倒れる — リアルタイム判定としてはそれが正しい (古い観測で BUY を絞らない)。
 *   - `'latest_observation'`: 日次サマリ等の表示用。probe ごとに最新 volume
 *     観測の bucket 時刻を asOf にして評価する。「データが届いている範囲では
 *     どう判定されるか」を見るためのもので、staleness check を実質バイパス
 *     するため **取引経路 (strategy tick) では使わないこと**。probe に観測が
 *     1 点も無い場合は now で評価する (= unavailable に倒れる)。
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
  // global_config の生値 (`newsShockBaselineDays` 等) は DB UPDATE の typo で
  // NaN / 非数になり得る。sanitize 前の値で `sinceIso` を計算すると
  // `new Date(NaN).toISOString()` が RangeError を throw し、この関数の
  // 呼び出し元 (strategy tick 全体) まで例外が伝播してしまう (CodeRabbit
  // PR #619 review)。`evaluateNewsShockGate` 内部でも sanitize されるが、
  // それより前に行う `sinceIso` 計算はその保護の外にあるため、ここで
  // sanitize 済みの値を使う (以降 sinceIso 計算・evaluateNewsShockGate への
  // 引き渡しは sane のみを使う。evaluateNewsShockGate 内部で再度 sanitize
  // されるが冪等なので問題ない)。
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
      // 'latest_observation': この probe の最新 volume bucket を評価基準時刻に
      // する。sinceIso (fetch 窓) は now 起点のままなので、遅延分だけ baseline
      // 窓の最古側が数時間欠けるが、7 日窓に対して誤差の範囲。
      const probeAsOf =
        evaluateAt === 'latest_observation' ? (latestBucketAtOrNull(volumeRows, now) ?? asOf) : asOf
      input = {
        volumeObservations: volumeRows.map((r) => ({ bucketAt: r.bucketAt, value: r.value })),
        toneObservations: toneRows.map((r) => ({ bucketAt: r.bucketAt, value: r.value })),
        asOf: probeAsOf,
      }
    } catch (err) {
      // D1 read 失敗は「観測なし」扱い (evaluateNewsShockGate が fail-open で
      // unknown/unavailable に倒す)。cron 本体には伝播させない。
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
  // NEWS_PROBES が空 (あり得ないが defensive) なら unavailable 相当を返す。
  return {
    combined: combined ?? evaluateNewsShockGate({ volumeObservations: [], toneObservations: [], asOf }, config),
    probes,
  }
}

/**
 * now 以前で最新の bucket_at を返す (無ければ null)。未来時刻の row (時計ずれ /
 * 汚染データ) は評価基準時刻に採用しない — `evaluateNewsShockGate` 側の
 * window/baseline フィルタも asOf 以前しか見ないため整合する。
 */
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
