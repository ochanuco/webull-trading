/**
 * News shock gate (issue #196 follow-up, newsShockGate PR 2)。
 *
 * GDELT の報道量 (`volume`) / 平均トーン (`tone`) の trailing 観測から、
 * 「直近の報道が baseline に対して急増している」局面を検知し BUY size を
 * 縮小 / 停止する **size scaling 系** filter。`vixRegimeFilter.ts` と同じ
 * 型・reason 形式・防御的正規化の構造を踏襲する。
 *
 * scope:
 *   - in: BUY の `intent.quantity` を倍率調整 (1.0 / warnSizeScale / 0.0)
 *   - out: SELL は常に通す (existing position の exit を妨げない)
 *   - out: 観測データの取得 (fetch) はこの module の責務外。呼び出し側
 *     (`runStrategyCron`) が D1 read で観測を集め、この pure function に渡す。
 *     **このファイルは fetch を一切呼ばない** (strategy tick に外部 API 呼び出しを
 *     足さないという安全上の絶対条件の core)。
 *
 * 判定:
 *   ratio = max(直近 windowMin 分の volume) / median(直近 baselineDays 分の
 *   **非ゼロ** volume)
 *   - ratio > blockRatio かつ (tone 条件を満たす、または requireTone=false):
 *     regime='critical', sizeScale=0
 *   - ratio > warnRatio: regime='warning', sizeScale=warnSizeScale
 *     (tone 条件が未充足で critical から降格した場合もこの分岐に落ちる —
 *     「報道量が増えただけ (ポジティブなニュース) で BUY を止めない」ため)
 *   - それ以外: regime='normal', sizeScale=1.0
 *
 * baseline median を非ゼロ値だけで取る理由: `market_selloff` のような sparse
 * probe は平時ニュースが無い時間帯が大半で volume=0 が 8 割超を占める。全点
 * (ゼロ込み) で median を取ると常に 0 になり、ratio が発散 → 旧実装では
 * 「degenerate data」として fail-open (regime='unknown') に倒していたため、
 * この probe は恒常的に unknown のままだった。ratio の意味は「直近 window
 * max が、平時の**非ゼロ報道量**の典型値の何倍か」であり、報道が無い時間帯の
 * ゼロは baseline の代表値計算からは除外するのが正しい (windowMax 側は
 * ゼロを含めたまま — 直近が静かなら ratio=0 で 'normal' になるのは意図通り)。
 *
 * tone AND 条件 (`requireTone=true` の時のみ critical に追加で要求):
 *   baselineTone (baseline 窓の median) − latestTone (直近1点) >= toneDropThreshold
 *
 * fail-open (GDELT producer 障害 / baseline 未成熟):
 *   - 観測が無い / 最新観測が maxAgeMin より古い → regime='unknown',
 *     reason='news_shock_unavailable_fallback_normal'
 *   - baseline サンプル数 (ゼロ込み、データ可用性チェック) が minSamples 未満 →
 *     regime='unknown', reason='news_shock_insufficient_baseline: <count>/<minSamples>'
 *   - baseline サンプルは十分だが非ゼロ値が 1 点も無い (全点ゼロ) → regime='unknown',
 *     reason='news_shock_degenerate_baseline: all-zero'
 *   上記いずれも既定 (`attentionStalePolicy='fail_open'`) では sizeScale=1.0。
 *   operator が `attentionStalePolicy='block_buy'` に倒した場合のみ sizeScale=0
 *   (fail-closed escape hatch — `vixRegimeFilter.ts` の fail-open 判断とは
 *   別に、attention データの可用性だけを明示的に fail-closed へ倒せる)。
 */

export type NewsShockRegime = 'normal' | 'warning' | 'critical' | 'unknown'

/** operator が attention データ不可用時の挙動を明示的に選べる escape hatch。 */
type AttentionStalePolicy = 'fail_open' | 'block_buy'

export interface NewsShockGateConfig {
  /** ratio > これで warning 領域 (size を warnSizeScale 倍に縮小)。default 2.3 (GDELT 12ヶ月実測 p90)。 */
  warnRatio: number
  /** ratio > これ **かつ** tone 条件充足で critical (BUY 全停止)。default 4.4 (同 p99)。 */
  blockRatio: number
  /** warning 領域の size 倍率。default 0.5。0..1 で運用想定。 */
  warnSizeScale: number
  /** critical に要求する tone 低下幅 (baselineTone - latestTone)。default 1.5。 */
  toneDropThreshold: number
  /** true (default) なら critical 判定に tone 低下 AND 条件を要求する。 */
  requireTone: boolean
  /** baseline (median 母集団) の trailing 日数。default 7。 */
  baselineDays: number
  /** baseline サンプル数の下限。未満なら 'unknown' (insufficient_baseline)。default 200。 */
  minSamples: number
  /** ratio 分子側 (直近 max) の窓 (分)。default 120。 */
  windowMin: number
  /** 最新観測がこれより古ければ 'unknown' (unavailable) 扱い。default 90 (分)。 */
  maxAgeMin: number
  /** unknown 判定時の fail-open / fail-closed 切替。default 'fail_open'。 */
  attentionStalePolicy: AttentionStalePolicy
}

