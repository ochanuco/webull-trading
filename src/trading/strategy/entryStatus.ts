import { computeEntryDistance, type EntryDistance, type EntryGateStatus } from './entryDistance'
import type { PullbackIndicators, SymbolRule } from './strategies/PullbackUptrendStrategy'

/**
 * 段階判定 (#452 Layer 2b、#449)。7 entry gates の通過状況を BUY/HOLD の二値では
 * なく 4 段階に分類する:
 *
 * | status | 条件                                                        | multiplier |
 * |--------|-------------------------------------------------------------|-----------|
 * | ENTRY  | 全 gate 通過                                                | 1.0       |
 * | HALF   | 未通過が 1 gate のみ、かつ「程度もの」gate (ATR 比 / 押し目深度) で閾値の許容バンド (±20%) 内 | 0.5 |
 * | WATCH  | 未通過が 1–2 gates (HALF 非該当)                            | 0 (監視のみ) |
 * | NG     | それ以外 (3 gates 以上未通過)                               | 0         |
 *
 * **発注対象は ENTRY / HALF のみ**。WATCH は表示専用で、gate を緩める方向の
 * 変更ではない (HALF も閾値近傍の取りこぼし救済であって gate 無効化ではない)。
 * 発注経路への適用は role が entry 有効な銘柄に限る (role NULL = 従来の二値
 * 挙動、#452 受け入れ条件) — その制御は scheduler 側 (`halfEntrySymbols`)。
 */
export type EntryStatus = 'ENTRY' | 'HALF' | 'WATCH' | 'NG'

export interface EntryStatusResult {
  status: EntryStatus
  /** ENTRY=1 / HALF=0.5 / WATCH・NG=0。sizing 量に乗算する。 */
  positionMultiplier: number
  /** 未通過 gate (評価順)。 */
  failedGates: EntryGateStatus[]
  /** HALF 判定の根拠 gate (HALF 以外は null)。 */
  halfGate: EntryGateStatus | null
}

/**
 * 「程度もの」gate (#452)。閾値をわずかに超えているだけなら 0.5x で部分 entry
 * する余地がある連続量の gate。trend / above_sma50 / overextension / high20d は
 * レジーム・構造の条件なので、僅差でも HALF にしない。
 */
const DEGREE_GATE_KEYS: ReadonlySet<string> = new Set([
  'volatility',
  'pullback_shallow',
  'pullback_deep',
])

/** HALF の許容バンド: 閾値の大きさに対する超過率 (0.2 = 閾値×1.2 相当まで)。 */
const HALF_TOLERANCE_RATIO = 0.2

/**
 * 失敗した「程度もの」gate が許容バンド内か。operator の向きに合わせて
 * 「閾値からの超過量が |threshold| の 20% 以内」で判定する:
 *   - '<=' (volatility / pullback_shallow): actual <= threshold + 0.2|threshold|
 *   - '>=' (pullback_deep):                 actual >= threshold - 0.2|threshold|
 * threshold = 0 の縮退 (バンド幅 0) は常に false (= HALF にしない、fail-closed)。
 */
function withinHalfBand(gate: EntryGateStatus): boolean {
  const margin = Math.abs(gate.threshold) * HALF_TOLERANCE_RATIO
  if (!(margin > 0)) return false
  if (gate.operator === '<=') return gate.actual <= gate.threshold + margin
  if (gate.operator === '>=') return gate.actual >= gate.threshold - margin
  return false
}

/** 入場距離 (全 gate 評価済み) から段階判定を導出する。 */
export function deriveEntryStatus(distance: EntryDistance): EntryStatusResult {
  const failedGates = distance.gates.filter((g) => !g.passed)
  if (failedGates.length === 0) {
    return { status: 'ENTRY', positionMultiplier: 1, failedGates, halfGate: null }
  }
  if (failedGates.length === 1) {
    const gate = failedGates[0]!
    if (DEGREE_GATE_KEYS.has(gate.key) && withinHalfBand(gate)) {
      return { status: 'HALF', positionMultiplier: 0.5, failedGates, halfGate: gate }
    }
    return { status: 'WATCH', positionMultiplier: 0, failedGates, halfGate: null }
  }
  if (failedGates.length === 2) {
    return { status: 'WATCH', positionMultiplier: 0, failedGates, halfGate: null }
  }
  return { status: 'NG', positionMultiplier: 0, failedGates, halfGate: null }
}

/** indicators + rule から直接段階判定する便宜関数 (scheduler / dashboard 用)。 */
export function deriveEntryStatusFromIndicators(
  indicators: PullbackIndicators,
  rule: SymbolRule,
): EntryStatusResult {
  return deriveEntryStatus(computeEntryDistance(indicators, rule))
}
