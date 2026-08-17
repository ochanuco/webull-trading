type SignalAction = 'BUY' | 'SELL' | 'HOLD'

type GeneratedAtIso = string

export interface DecisionTraceStep {
  label: string
  label_ja?: string
  passed: boolean
  actual?: number | string | boolean | null
  operator?: '<' | '<=' | '>' | '>=' | '==' | '!=' | 'between' | 'exists' | 'not_exists'
  threshold?: number | string | boolean | null | [number, number]
  message?: string
}

/** HOLD の原因分類 (#658)。'guard' = 行動可否 (position / pendingOrder /
 * cooldown / 再エントリー価格ガード) — HALF 昇格は絶対禁止。'entry_gate' =
 * setup の質を測る entry gate 未達 — HALF 昇格の検討対象。未設定 (undefined)
 * は fail-closed で 'guard' 相当に扱う (昇格しない)。 */
export type HoldCause = 'guard' | 'entry_gate'

/** entry gate 識別子のミラー (#658)。実体は strategy/entryDistance.ts の
 * EntryGateKey。domain → strategy の import は層違反になるためここに複製する
 * (drift したら strategy 側の変更をこちらにも反映すること)。 */
type EntryGateKey =
  | 'trend'
  | 'above_sma50'
  | 'overextension'
  | 'volatility'
  | 'high20d_valid'
  | 'pullback_shallow'
  | 'pullback_deep'

/** entryDistance.ts の EntryGateStatus のミラー (#658)。 */
interface EntryGateStatusSnapshot {
  key: EntryGateKey
  labelJa: string
  passed: boolean
  actual: number
  threshold: number
  operator: string
  priceDependent: boolean
}

/** entryStatus.ts の EntryStatus のミラー (#658)。 */
type EntryStatusLevel = 'ENTRY' | 'HALF' | 'WATCH' | 'NG'

/** entry 4 段階判定のスナップショット (#658)。strategy 側で導出して Signal に
 * 同梱し、scheduler の再導出をなくす。shape は strategy/entryStatus.ts の
 * EntryStatusResult と構造的に一致させる (domain → strategy の import は層違反
 * になるためここに mirror する) — EntryStatusResult の値がそのままこの型に
 * 代入可能であること (drift したら strategy 側の変更をこちらにも反映すること)。 */
export interface EntryStatusSnapshot {
  status: EntryStatusLevel
  /** ENTRY=1 / HALF=0.5 / WATCH・NG=0。sizing 量に乗算する。 */
  positionMultiplier: number
  /** 未通過 gate (評価順)。 */
  failedGates: EntryGateStatusSnapshot[]
  /** HALF 判定の根拠 gate (HALF 以外は null)。 */
  halfGate: EntryGateStatusSnapshot | null
}

export interface Signal {
  action: SignalAction
  symbol: string
  quantity: number
  price: number
  reason: string
  generatedAtIso: GeneratedAtIso
  trace?: DecisionTraceStep[]
  /** HOLD の原因分類 (#658)。HOLD 以外の action では未設定。 */
  holdCause?: HoldCause
  /** holdCause==='entry_gate' の HOLD に同梱される 4 段階判定スナップショット
   * (#658)。scheduler の HALF 昇格判定はこれを再計算せずそのまま使う。 */
  entryStatus?: EntryStatusSnapshot
}
