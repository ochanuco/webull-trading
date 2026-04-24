export type SignalAction = 'BUY' | 'SELL' | 'HOLD'

export type GeneratedAtIso = string

export interface DecisionTraceStep {
  label: string
  label_ja?: string
  passed: boolean
  actual?: number | string | boolean | null
  operator?: '<' | '<=' | '>' | '>=' | '==' | '!=' | 'between' | 'exists' | 'not_exists'
  threshold?: number | string | boolean | null | [number, number]
  message?: string
}

export interface Signal {
  action: SignalAction
  symbol: string
  quantity: number
  price: number
  reason: string
  generatedAtIso: GeneratedAtIso
  trace?: DecisionTraceStep[]
}
