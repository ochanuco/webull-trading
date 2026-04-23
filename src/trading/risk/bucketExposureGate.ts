/**
 * POC のデフォルト bucket exposure 上限 (NAV の 30%)。
 * 将来 `global_config.bucket_exposure_pct` に D1 化する前段の中間実装。
 */
export const DEFAULT_BUCKET_EXPOSURE_PCT = 0.30

export interface BucketGateDecision {
  allowed: boolean
  reason?: string
  /** 承認時の新 bucket 合計 exposure。拒否時は undefined。 */
  newExposure?: number
}

/**
 * 同一 bucket の open position 合計 notional が NAV × X% を超えない範囲で
 * 新規 BUY を許容するかを判定する pure 関数。
 *
 * - bucket が undefined → 個別銘柄として扱い、cap 適用なし (`allowed: true`)
 * - cap が undefined / ≤ 0 → 適用なし (fail-open)
 * - 現 exposure + 追加 notional > cap → 拒否
 *
 * 呼び出し側 (scheduler) は決定後に承認された bucket の `currentExposure`
 * を `newExposure` に置き換えて次の candidate の判定に渡す。
 */
export function decideBucketGate(args: {
  bucket: string | undefined
  currentExposure: number
  addNotional: number
  cap: number | undefined
}): BucketGateDecision {
  if (!args.bucket) return { allowed: true }
  if (args.cap === undefined || !Number.isFinite(args.cap) || args.cap <= 0) {
    return { allowed: true }
  }
  if (!Number.isFinite(args.addNotional) || args.addNotional <= 0) {
    return { allowed: true }
  }
  const projected = args.currentExposure + args.addNotional
  if (projected > args.cap) {
    return {
      allowed: false,
      reason: `bucket cap: ${args.bucket} projected ${projected.toFixed(0)} > ${args.cap.toFixed(0)}`,
    }
  }
  return { allowed: true, newExposure: projected }
}
