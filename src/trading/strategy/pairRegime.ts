import type { DailyBar } from './indicators'

/**
 * ペアレジーム layer (#472)。インバース対 (SOXL/SOXS 等) を両側独立に評価する
 * のではなく、**非レバ原資産 proxy** (SOXX / QQQ 等) の 20 営業日リターンから
 * ペア単位の zone を先に決める:
 *
 *   - bull    : ブル側のみ entry 可
 *   - bear    : ベア側のみ entry 可
 *   - neutral : 両側 entry 不可 (= chop 帯。交互 stop-out の帯を明示的に回避)
 *   - unknown : 判定不能 (データ不足 / stale / misconfig / fetch 失敗) —
 *               fail-closed で両側 entry 不可。**exit は一切妨げない**
 *
 * 設計の要 (issue #472 + operator review):
 *   - score は**完結済み daily bar のみ**から計算 (当日進行中 bar は落とす) →
 *     score は 1 日 1 回しか変化せず、5 分 cron でのフラップを入口で殺す
 *   - 二重閾値の Schmitt trigger + 前 zone 依存 (hysteresis)。順序制約
 *     bearEnter < bearExit < bullExit < bullEnter により bull↔bear の直接遷移
 *     は構造的に不可能 (必ず neutral を経由)
 *   - zone は stateless 決定: 毎評価で score 列の先頭を neutral に seed して
 *     walk → 状態ストア不要・決定論的・decision log から完全再現可能
 *   - 単一スコアは起点 (20 営業日前の価格) 依存がある。初版は overfit 防止の
 *     ため意図的に単純化 — 傾き / MA クロス / ADX 等の追加は out of scope
 */

export type PairRegimeZone = 'bull' | 'bear' | 'neutral' | 'unknown'

export interface PairRegimeThresholds {
  /** neutral → bull (1x proxy の 20d リターン)。default +0.03。 */
  bullEnter: number
  /** bull → neutral。default +0.01。 */
  bullExit: number
  /** neutral → bear。default -0.04。 */
  bearEnter: number
  /** bear → neutral。default -0.015。 */
  bearExit: number
}

export interface PairRegimeDecision {
  zone: PairRegimeZone
  /** 最新 score (= proxy の 20 営業日リターン)。unknown 時は null。 */
  score: number | null
  proxySymbol: string
  /** score 計算に使った最終完結 bar の日付 (YYYY-MM-DD)。unknown 時は null。 */
  asOfDate: string | null
  /** 判定根拠 / unknown の理由 (operator 向け)。 */
  reason: string
}

/** score 1 点の lookback (営業日)。既存 trend filter (#318) と同じ実体 20d。 */
const SCORE_LOOKBACK = 20

/** Schmitt walk に使う score 数の上限 (= bar 約 80 本ぶん)。 */
const WALK_WINDOW = 60

/** 最終完結 bar がこれより古ければ stale → unknown (暦日)。 */
const STALE_CALENDAR_DAYS = 5

const NY_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })

/** thresholds の順序制約。破壊は misconfig → unknown (静かに続行しない)。 */
export function validatePairRegimeThresholds(t: PairRegimeThresholds): boolean {
  return (
    Number.isFinite(t.bearEnter) &&
    Number.isFinite(t.bearExit) &&
    Number.isFinite(t.bullExit) &&
    Number.isFinite(t.bullEnter) &&
    t.bearEnter < t.bearExit &&
    t.bearExit < t.bullExit &&
    t.bullExit < t.bullEnter
  )
}

/**
 * Schmitt trigger 1 step。1 評価につき遷移は最大 1 段 — bull 状態で
 * score が bearEnter を割っても、その評価では neutral 止まり (直接 bull→bear
 * しない)。次の score で bear に入る。
 */
function stepZone(prev: PairRegimeZone, score: number, t: PairRegimeThresholds): PairRegimeZone {
  if (prev === 'bull') {
    return score < t.bullExit ? 'neutral' : 'bull'
  }
  if (prev === 'bear') {
    return score > t.bearExit ? 'neutral' : 'bear'
  }
  // neutral (unknown からは呼ばれない)
  if (score >= t.bullEnter) return 'bull'
  if (score <= t.bearEnter) return 'bear'
  return 'neutral'
}

const unknown = (proxySymbol: string, reason: string): PairRegimeDecision => ({
  zone: 'unknown',
  score: null,
  proxySymbol,
  asOfDate: null,
  reason,
})

export function evaluatePairRegime(
  bars: DailyBar[],
  opts: { proxySymbol: string; thresholds: PairRegimeThresholds; now: Date },
): PairRegimeDecision {
  const { proxySymbol, thresholds, now } = opts
  if (!validatePairRegimeThresholds(thresholds)) {
    return unknown(proxySymbol, 'misconfigured thresholds (order must be bearEnter < bearExit < bullExit < bullEnter)')
  }
  // 完結済み bar のみ: 当日 (US 取引所の暦日) の bar は進行中の可能性があるので
  // 落とす。これで intraday の価格が score に混ざらない (AC 3)。
  const todayNy = NY_DATE_FMT.format(now)
  const completed = bars.filter((b) => b.date < todayNy && Number.isFinite(b.close) && b.close > 0)
  if (completed.length < SCORE_LOOKBACK + 1) {
    return unknown(proxySymbol, `insufficient completed bars (${completed.length} < ${SCORE_LOOKBACK + 1})`)
  }
  const last = completed[completed.length - 1]!
  const lastMs = Date.parse(`${last.date}T00:00:00.000Z`)
  if (!Number.isFinite(lastMs) || now.getTime() - lastMs > STALE_CALENDAR_DAYS * 86_400_000) {
    return unknown(proxySymbol, `stale proxy data (last completed bar ${last.date})`)
  }
  // score 列: S_i = C[i] / C[i-20] - 1。walk は直近 WALK_WINDOW 個。
  const scores: number[] = []
  for (let i = SCORE_LOOKBACK; i < completed.length; i += 1) {
    const base = completed[i - SCORE_LOOKBACK]!.close
    scores.push(completed[i]!.close / base - 1)
  }
  const walk = scores.slice(-WALK_WINDOW)
  let zone: PairRegimeZone = 'neutral' // stateless seed (窓先頭を neutral と仮定)
  for (const s of walk) {
    if (!Number.isFinite(s)) {
      return unknown(proxySymbol, 'non-finite score in walk window')
    }
    zone = stepZone(zone, s, thresholds)
  }
  const latest = walk[walk.length - 1]!
  return {
    zone,
    score: latest,
    proxySymbol,
    asOfDate: last.date,
    reason: `zone=${zone} score=${(latest * 100).toFixed(2)}% (proxy ${proxySymbol}, as of ${last.date})`,
  }
}

/** ペア設定 (inverse_pairs の regime 列、検証済み or invalid 理由付き)。 */
export interface PairRegimeEntry {
  bullSymbol: string
  bearSymbol: string
  proxySymbol: string
  /** repo 検証で見つけた misconfig。non-null なら zone=unknown 扱い (fail-closed)。 */
  invalidConfig: string | null
}

export const PAIR_REGIME_ZONE_LABELS: Record<PairRegimeZone, string> = {
  bull: '強気 (ブル側のみ)',
  bear: '弱気 (ベア側のみ)',
  neutral: '様子見 (両側不可)',
  unknown: '判定不能 (両側不可)',
}
