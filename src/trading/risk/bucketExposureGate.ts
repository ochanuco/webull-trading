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
 * - cap が undefined (運用側で bucket 未設定) → 適用なし
 * - cap が非有限 / ≤ 0 (`equity=0` 等の異常) → **fail-closed で reject**
 *   (CodeRabbit #126 review: "Risk must be able to reject")
 * - addNotional 非有限 / ≤ 0 → fail-closed で reject
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
  // cap 未設定は bucket 管理対象外 (symbol に bucket はあるが global に cap
  // が無いケース) として pass。明示的な安全ルート。
  if (args.cap === undefined) {
    return { allowed: true }
  }
  // cap が壊れている (non-finite / ≤0) → 評価不能なので fail-closed で reject。
  if (!Number.isFinite(args.cap) || args.cap <= 0) {
    return {
      allowed: false,
      reason: `bucket cap: ${args.bucket} invalid cap ${args.cap}`,
    }
  }
  if (!Number.isFinite(args.addNotional) || args.addNotional <= 0) {
    return {
      allowed: false,
      reason: `bucket cap: ${args.bucket} invalid addNotional ${args.addNotional}`,
    }
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