export const DEFAULT_NEWS_SHOCK_CONFIG: NewsShockGateConfig = {
  warnRatio: 2.3,
  blockRatio: 4.4,
  warnSizeScale: 0.5,
  toneDropThreshold: 1.5,
  requireTone: true,
  baselineDays: 7,
  minSamples: 200,
  windowMin: 120,
  maxAgeMin: 90,
  attentionStalePolicy: 'fail_open',
}

/** 1 point の報道量観測。`attention_observation` (metric='volume') の row 相当。 */
export interface NewsShockVolumeObservation {
  /** 観測 bucket の ISO UTC。 */
  bucketAt: string
  value: number
}

/** 1 point のトーン観測。`attention_observation` (metric='tone') の row 相当。 */
export interface NewsShockToneObservation {
  bucketAt: string
  value: number
}

export interface NewsShockGateInput {
  /** trailing baselineDays 分をカバーする volume 観測 (順不同で可)。呼び出し側は `fetchRecent` の結果をそのまま渡してよい。 */
  volumeObservations: NewsShockVolumeObservation[]
  /** trailing baselineDays 分をカバーする tone 観測。requireTone=false なら空配列で可。 */
  toneObservations: NewsShockToneObservation[]
  /** 評価基準時刻 (ISO UTC)。呼び出し側の cron tick 時刻。 */
  asOf: string
}

export interface NewsShockGateDecision {
  regime: NewsShockRegime
  /**
   * size を倍率調整。1.0 (normal / unknown fail-open) / warnSizeScale (warning) /
   * 0.0 (critical = block、または unknown かつ attentionStalePolicy='block_buy')。
   */
  sizeScale: number
  /**
   * 通知 / log 用の説明 (英文 canonical、表示層で日本語化)。形式:
   *   - `news_shock_normal: 1.4x`
   *   - `news_shock_warning: 2.8x (size x0.5)`
   *   - `news_shock_critical: 5.1x tone-2.3 (block)`
   *   - `news_shock_unavailable_fallback_normal`
   *   - `news_shock_insufficient_baseline: 84/200`
   *   - `news_shock_degenerate_baseline: all-zero`
   */
  reason: string
  /** 算出された ratio (直近 max / baseline median)。算出不能時は null。 */
  ratio: number | null
  /** baselineTone - latestTone。tone 未算出時は null。 */
  toneDrop: number | null
  /** 評価基準時刻 (input.asOf のエコー)。 */
  asOf: string
}

/**
 * Pure function — attention 観測 + config から regime decision を返す。
 *
 * 呼び出し側で D1 read (`attentionObservationRepo.fetchRecent`) を済ませて
 * 観測配列を渡す。**fetch は呼ばない** — 15分間隔の strategy tick cron に外部 API
 * 呼び出しを足さないという安全上の絶対条件の core。
 *
 * config が壊れている (NaN / 順序逆転 / sizeScale が 0..1 範囲外 / enum 外) 場合は
 * `DEFAULT_NEWS_SHOCK_CONFIG` の対応 field に倒す (`vixRegimeFilter.sanitizeConfig`
 * と同じ layered defense — DB UPDATE typo で gate が暴発しないようにする)。
 */
export function evaluateNewsShockGate(
  input: NewsShockGateInput,
  config: NewsShockGateConfig = DEFAULT_NEWS_SHOCK_CONFIG,
): NewsShockGateDecision {
  const sane = sanitizeNewsShockConfig(config)
  const asOf = input.asOf
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(asOfMs)) {
    // asOf 自体が壊れている呼び出し側バグ。fail-open で unknown に倒す。
    return unavailableDecision(sane, asOf)
  }

  const volumes = filterFinite(input.volumeObservations)
  const tones = filterFinite(input.toneObservations)

  // 1) staleness: 最新観測が maxAgeMin より古い / 観測なし → unavailable。
  const latestBucketMs = maxBucketMs(volumes, asOfMs)
  if (latestBucketMs === null || asOfMs - latestBucketMs > sane.maxAgeMin * 60_000) {
    return unavailableDecision(sane, asOf)
  }

  // 2) baseline サンプル数チェック。
  const baselineSinceMs = asOfMs - sane.baselineDays * 24 * 60 * 60_000
  const baselineValues = volumes
    .filter((o) => {
      const t = Date.parse(o.bucketAt)
      return Number.isFinite(t) && t >= baselineSinceMs && t <= asOfMs
    })
    .map((o) => o.value)
  if (baselineValues.length < sane.minSamples) {
    return insufficientBaselineDecision(sane, asOf, baselineValues.length)
  }
  // 非ゼロ値だけで median を取る (module doc 参照)。sparse probe は平時ゼロが
  // 大半のため、ゼロ込みの median は常に 0 になり ratio が意味を失う。
  const positiveBaselineValues = baselineValues.filter((v) => v > 0)
  const baselineMedian = median(positiveBaselineValues)
  if (!Number.isFinite(baselineMedian)) {
    // 非ゼロ値の median の NaN 化は「正の値が 1 点も無い (全点ゼロ)」場合のみ
    // (median([]) === NaN)。baselineMedian <= 0 は positiveBaselineValues が
    // 全点 > 0 である以上、理論上到達しない — NaN guard のみ残す。
    return degenerateBaselineDecision(sane, asOf)
  }

  // 3) window 側 (直近 windowMin 分) の max。
  const windowSinceMs = asOfMs - sane.windowMin * 60_000
  const windowValues = volumes
    .filter((o) => {
      const t = Date.parse(o.bucketAt)
      return Number.isFinite(t) && t >= windowSinceMs && t <= asOfMs
    })
    .map((o) => o.value)
  if (windowValues.length === 0) {
    // staleness check を通過していれば通常起きないが、maxAgeMin > windowMin の
    // config だと理論上あり得る。defensive に unavailable へ倒す。
    return unavailableDecision(sane, asOf)
  }
  const windowMax = Math.max(...windowValues)
  const ratio = windowMax / baselineMedian

  // 4) tone drop (baseline median tone - 直近1点の tone)。データ不足なら null。
  const toneDrop = computeToneDrop(tones, baselineSinceMs, asOfMs)

  if (ratio > sane.blockRatio) {
    const toneOk = !sane.requireTone || (toneDrop !== null && toneDrop >= sane.toneDropThreshold)
    if (toneOk) {
      return {
        regime: 'critical',
        sizeScale: 0,
        reason: `news_shock_critical: ${ratio.toFixed(1)}x${toneDrop !== null ? ` tone-${toneDrop.toFixed(1)}` : ''} (block)`,
        ratio,
        toneDrop,
        asOf,
      }
    }
    // ratio は block 域だが tone 条件未充足 → 報道量急増のみでは止めず warning 止まり。
    return {
      regime: 'warning',
      sizeScale: sane.warnSizeScale,
      reason: `news_shock_warning: ${ratio.toFixed(1)}x (size x${sane.warnSizeScale})`,
      ratio,
      toneDrop,
      asOf,
    }
  }
  if (ratio > sane.warnRatio) {
    return {
      regime: 'warning',
      sizeScale: sane.warnSizeScale,
      reason: `news_shock_warning: ${ratio.toFixed(1)}x (size x${sane.warnSizeScale})`,
      ratio,
      toneDrop,
      asOf,
    }
  }
  return {
    regime: 'normal',
    sizeScale: 1.0,
    reason: `news_shock_normal: ${ratio.toFixed(1)}x`,
    ratio,
    toneDrop,
    asOf,
  }
}

function unavailableDecision(sane: NewsShockGateConfig, asOf: string): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason: 'news_shock_unavailable_fallback_normal',
    ratio: null,
    toneDrop: null,
    asOf,
  }
}

function insufficientBaselineDecision(
  sane: NewsShockGateConfig,
  asOf: string,
  sampleCount: number,
): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason: `news_shock_insufficient_baseline: ${sampleCount}/${sane.minSamples}`,
    ratio: null,
    toneDrop: null,
    asOf,
  }
}

/**
 * baseline サンプル数は minSamples を満たすが、非ゼロ値が 1 点も無い (全点
 * ゼロ) 場合の fail-open 決定。`insufficientBaselineDecision` と同じ
 * fail-open / fail-closed 挙動 (`attentionStalePolicy` 依存) だが、reason を
 * 分けて「データが少なすぎる」と「データはあるが全部ゼロ」を区別できるようにする。
 */
function degenerateBaselineDecision(sane: NewsShockGateConfig, asOf: string): NewsShockGateDecision {
  return {
    regime: 'unknown',
    sizeScale: sane.attentionStalePolicy === 'block_buy' ? 0 : 1.0,
    reason: 'news_shock_degenerate_baseline: all-zero',
    ratio: null,
    toneDrop: null,
    asOf,
  }
}

function maxBucketMs(
  observations: Array<{ bucketAt: string }>,
  asOfMs: number,
): number | null {
  let max: number | null = null
  for (const o of observations) {
    const t = Date.parse(o.bucketAt)
    if (!Number.isFinite(t) || t > asOfMs) continue
    if (max === null || t > max) max = t
  }
  return max
}

/**
 * baseline 窓内の tone median と、baseline 窓内でもっとも新しい 1 点 (latest) の
 * 差分。どちらかが算出できなければ null (= tone AND 条件は満たされない扱い)。
 */
function computeToneDrop(
  tones: NewsShockToneObservation[],
  baselineSinceMs: number,
  asOfMs: number,
): number | null {
  const inRange = tones
    .map((o) => ({ t: Date.parse(o.bucketAt), value: o.value }))
    .filter((o) => Number.isFinite(o.t) && o.t >= baselineSinceMs && o.t <= asOfMs)
  if (inRange.length === 0) return null
  const baselineTone = median(inRange.map((o) => o.value))
  let latest = inRange[0]!
  for (const o of inRange) {
    if (o.t > latest.t) latest = o
  }
  if (!Number.isFinite(baselineTone)) return null
  return baselineTone - latest.value
}

function filterFinite<T extends { value: number }>(observations: T[]): T[] {
  return observations.filter((o) => Number.isFinite(o.value))
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * config を default に倒して安全圏に正規化する。狙い: DB の UPDATE で入った
 * typo (e.g. warnRatio=NaN, warnSizeScale=2.5) で news shock 経路が暴発しない
 * ようにする (`vixRegimeFilter.sanitizeConfig` と同じ layered defense)。
 *
 * export する理由 (CodeRabbit PR #619 review): 呼び出し側 (`runStrategyCron`
 * の `loadNewsShockDecision`) が `config.baselineDays` の生値を使って
 * `sinceIso` を計算しており、`evaluateNewsShockGate` 内部の sanitize では
 * その計算を保護できなかった (NaN が `new Date(NaN).toISOString()` で
 * `RangeError` を throw する経路)。呼び出し側で先に sanitize した値を使う
 * ことで防ぐ。`evaluateNewsShockGate` は引き続き内部で同じ関数を呼ぶ
 * (二重 sanitize は冪等なので問題ない)。
 */
export function sanitizeNewsShockConfig(config: NewsShockGateConfig): NewsShockGateConfig {
  const warnRatioRaw = isPositiveFinite(config.warnRatio)
    ? config.warnRatio
    : DEFAULT_NEWS_SHOCK_CONFIG.warnRatio
  const blockRatioRaw = isPositiveFinite(config.blockRatio)
    ? config.blockRatio
    : DEFAULT_NEWS_SHOCK_CONFIG.blockRatio
  // warn > block (順序逆転) は defensive に両方 default へ倒す (vix と同じ判断:
  // 中途半端な部分適用より明確な default の方が運用的に分かりやすい)。
  const ordered = warnRatioRaw <= blockRatioRaw
  const warnRatio = ordered ? warnRatioRaw : DEFAULT_NEWS_SHOCK_CONFIG.warnRatio
  const blockRatio = ordered ? blockRatioRaw : DEFAULT_NEWS_SHOCK_CONFIG.blockRatio
  const warnSizeScale = isUnitInterval(config.warnSizeScale)
    ? config.warnSizeScale
    : DEFAULT_NEWS_SHOCK_CONFIG.warnSizeScale
  const toneDropThreshold =
    typeof config.toneDropThreshold === 'number' && Number.isFinite(config.toneDropThreshold) && config.toneDropThreshold >= 0
      ? config.toneDropThreshold
      : DEFAULT_NEWS_SHOCK_CONFIG.toneDropThreshold
  const requireTone = typeof config.requireTone === 'boolean' ? config.requireTone : DEFAULT_NEWS_SHOCK_CONFIG.requireTone
  const baselineDays = isPositiveInt(config.baselineDays)
    ? config.baselineDays
    : DEFAULT_NEWS_SHOCK_CONFIG.baselineDays
  const minSamples = isPositiveInt(config.minSamples)
    ? config.minSamples
    : DEFAULT_NEWS_SHOCK_CONFIG.minSamples
  const windowMin = isPositiveInt(config.windowMin) ? config.windowMin : DEFAULT_NEWS_SHOCK_CONFIG.windowMin
  const maxAgeMin = isPositiveInt(config.maxAgeMin) ? config.maxAgeMin : DEFAULT_NEWS_SHOCK_CONFIG.maxAgeMin
  const attentionStalePolicy: AttentionStalePolicy =
    config.attentionStalePolicy === 'block_buy' || config.attentionStalePolicy === 'fail_open'
      ? config.attentionStalePolicy
      : DEFAULT_NEWS_SHOCK_CONFIG.attentionStalePolicy
  return {
    warnRatio,
    blockRatio,
    warnSizeScale,
    toneDropThreshold,
    requireTone,
    baselineDays,
    minSamples,
    windowMin,
    maxAgeMin,
    attentionStalePolicy,
  }
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
